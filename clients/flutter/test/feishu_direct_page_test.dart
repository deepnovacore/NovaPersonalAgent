import 'dart:async';
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
  Completer<ModelConfiguration?>? pendingRead;
  @override
  Future<ModelConfiguration?> read() async {
    if (pendingRead != null) return pendingRead!.future;
    if (failure != null) throw failure!;
    return ModelConfiguration(
      endpoint: 'https://model.example/v1',
      model: 'fixture',
      key: 'synthetic',
    );
  }
}

void main() {
  test('resumed progress distinguishes verified messages and reused work', () {
    expect(
      profileProgressLabel('已核对 120 / 500 条消息；本轮新处理 40 条，复用 80 条。'),
      '已核对 120 / 500 条消息（复用 80 条）',
    );
    expect(
      profileProgressLabel(
        '已核对 120 / 500 条消息；本轮新处理 40 条，复用 80 条。',
        language: 'en',
      ),
      'Verified 120 / 500 messages (80 reused)',
    );
  });

  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'progress labels retain counts without exposing diagnostics or budget',
    () {
      expect(
        profileProgressLabel(
          '已整理 240 / 1000 条文本，正在归纳事情、协作与习惯…\n验收预算 ¥5',
          language: 'en',
        ),
        'Processed 240 / 1000 messages',
      );
      expect(profileProgressLabel('正在核对第 2 / 5 批观察与原文引用…'), '正在核对原文…');
      expect(
        profileProgressLabel('正在独立核对实际主体、计划与完成状态…', language: 'en'),
        'Reviewing updates…',
      );
      expect(profileProgressLabel('internal_unknown_state e123'), '正在生成近况…');
    },
  );
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
      expect(find.text('同步消息'), findsOneWidget);
      expect(find.byType(Card), findsNothing);
      expect(
        tester.getTopLeft(find.text('近况与个人信息')).dy,
        lessThan(tester.getTopLeft(find.text('聊天记录')).dy),
      );
      await tester.scrollUntilVisible(find.text('近况与个人信息'), 200);
      expect(find.text('近况与个人信息'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '生成近况'), findsOneWidget);
      expect(find.text('先生成已整理部分'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('模型与隐私'), 150);
      expect(find.text('允许模型使用消息'), findsNothing);
      await tester.tap(find.text('模型与隐私'));
      await tester.pumpAndSettle();
      expect(find.text('允许模型使用消息'), findsOneWidget);
      await host.sources.grantProcessing(
        'https://model.example/v1|fixture',
        'profile',
        true,
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('停止模型使用消息'));
      await tester.tap(find.text('停止模型使用消息'));
      await tester.pumpAndSettle();
      expect(find.text('停止使用消息并删除生成内容？'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(
        () => host.sources.validateProcessing(
          'https://model.example/v1|fixture',
          'profile',
          host.sources.processingRevision,
        ),
        returnsNormally,
      );

      // Hold the real generation lifecycle before any model request.
      models.pendingRead = Completer<ModelConfiguration?>();
      await tester.scrollUntilVisible(
        find.text('生成近况'),
        -200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('生成近况'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('正在阅读聊天记录…'), findsOneWidget);
      expect(find.text('取消生成'), findsOneWidget);
      expect(find.text('生成近况'), findsNothing);
      expect(find.text('更新近况'), findsNothing);
      expect(find.textContaining('正在读取本机资料'), findsNothing);
      final dynamic runningState = tester.state(find.byType(FeishuDirectPage));
      final ProfileAgent runningAgent = runningState.profile;
      runningAgent.status =
          '已整理 240 / 1000 条文本，正在归纳事情、协作与习惯…\n验收预算 ¥5；累计预留 ¥0.100（保守上限，非账单）';
      runningAgent.onProgress!();
      await tester.pump();
      expect(find.text('已处理 240 / 1000 条消息'), findsOneWidget);
      expect(find.textContaining('验收预算'), findsNothing);
      expect(find.textContaining('协作与习惯'), findsNothing);
      await tester.tap(find.text('取消生成'));
      models.pendingRead!.completeError(const AgentFailure('cancelled'));
      models.pendingRead = null;
      await tester.pumpAndSettle();
      expect(find.text('继续生成'), findsOneWidget);
      expect(find.text('取消生成'), findsNothing);
      expect(
        find.text('已暂停生成，消息仍保存在手机。资料和授权未变化时，可继续使用已保存的进度。'),
        findsOneWidget,
      );

      models.failure = const ProfileRunFailure.deadline();
      await tester.scrollUntilVisible(
        find.text('继续生成'),
        -200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('继续生成'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('本轮整理已到时，已暂停。点击“继续生成”，可在资料和授权不变时接着已保存的进度整理。'),
        -100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        find.text('本轮整理已到时，已暂停。点击“继续生成”，可在资料和授权不变时接着已保存的进度整理。'),
        findsOneWidget,
      );
      expect(find.textContaining('请检查应用配置'), findsNothing);

      models.failure = const AgentFailure('source_expired');
      // The expanded settings scrolls the primary action out of the lazy list.
      await tester.scrollUntilVisible(
        find.text('继续生成'),
        -200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('继续生成').hitTestable(), findsOneWidget);
      await tester.tap(find.text('继续生成'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('部分消息已超过保存期限。请重新同步消息，再生成近况。'),
        -100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('部分消息已超过保存期限。请重新同步消息，再生成近况。'), findsOneWidget);
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
      expect(find.widgetWithText(FilledButton, '查看近况'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '继续生成'), findsOneWidget);
      expect(find.text('示例个人记忆'), findsNothing);
      await tester.ensureVisible(find.text('查看近况'));
      await tester.tap(find.text('查看近况'));
      await tester.pumpAndSettle();
      expect(find.text('示例个人记忆'), findsOneWidget);
      expect(find.text('补充或修改个人信息'), findsOneWidget);

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
      expect(find.text('前往飞书绑定应用'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      authority.dispose();
    },
  );
}
