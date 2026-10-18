import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/ui/feishu_direct_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class FixtureModels extends ModelSettings {
  AgentFailure? failure;
  @override
  Future<ModelConfiguration?> read() async {
    if (failure != null) throw failure!;
    return ModelConfiguration(
      endpoint: 'https://model.example/v1',
      model: 'fixture',
      key: 'synthetic',
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'connected page groups actions and collapses processing settings',
    (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
        (_) async => null,
      );
      final auth = FeishuAuth(
        MemoryLifePersistence()
          ..value = jsonEncode({
            'version': 1,
            'generation': 1,
            'app': {
              'brand': 'feishu',
              'app_id': 'fixture',
              'secret': 'synthetic',
            },
            'identity': {'open_id': 'self'},
            'credential': {
              'access_token': 'synthetic',
              'expires_at': DateTime.now()
                  .add(const Duration(days: 1))
                  .millisecondsSinceEpoch,
            },
          }),
        FeishuApi(),
      );
      final host = FeishuHost(
        auth: auth,
        sources: SourceStore(MemoryLifePersistence()),
      );
      await host.open();
      await host.sources.select(
        'fixture-chat',
        DateTime.now().subtract(const Duration(days: 1)),
      );
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final models = FixtureModels();
      await tester.pumpWidget(
        MaterialApp(
          home: FeishuDirectPage(
            host: host,
            models: models,
            authority: authority,
            contextSync: () async => throw StateError('not needed'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(OutlinedButton, '同步消息'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('近况与个人记忆'), 200);
      expect(find.text('近况与个人记忆'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '整理近况与个人记忆'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('整理设置'), 150);
      expect(find.text('允许模型处理'), findsNothing);
      await tester.tap(find.text('整理设置'));
      await tester.pumpAndSettle();
      expect(find.text('允许模型处理'), findsOneWidget);
      await host.sources.grantProcessing(
        'https://model.example/v1|fixture',
        'profile',
        true,
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('撤销模型处理同意'));
      await tester.tap(find.text('撤销模型处理同意'));
      await tester.pumpAndSettle();
      expect(find.text('撤销同意并删除整理结果？'), findsOneWidget);
      await tester.tap(find.text('保留同意'));
      await tester.pumpAndSettle();
      expect(
        () => host.sources.validateProcessing(
          'https://model.example/v1|fixture',
          'profile',
          host.sources.processingRevision,
        ),
        returnsNormally,
      );

      models.failure = const AgentFailure('source_expired');
      await tester.ensureVisible(find.text('整理近况与个人记忆'));
      await tester.tap(find.text('整理近况与个人记忆'));
      await tester.pumpAndSettle();
      expect(find.text('部分消息已超出最近 30 天，本次整理已停止。请重新整理当前范围。'), findsOneWidget);
      expect(find.textContaining('source_expired'), findsNothing);
      models.failure = null;
      final observed = DateTime.now().subtract(const Duration(hours: 1));
      await host.sources.ingestPage(
        host.sources.fence('fixture-chat'),
        [
          {
            'message_id': 'synthetic-result',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${observed.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {'content': '{"text":"本周整理阅读笔记"}'},
          },
        ],
        nextPage: null,
        windowEnd: DateTime.now(),
      );
      await host.sources.grantProcessing(
        'https://model.example/v1|fixture',
        'profile',
        true,
      );
      final dynamic pageState = tester.state(find.byType(FeishuDirectPage));
      final ProfileAgent agent = pageState.profile;
      final evidence = host.sources
          .messages('fixture-chat')
          .single['evidence_id'];
      await agent.repository.publish(
        jsonEncode([
          {
            'key': 'about',
            'kind': 'profile',
            'text': '示例个人记忆',
            'evidence_ids': [evidence],
          },
          {
            'key': 'reading',
            'kind': 'timeline',
            'text': '示例阅读近况',
            'observed_at': observed.toIso8601String(),
            'evidence_ids': [evidence],
          },
        ]),
        epoch: authority.epoch,
        sourceRevision: host.sources.revision,
        consentRevision: host.sources.processingRevision,
        provider: 'https://model.example/v1|fixture',
      );
      agent.onProgress!();
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, '查看整理结果'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '重新整理'), findsOneWidget);
      expect(find.text('示例个人记忆'), findsNothing);
      await tester.ensureVisible(find.text('查看整理结果'));
      await tester.tap(find.text('查看整理结果'));
      await tester.pumpAndSettle();
      expect(find.text('示例个人记忆'), findsOneWidget);
      expect(find.text('补充或纠正个人信息'), findsOneWidget);

      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      authority.dispose();
    },
  );
  testWidgets(
    'official web binding is primary and secret inputs are collapsed',
    (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
        (_) async => null,
      );
      final host = FeishuHost(
        auth: FeishuAuth(MemoryLifePersistence(), FeishuApi()),
        sources: SourceStore(MemoryLifePersistence()),
      );
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      await tester.pumpWidget(
        MaterialApp(
          home: FeishuDirectPage(
            host: host,
            models: ModelSettings(),
            authority: authority,
            contextSync: () async => throw StateError('not needed'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('前往飞书网页绑定'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      authority.dispose();
    },
  );
}
