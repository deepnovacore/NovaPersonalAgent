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
  final vision = ModelConfiguration(
    endpoint: model.endpoint,
    model: 'qwen3-vl-plus',
    key: 'synthetic',
  );
  List<Map<String, dynamic>> visionInputBound(int bound) {
    final empty = <Map<String, dynamic>>[
      {'role': 'user', 'content': ''},
    ];
    final overhead =
        utf8.encode(jsonEncode(modelRequestBody(vision, empty, []))).length +
        4096 +
        128;
    return [
      {'role': 'user', 'content': 'x' * (bound - overhead)},
    ];
  }

  test('VL Plus uses mainland list prices and explicitly disables thinking', () {
    expect(modelRequestBody(vision, messages, [])['enable_thinking'], false);
    // Byte/framing upper bounds, 12K reserved output, twice Beijing list price.
    expect(ProfileBudget.requestCost(vision, visionInputBound(32000)), 304000);
    expect(ProfileBudget.requestCost(vision, visionInputBound(32001)), 456003);
    expect(ProfileBudget.requestCost(vision, visionInputBound(128000)), 744000);
    expect(
      ProfileBudget.requestCost(vision, visionInputBound(128001)),
      1488006,
    );
  });
  test('VL Plus reserves room for output inside its 262144 token context', () {
    expect(
      ProfileBudget.requestCost(vision, visionInputBound(250144)),
      2220864,
    );
    expect(
      () => ProfileBudget.requestCost(vision, visionInputBound(250145)),
      throwsA(isA<AgentFailure>()),
    );
    expect(
      () => ProfileBudget.requestCost(vision, visionInputBound(260097)),
      throwsA(isA<AgentFailure>()),
    );
  });
  test(
    'switching from Flash to VL Plus continues the same five-yuan ledger',
    () async {
      final disk = MemoryLifePersistence();
      final flashCost = ProfileBudget.requestCost(model, messages);
      final visionCost = ProfileBudget.requestCost(vision, messages);
      final original = ProfileBudget(disk, capMicroyuan: 5000000);
      await original.reserve(model, messages);
      final reopened = ProfileBudget(disk, capMicroyuan: 5000000);
      await reopened.reserve(vision, messages);
      expect(reopened.reservedMicroyuan, flashCost + visionCost);
      // Reopening with a different model does not reset or partition the remainder.
      disk.value = jsonEncode({'reserved_microyuan': 5000000 - visionCost});
      await reopened.reserve(vision, messages);
      final full = disk.value;
      await expectLater(
        original.reserve(model, messages),
        throwsA(isA<AgentFailure>()),
      );
      expect(disk.value, full);
      expect(jsonDecode(full!)['reserved_microyuan'], 5000000);
    },
  );
  test(
    'VL Plus rejects international pricing, other aliases and non-text inputs',
    () {
      for (final config in [
        ModelConfiguration(
          endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          model: vision.model,
          key: 'synthetic',
        ),
        ModelConfiguration(
          endpoint: vision.endpoint,
          model: 'qwen3-vl-plus-latest',
          key: 'synthetic',
        ),
      ]) {
        expect(
          () => ProfileBudget.requestCost(config, messages),
          throwsA(isA<AgentFailure>()),
        );
      }
      for (final content in [
        [
          {'type': 'text', 'text': 'synthetic'},
          {
            'type': 'image_url',
            'image_url': {'url': 'https://example.com/image.png'},
          },
        ],
        null,
      ]) {
        expect(
          () => ProfileBudget.requestCost(vision, [
            {'role': 'user', 'content': content},
          ]),
          throwsA(isA<AgentFailure>()),
        );
      }
      expect(
        () => ProfileBudget.requestCost(vision, [
          {'role': 'user', 'content': 'text', 'audio': {}},
        ]),
        throwsA(isA<AgentFailure>()),
      );
      final chinese = [
        {'role': 'user', 'content': '中文原文' * 1000},
      ];
      final ascii = [
        {'role': 'user', 'content': 'abcd' * 1000},
      ];
      expect(
        ProfileBudget.requestCost(vision, chinese),
        greaterThan(ProfileBudget.requestCost(vision, ascii)),
      );
    },
  );
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
      final budget = ProfileBudget(disk, capMicroyuan: 5000000);
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
  CompletedModelUsage receipt({
    String modelName = 'qwen3-vl-plus',
    int input = 1000,
    int output = 100,
  }) => CompletedModelUsage(
    responseId: 'official-response',
    model: modelName,
    promptTokens: input,
    completionTokens: output,
  );
  test(
    'settles only one durable ticket and preserves older spent balance',
    () async {
      final disk = MemoryLifePersistence()
        ..value = '{"reserved_microyuan":1000000}';
      final budget = ProfileBudget(disk);
      final a = await budget.reserve(vision, messages);
      final b = await budget.reserve(vision, messages);
      final full = budget.reservedMicroyuan;
      await budget.settle(a, receipt());
      expect(
        budget.reservedMicroyuan,
        full - ProfileBudget.requestCost(vision, messages) + 4000,
      );
      final after = disk.value;
      await ProfileBudget(disk).settle(a, receipt());
      expect(disk.value, after);
      expect((jsonDecode(after!)['pending_reservations'] as Map).keys, [b.id]);
      // The other interrupted request remains fully charged after reopen.
      await ProfileBudget(disk).settle(b, receipt(output: 200));
      expect(jsonDecode(disk.value!)['reserved_microyuan'], 1010000);
    },
  );
  test(
    'concurrent completion and reservations do not lose costs or refund twice',
    () async {
      final disk = MemoryLifePersistence();
      final a = ProfileBudget(disk), b = ProfileBudget(disk);
      final ticket = await a.reserve(vision, messages);
      await Future.wait([
        a.settle(ticket, receipt()),
        b.settle(ticket, receipt()),
        b.reserve(model, messages),
      ]);
      expect(
        jsonDecode(disk.value!)['reserved_microyuan'],
        4000 + ProfileBudget.requestCost(model, messages),
      );
    },
  );
  test(
    'unusable usage and settlement write failure retain reservation',
    () async {
      final disk = ToggleBudgetDisk();
      final budget = ProfileBudget(disk);
      final ticket = await budget.reserve(vision, messages);
      final before = disk.value;
      for (final invalid in [
        receipt(modelName: 'qwen-flash'),
        receipt(input: 0),
        receipt(input: 900000),
        receipt(output: 12001),
      ]) {
        await expectLater(
          budget.settle(ticket, invalid),
          throwsA(isA<AgentFailure>()),
        );
        expect(disk.value, before);
      }
      disk.failWrites = true;
      await expectLater(
        budget.settle(ticket, receipt()),
        throwsA(isA<AgentFailure>()),
      );
      expect(disk.value, before);
      disk.failWrites = false;
      await budget.settle(ticket, receipt());
      expect(jsonDecode(disk.value!)['reserved_microyuan'], 4000);
    },
  );
  test(
    'corrupt pending ticket accounting fails closed without resetting ledger',
    () async {
      for (final value in [
        {'reserved_microyuan': 100, 'pending_reservations': []},
        {
          'reserved_microyuan': 100,
          'pending_reservations': {
            'id': {'cost': 101, 'model': 'qwen-flash'},
          },
        },
        {
          'reserved_microyuan': 100,
          'pending_reservations': {
            'id': {'cost': -1, 'model': 'qwen-flash'},
          },
        },
      ]) {
        final disk = MemoryLifePersistence()..value = jsonEncode(value);
        final before = disk.value;
        await expectLater(
          ProfileBudget(disk).reserve(model, messages),
          throwsA(isA<AgentFailure>()),
        );
        expect(disk.value, before);
      }
    },
  );
  test(
    'many successful VL batches reuse only verified unused reservations',
    () async {
      final disk = MemoryLifePersistence()
        ..value = '{"reserved_microyuan":1000000}';
      final budget = ProfileBudget(disk);
      for (var i = 0; i < 40; i++) {
        final ticket = await budget.reserve(vision, messages);
        await budget.settle(ticket, receipt());
      }
      expect(budget.reservedMicroyuan, 1160000);
      expect(jsonDecode(disk.value!)['pending_reservations'], isEmpty);
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

class ToggleBudgetDisk extends MemoryLifePersistence {
  bool failWrites = false;
  @override
  Future<void> write(String value) async {
    if (failWrites) throw StateError('storage unavailable');
    await super.write(value);
  }
}
