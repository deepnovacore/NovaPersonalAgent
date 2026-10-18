import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_budget.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  final model = ModelConfiguration(
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    key: 'synthetic',
  );
  final messages = <Map<String, dynamic>>[
    {'role': 'system', 'content': '输出 JSON'},
    {'role': 'user', 'content': '核对原文'},
  ];
  test(
    'reserves before requests, serializes instances and survives reopening',
    () async {
      final disk = MemoryLifePersistence();
      final a = ProfileBudget(disk), b = ProfileBudget(disk);
      final cost = ProfileBudget.requestCost(model, messages);
      await Future.wait([
        a.reserve(model, messages),
        b.reserve(model, messages),
      ]);
      expect(jsonDecode(disk.value!)['reserved_microyuan'], cost * 2);
      final reopened = ProfileBudget(disk);
      await reopened.reserve(model, messages);
      expect(reopened.reservedMicroyuan, cost * 3);
      expect(modelRequestBody(model, messages, [])['enable_thinking'], false);
      expect(
        cost,
        greaterThan(36000),
      ); // Twice the maximum output charge alone.
    },
  );
  test(
    'rejects the request crossing five yuan without changing its ledger',
    () async {
      final disk = MemoryLifePersistence();
      final cost = ProfileBudget.requestCost(model, messages);
      disk.value = jsonEncode({'reserved_microyuan': 5000000 - cost});
      final budget = ProfileBudget(disk);
      await budget.reserve(model, messages);
      final full = disk.value;
      await expectLater(
        budget.reserve(model, messages),
        throwsA(isA<AgentFailure>()),
      );
      expect(disk.value, full);
      expect(budget.reservedMicroyuan, 5000000);
    },
  );
  test(
    'unknown pricing, non-text input and unreadable ledger fail closed',
    () async {
      for (final config in [
        ModelConfiguration(
          endpoint: model.endpoint,
          model: 'qwen-max',
          key: 'synthetic',
        ),
        ModelConfiguration(
          endpoint: 'https://example.com/v1',
          model: model.model,
          key: 'synthetic',
        ),
      ]) {
        expect(
          () => ProfileBudget.requestCost(config, messages),
          throwsA(isA<AgentFailure>()),
        );
      }
      expect(
        () => ProfileBudget.requestCost(model, [
          {'role': 'user', 'content': []},
        ]),
        throwsA(isA<AgentFailure>()),
      );
      for (final raw in ['invalid', '{"reserved_microyuan":-1}', '{}']) {
        final disk = MemoryLifePersistence()..value = raw;
        await expectLater(
          ProfileBudget(disk).reserve(model, messages),
          throwsA(isA<AgentFailure>()),
        );
        expect(disk.value, raw);
      }
      await expectLater(
        ProfileBudget(FailingBudgetDisk()).reserve(model, messages),
        throwsA(isA<AgentFailure>()),
      );
    },
  );
  test('larger inputs reserve their upper pricing tier', () {
    int cost(int length) => ProfileBudget.requestCost(model, [
      {'role': 'user', 'content': 'x' * length},
    ]);
    expect(cost(130000), greaterThan(cost(100000) * 3));
    expect(cost(260000), greaterThan(cost(200000) * 2));
    expect(() => cost(1000000), throwsA(isA<AgentFailure>()));
  });
}

class FailingBudgetDisk extends MemoryLifePersistence {
  @override
  Future<void> write(String value) async =>
      throw StateError('storage unavailable');
}
