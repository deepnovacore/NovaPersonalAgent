import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_budget.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const oldCap = 5000000, newCap = 10000000;
  Map<String, dynamic> exhausted([String key = 'error_code']) => {
    key: 'profile_budget_exhausted',
  };
  MemoryLifePersistence ledger([int used = 4818276]) =>
      MemoryLifePersistence()
        ..value = jsonEncode({
          'reserved_microyuan': used,
          'pending_reservations': {
            'existing': {'cost': 100000, 'model': 'qwen3-vl-plus'},
          },
        });
  Future<Map<String, dynamic>?> recover(
    ProfileBudget budget,
    Map<String, dynamic> state, {
    String key = 'error_code',
  }) => budget.recoverExhaustedPause(
    state,
    budgetId: 'acceptance-fixture',
    upgradeId: 'approved-additional-five-v1',
    previousCapMicroyuan: oldCap,
    errorKey: key,
  );

  test(
    'build-configured cap gates new reservations on the unchanged old ledger',
    () async {
      final disk = ledger(4999999), budget = ProfileBudget(ledger(4999999));
      final actual = ProfileBudget(disk);
      final model = ModelConfiguration(
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-flash',
        key: 'synthetic',
      );
      final messages = <Map<String, dynamic>>[
        {'role': 'user', 'content': 'synthetic'},
      ];
      final cost = ProfileBudget.requestCost(model, messages);
      final before = disk.value;
      if (budget.capMicroyuan == oldCap) {
        await expectLater(
          actual.reserve(model, messages),
          throwsA(
            isA<AgentFailure>().having(
              (e) => e.code,
              'code',
              'profile_budget_exhausted',
            ),
          ),
        );
        expect(disk.value, before);
      } else {
        expect(budget.capMicroyuan, newCap);
        await actual.reserve(model, messages);
        final after = jsonDecode(disk.value!);
        expect(after['reserved_microyuan'], 4999999 + cost);
        expect(
          after['pending_reservations']['existing'],
          jsonDecode(before!)['pending_reservations']['existing'],
        );
      }
    },
  );
  test(
    'explicit upgrade resumes legacy and stamped pauses without changing ledger',
    () async {
      final disk = ledger(),
          budget = ProfileBudget(ledger(), capMicroyuan: newCap);
      final actual = ProfileBudget(disk, capMicroyuan: newCap);
      final before = disk.value;
      for (final state in [
        exhausted(),
        {...exhausted(), 'budget_limit_microyuan': oldCap},
      ]) {
        final resumed = (await recover(actual, state))!;
        expect(resumed['error_code'], isNull);
        expect(resumed['budget_limit_microyuan'], newCap);
        expect(
          resumed['budget_resume_approval'],
          'approved-additional-five-v1',
        );
        expect(actual.reservedMicroyuan, 4818276);
        expect(disk.value, before);
        expect(await recover(budget, {...resumed, ...exhausted()}), isNull);
      }
    },
  );
  test(
    'approval, old cap, identity, ledger headroom and error class all fence recovery',
    () async {
      final budget = ProfileBudget(ledger(), capMicroyuan: newCap);
      for (final state in [
        {...exhausted(), 'manual_pause': true},
        {...exhausted(), 'budget_limit_microyuan': newCap},
        {...exhausted(), 'budget_limit_microyuan': 4000000},
        {...exhausted(), 'budget_id': 'different-ledger'},
        {'error_code': 'profile_budget_usage_invalid'},
        {'error_code': 'profile_budget_usage_exceeds_reservation'},
        {'error_code': 'profile_budget_unavailable'},
        {'error_code': 'profile_interrupted'},
      ]) {
        expect(await recover(budget, state), isNull);
      }
      expect(
        await recover(
          ProfileBudget(ledger(), capMicroyuan: oldCap),
          exhausted(),
        ),
        isNull,
      );
      expect(
        await recover(
          ProfileBudget(ledger(newCap), capMicroyuan: newCap),
          exhausted(),
        ),
        isNull,
      );
      expect(
        await budget.recoverExhaustedPause(
          exhausted(),
          budgetId: 'acceptance-fixture',
          upgradeId: '',
          previousCapMicroyuan: oldCap,
        ),
        isNull,
      );
    },
  );
  test(
    'missing or invalid old ledger never becomes a fresh zero-spend upgrade',
    () async {
      for (final raw in [
        null,
        'invalid',
        '{"reserved_microyuan":-1}',
        '{"reserved_microyuan":0,"pending_reservations":{"old":{"cost":1,"model":"qwen-flash"}}}',
      ]) {
        final disk = MemoryLifePersistence()..value = raw;
        await expectLater(
          recover(ProfileBudget(disk, capMicroyuan: newCap), exhausted()),
          throwsA(
            isA<AgentFailure>().having(
              (e) => e.code,
              'code',
              'profile_budget_unavailable',
            ),
          ),
        );
        expect(disk.value, raw);
      }
    },
  );

  for (final receiptFirst in [true, false]) {
    test('partial writes recover safely: receiptFirst=$receiptFirst', () async {
      final budgetDisk = ledger(),
          receipt = MemoryLifePersistence()..value = jsonEncode(exhausted());
      final state = MemoryLifePersistence()
        ..value = jsonEncode({'version': 1, ...exhausted('terminal_code')});
      final budget = ProfileBudget(budgetDisk, capMicroyuan: newCap);
      final originalLedger = budgetDisk.value;
      var calls = 0;
      Future<void> recoverReceipt() async {
        final current = jsonDecode(receipt.value!) as Map<String, dynamic>;
        final resumed = await recover(budget, current);
        if (resumed != null) await receipt.write(jsonEncode(resumed));
      }

      ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
        persistence: state,
        autoSchedule: false,
        budgetLimitMicroyuan: newCap,
        recoverBudgetPause: (s) => recover(budget, s, key: 'terminal_code'),
        inspect: () async {
          await recoverReceipt();
          return const ProfileGenerationSnapshot(
            scope: 's',
            complete: false,
            hasResult: false,
            covered: 0,
            total: 5,
          );
        },
        generate: ({required savedObservationsOnly, required maxNewBatches}) async {
          expect(savedObservationsOnly, true);
          expect(maxNewBatches, 0);
          calls++;
          // All real receipt writers stamp the current limit even after replacing
          // previous diagnostics. This is a second failure under the new cap.
          await receipt.write(
            jsonEncode({...exhausted(), 'budget_limit_microyuan': newCap}),
          );
          throw const AgentFailure('profile_budget_exhausted');
        },
        cancel: () {},
        failureCode: (e) => e is AgentFailure ? e.code : 'storage_failed',
      );
      if (receiptFirst) {
        await recoverReceipt();
        state.fail = true;
      } else {
        receipt.fail = true;
      }
      var c = create();
      await c.start();
      await c.poll();
      expect(calls, 0);
      c.dispose();
      state.fail = false;
      receipt.fail = false;
      c = create();
      await c.start();
      await c.poll();
      expect(calls, 1);
      expect(c.phase, ProfileGenerationPhase.blocked);
      expect(jsonDecode(state.value!)['budget_limit_microyuan'], newCap);
      c.dispose();
      c = create();
      await c.start();
      await c.poll();
      await c.poll();
      expect(calls, 1);
      expect(await recover(budget, jsonDecode(receipt.value!)), isNull);
      expect(budgetDisk.value, originalLedger);
      c.dispose();
    });
  }
  test(
    'upgrade does not clear coordinator manual pause or unrelated terminal',
    () async {
      for (final initial in [
        {...exhausted('terminal_code'), 'manual_pause': true},
        {'terminal_code': 'profile_budget_usage_invalid'},
        {'terminal_code': 'profile_interrupted'},
      ]) {
        var recoverCalls = 0;
        final disk = MemoryLifePersistence()
          ..value = jsonEncode({'version': 1, ...initial});
        final c = ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          recoverBudgetPause: (s) async {
            recoverCalls++;
            return null;
          },
          inspect: () async => const ProfileGenerationSnapshot(
            scope: 's',
            complete: false,
            hasResult: false,
            covered: 0,
            total: 5,
          ),
          generate:
              ({
                required savedObservationsOnly,
                required maxNewBatches,
              }) async => fail('paid generation'),
          cancel: () {},
          failureCode: (e) => '$e',
        );
        await c.start();
        // Generic terminal scope handling is existing behavior; upgrade startup
        // must leave the state untouched regardless of its reason.
        expect(recoverCalls, 0);
        expect(jsonDecode(disk.value!), {'version': 1, ...initial});
        c.dispose();
      }
    },
  );
}
