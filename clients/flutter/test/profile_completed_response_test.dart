import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/profile_budget.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  for (final invalidAuthorization in [false, true]) {
    test(
      'complete trustworthy usage settles before JSON or authority failure: $invalidAuthorization',
      () async {
        final disk = MemoryLifePersistence();
        final budget = ProfileBudget(disk);
        final model = ModelConfiguration(
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3-vl-plus',
          key: 'synthetic',
        );
        final ticket = await budget.reserve(model, [
          {'role': 'user', 'content': 'synthetic input'},
        ]);
        final reserved = budget.reservedMicroyuan;
        await expectLater(
          decodeCompletedProfileResponse(
            'invalid json',
            validate: () async {
              if (invalidAuthorization) {
                throw StateError('authorization_changed');
              }
            },
            settleUsage: () => budget.settle(
              ticket,
              const CompletedModelUsage(
                responseId: 'synthetic-response',
                model: 'qwen3-vl-plus',
                promptTokens: 100,
                completionTokens: 100,
              ),
            ),
          ),
          invalidAuthorization ? throwsStateError : throwsFormatException,
        );
        expect(budget.reservedMicroyuan, lessThan(reserved));
        expect(
          (jsonDecode(disk.value!)['pending_reservations'] as Map),
          isEmpty,
        );
      },
    );
  }
  test('missing usage never changes an existing durable reservation', () async {
    final disk = MemoryLifePersistence();
    final budget = ProfileBudget(disk);
    final model = ModelConfiguration(
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-flash',
      key: 'synthetic',
    );
    await budget.reserve(model, [
      {'role': 'user', 'content': 'test'},
    ]);
    final before = disk.value;
    await expectLater(
      decodeCompletedProfileResponse('bad', validate: () async {}),
      throwsFormatException,
    );
    expect(disk.value, before);
  });
}
