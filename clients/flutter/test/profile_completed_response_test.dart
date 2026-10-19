import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/profile_budget.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'exact JSON fences and stage-specific arrays keep schema validation',
    () async {
      expect(
        await decodeCompletedProfileResponse(
          '```json\n{"topics": []}\n```',
          validate: () async {},
        ),
        {'topics': []},
      );
      expect(
        await decodeCompletedProfileResponse(
          '[{"observation_indices":[0]}]',
          validate: () async {},
          collection: 'topics',
        ),
        {
          'topics': [
            {
              'observation_indices': [0],
            },
          ],
        },
      );
      expect(
        await decodeCompletedProfileResponse(
          '["核对执行者"]',
          validate: () async {},
          collection: 'review_notes',
        ),
        {
          'review_notes': ['核对执行者'],
        },
      );
      for (final invalid in [
        '[]',
        '说明\n{"topics":[]}',
        '```json\n{}\n```\n其它内容',
      ]) {
        await expectLater(
          decodeCompletedProfileResponse(invalid, validate: () async {}),
          throwsFormatException,
        );
      }
    },
  );

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
