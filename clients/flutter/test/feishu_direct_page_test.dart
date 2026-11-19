import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/connectors/feishu/collection.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/profile_budget.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/ui/feishu_direct_page.dart';
import 'package:nova_mobile/ui/components.dart';
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

/// Records the credentials the page passes to the real [FeishuAuth.bindApp].
class RecordingAuth extends FeishuAuth {
  RecordingAuth(super.persistence, super.api);
  ({String brand, String appId, String secret})? bound;
  @override
  Future<void> bindApp({
    required String brand,
    required String appId,
    required String secret,
  }) {
    bound = (brand: brand, appId: appId, secret: secret);
    return super.bindApp(brand: brand, appId: appId, secret: secret);
  }
}

class _AcceptanceBudgetProfile extends ProfileAgent {
  _AcceptanceBudgetProfile(super.connector, super.publication, super.models);
  @override
  ProfileBudget get budget => _budget;
  final _budget = ProfileBudget(MemoryLifePersistence())
    ..reservedMicroyuan = 100000;
}

/// UI snapshots avoid opening the connector's shared ingestion/checkpoint queues.
class _SyncCardAuth extends FeishuAuth {
  _SyncCardAuth() : super(MemoryLifePersistence(), FeishuApi());
  @override
  bool get configured => true;
  @override
  bool get authorized => true;
  @override
  Map<String, dynamic> get identity => {'name': '示例用户'};
}

class _SyncCardSources extends SourceStore {
  _SyncCardSources() : super(MemoryLifePersistence());
  @override
  List<String> get sources => ['fixture-chat'];
  int statisticsReads = 0;
  @override
  ({Map<String, int> byStatus, Map<String, int> byChat}) get messageCounts {
    statisticsReads++;
    return (byStatus: {'available': 1}, byChat: {'fixture-chat': 1});
  }

  @override
  List<Map<String, dynamic>> messages(String id) =>
      throw StateError('UI must not copy message bodies');
  @override
  Map<String, dynamic> checkpoint(String id) => {'paused': false};
}

class _SyncCardCollection extends FeishuCollection {
  _SyncCardCollection(super.ingest) {
    running = true;
  }
  int pauseCalls = 0;
  @override
  void pause() {
    pauseCalls++;
    running = false;
    notifyListeners();
  }
}

class _SyncCardHost extends FeishuHost {
  _SyncCardHost() : super(auth: _SyncCardAuth(), sources: _SyncCardSources());
  @override
  bool get ready => true;
  late final sync = _SyncCardCollection(ingest)..addListener(notifyListeners);
  @override
  FeishuCollection get collection => sync;
}

/// Pumps the Feishu page with no app configured and a tall viewport so the
/// whole manual-bind form stays built and hit-testable.
Future<({FeishuHost host, RecordingAuth auth, MemoryLifePersistence disk})>
_pumpUnconfigured(WidgetTester tester, {bool collectionRunning = false}) async {
  tester.view.physicalSize = const Size(800, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (_) async => null,
  );
  final disk = MemoryLifePersistence();
  final auth = RecordingAuth(disk, FeishuApi());
  final host = FeishuHost(
    auth: auth,
    sources: SourceStore(MemoryLifePersistence()),
  );
  // A real long-running collection is surfaced by this flag; setting it before
  // the first build keeps the page's sync state deterministic in tests.
  host.collection.running = collectionRunning;
  addTearDown(host.dispose);
  final publication = LocalPublicationContext(MemoryLifePersistence());
  await publication.open();
  addTearDown(publication.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: FeishuDirectPage(
        host: host,
        models: ModelSettings(),
        publication: publication,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (host: host, auth: auth, disk: disk);
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
          '已整理 240 / 1000 条文本，正在归纳事情、协作与习惯…\n已记账（保守估算）¥0.100；实际费用以账单为准',
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
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final models = FixtureModels();
      await tester.pumpWidget(
        MaterialApp(
          home: FeishuDirectPage(
            host: host,
            models: models,
            publication: publication,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('同步消息'), findsOneWidget);
      expect(find.byType(Card), findsNothing);
      expect(find.byIcon(Icons.sync_rounded), findsOneWidget);
      expect(find.byIcon(Icons.auto_awesome_outlined), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('近况与个人信息')).dy,
        greaterThan(tester.getTopLeft(find.text('聊天记录')).dy),
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
      await tester.pump();
      await tester.tap(find.text('生成近况'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('正在阅读聊天记录…'), findsOneWidget);
      expect(find.text('取消生成'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('feishu.generation.spinner')),
        findsOneWidget,
      );
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(find.text('生成近况'), findsNothing);
      expect(find.text('更新近况'), findsNothing);
      expect(find.textContaining('正在读取本机资料'), findsNothing);
      final dynamic runningState = tester.state(find.byType(FeishuDirectPage));
      final ProfileAgent runningAgent = runningState.profile;
      runningAgent.status =
          '已整理 240 / 1000 条文本，正在归纳事情、协作与习惯…\n已记账（保守估算）¥0.100；实际费用以账单为准';
      runningAgent.onProgress!();
      await tester.pump();
      expect(find.text('已处理 240 / 1000 条消息'), findsOneWidget);
      expect(find.textContaining('已记账（保守估算）'), findsNothing);
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
      await tester.pump();
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
      await tester.pump();
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
      publication.dispose();
    },
  );
  testWidgets('model privacy shows recorded acceptance accounting, not a cap', (
    tester,
  ) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
      (_) async => null,
    );
    final host = _SyncCardHost();
    host.sync.running = false;
    final publication = LocalPublicationContext(MemoryLifePersistence());
    final profile = _AcceptanceBudgetProfile(
      host,
      publication,
      FixtureModels(),
    );
    addTearDown(host.dispose);
    addTearDown(publication.dispose);
    addTearDown(profile.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: FeishuDirectPage(
          host: host,
          models: FixtureModels(),
          publication: publication,
          profileAgent: profile,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('模型与隐私'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pump();
    await tester.tap(find.text('模型与隐私'));
    await tester.pumpAndSettle();
    expect(find.text('已记账（保守估算）¥0.100'), findsOneWidget);
    expect(find.text('非账单；实际费用以模型服务账单为准。'), findsOneWidget);
    expect(find.textContaining('本次费用上限'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'collapsed Feishu page computes counts once without copying message bodies',
    (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
        (_) async => null,
      );
      final host = _SyncCardHost();
      host.sync.running = false;
      final publication = LocalPublicationContext(MemoryLifePersistence());
      addTearDown(host.dispose);
      addTearDown(publication.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: FeishuDirectPage(
            host: host,
            models: FixtureModels(),
            publication: publication,
          ),
        ),
      );
      await tester.pumpAndSettle();
      final sources = host.sources as _SyncCardSources;
      final previous = sources.statisticsReads;
      final dynamic state = tester.state(find.byType(FeishuDirectPage));
      state.build(tester.element(find.byType(FeishuDirectPage)));
      expect(sources.statisticsReads - previous, 1);
      expect(find.text('fixture-chat'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('同步范围'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pump();
      await tester.tap(find.text('同步范围'));
      await tester.pumpAndSettle();
      expect(find.text('fixture-chat'), findsOneWidget);
      expect(find.text('1 条缓存 · 尚未完成首次读取'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'sync cards show saved counts, spinner and pause on a narrow phone',
    (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
        (_) async => null,
      );
      final host = _SyncCardHost();
      final publication = LocalPublicationContext(MemoryLifePersistence());
      addTearDown(host.dispose);
      addTearDown(publication.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: FeishuDirectPage(
            host: host,
            models: FixtureModels(),
            publication: publication,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('示例用户'), findsOneWidget);
      expect(find.text('已授权'), findsOneWidget);
      expect(find.text('已保存 1 条消息 · 1 个对话'), findsOneWidget);
      expect(find.byKey(const ValueKey('feishu.sync.spinner')), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(find.text('正在同步，可继续使用其他页面。'), findsOneWidget);
      final pause = find.text('暂停同步');
      await tester.ensureVisible(pause);
      await tester.pump();
      await tester.tap(pause);
      await tester.pump();
      expect(host.sync.pauseCalls, 1);
      // Removing the status row shifts the button above the aligned viewport.
      await tester.scrollUntilVisible(
        find.text('同步消息'),
        -100,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('feishu.sync.spinner')), findsNothing);
      expect(find.text('同步消息'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('同步范围'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.textContaining('原文自本次成功读取'), findsNothing);
      await tester.pump();
      await tester.tap(find.text('同步范围'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('原文自本次成功读取'), findsOneWidget);
      expect(find.text('断开并撤销飞书授权'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(seconds: 45)),
  );

  testWidgets(
    'unconfigured page offers create-new and connect-existing entry paths',
    (tester) async {
      final page = await _pumpUnconfigured(tester);
      expect(page.host.auth.configured, isFalse);
      expect(find.text('通过飞书网页绑定'), findsOneWidget);
      expect(find.text('手动绑定已有应用'), findsOneWidget);
      // Secret inputs stay collapsed until the existing-app path is chosen.
      expect(find.byType(TextField), findsNothing);
      await tester.tap(find.text('手动绑定已有应用'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNWidgets(2));
      expect(find.text('App ID'), findsOneWidget);
      expect(find.text('App Secret'), findsOneWidget);
      // The primary create-new path stays visible next to the manual form.
      expect(find.text('通过飞书网页绑定'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'manual binding validates the app id and secret before calling the host',
    (tester) async {
      final page = await _pumpUnconfigured(tester);
      await tester.tap(find.text('手动绑定已有应用'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'not_a_cli_id');
      await tester.enterText(find.byType(TextField).at(1), 'synthetic-secret');
      await tester.tap(find.text('绑定应用'));
      await tester.pumpAndSettle();
      expect(find.text('应用 ID 需以 cli_ 开头。'), findsOneWidget);
      expect(page.auth.bound, isNull);
      expect(page.host.auth.configured, isFalse);
      expect(find.text('通过飞书网页绑定'), findsOneWidget);

      await tester.enterText(find.byType(TextField).at(0), 'cli_fixture');
      await tester.enterText(find.byType(TextField).at(1), '');
      await tester.tap(find.text('绑定应用'));
      await tester.pumpAndSettle();
      expect(find.text('请填写 App Secret。'), findsOneWidget);
      expect(page.auth.bound, isNull);
      expect(page.host.auth.configured, isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('manual binding stays enabled while message sync is running', (
    tester,
  ) async {
    // A long collection run must not lock the user out of credentials.
    final page = await _pumpUnconfigured(tester, collectionRunning: true);
    expect(
      tester.widget<NovaTile>(find.widgetWithText(NovaTile, '通过飞书网页绑定')).onTap,
      isNull,
    );
    await tester.tap(find.text('手动绑定已有应用'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'cli_fixture');
    await tester.enterText(find.byType(TextField).at(1), 'synthetic-secret');
    await tester.tap(find.text('绑定应用'));
    await tester.pumpAndSettle();
    expect(page.auth.bound, (
      brand: 'feishu',
      appId: 'cli_fixture',
      secret: 'synthetic-secret',
    ));
    expect(find.text('应用已绑定'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'manual binding stores typed credentials and hands off to authorization',
    (tester) async {
      final page = await _pumpUnconfigured(tester);
      await tester.tap(find.text('手动绑定已有应用'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      // The button keeps a hidden copy of every item; pick the open menu one.
      await tester.tap(find.text('Lark').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'cli_fixture');
      await tester.enterText(find.byType(TextField).at(1), 'synthetic-secret');
      await tester.tap(find.text('绑定应用'));
      await tester.pumpAndSettle();
      expect(page.auth.bound, (
        brand: 'lark',
        appId: 'cli_fixture',
        secret: 'synthetic-secret',
      ));
      final saved = jsonDecode(page.disk.value!) as Map<String, dynamic>;
      expect((saved['app'] as Map)['brand'], 'lark');
      expect((saved['app'] as Map)['app_id'], 'cli_fixture');
      expect((saved['app'] as Map)['secret'], 'synthetic-secret');
      // The existing configured page takes over and asks for user consent.
      expect(find.text('应用已绑定'), findsOneWidget);
      expect(find.text('前往飞书授权'), findsOneWidget);
      expect(find.text('通过飞书网页绑定'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
