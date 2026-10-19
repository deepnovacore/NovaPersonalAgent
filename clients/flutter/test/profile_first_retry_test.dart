import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  for (final cause in [
    'profile_output_invalid',
    'model_http_503',
    'profile_budget_exhausted',
    'processing_consent_required',
    'profile_result_more_complete',
    'profile_no_saved_observations',
    'profile_cancelled',
  ]) {
    test(
      'Profile output failure requires explicit retry across restart: $cause',
      () async {
        final disk = MemoryLifePersistence();
        var calls = 0, recoveries = 0;
        var time = DateTime.utc(2026);
        var processed = 5;
        var scope = 'same-scope';
        late ProfileGenerationCoordinator coordinator;
        ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          now: () => time,
          budgetLimitMicroyuan: 200,
          recoverBudgetPause: (state) async {
            recoveries++;
            return {...state}..remove('terminal_code');
          },
          inspect: () async => ProfileGenerationSnapshot(
            scope: scope,
            complete: false,
            hasResult: true,
            covered: 5,
            total: 10,
            pendingOutput: true,
          ),
          generate:
              ({required savedObservationsOnly, required maxNewBatches}) async {
                calls++;
                processed++;
                if (cause == 'profile_cancelled') {
                  coordinator.setForeground(false);
                }
                throw ProfileGenerationTerminalFailure(AgentFailure(cause));
              },
          processedRecords: () => processed,
          cancel: () {},
          failureCode: profileRunErrorCode,
        );
        coordinator = create();
        await coordinator.start();
        await coordinator.poll();
        expect(calls, 1);
        expect(coordinator.code, cause);
        expect(coordinator.phase, ProfileGenerationPhase.blocked);
        expect(jsonDecode(disk.value!)['requires_explicit_retry'], true);
        if (cause == 'profile_budget_exhausted') {
          expect(jsonDecode(disk.value!)['budget_limit_microyuan'], 200);
        }
        coordinator.setForeground(true);
        time = time.add(const Duration(days: 1));
        await coordinator.poll();
        coordinator.dispose();
        coordinator = create();
        await coordinator.start();
        await coordinator.poll();
        expect(calls, 1);
        expect(recoveries, 0);
        expect(coordinator.code, cause);
        scope = 'new-source-scope';
        await coordinator.poll();
        expect(calls, 1);
        expect(coordinator.code, cause);
        await coordinator.retry();
        expect(jsonDecode(disk.value!)['requires_explicit_retry'], isNull);
        await coordinator.poll();
        expect(calls, 2);
        coordinator.dispose();
      },
    );
  }
}
