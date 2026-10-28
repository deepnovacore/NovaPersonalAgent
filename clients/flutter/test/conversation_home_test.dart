import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/schedule_repository.dart';
import 'package:nova_mobile/agent_core/schedule_time.dart';
import 'package:nova_mobile/agent_core/scheduled_agent_runner.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/components.dart';
import 'package:nova_mobile/ui/conversation_home.dart';
import 'package:nova_mobile/ui/local_schedules_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

Map<String, dynamic> _message(String role, String content, DateTime at) => {
  'role': role,
  'content': content,
  'time': at.toUtc().toIso8601String(),
};

Map<String, dynamic> _conversation(
  String id,
  String title,
  List<Map<String, dynamic>> messages,
) => {'id': id, 'backend': 'local', 'title': title, 'messages': messages};

Future<ConversationStore> _openStore(
  List<Map<String, dynamic>> conversations,
) async {
  final persistence = MemoryLifePersistence()
    ..value = jsonEncode({'schema_version': 1, 'conversations': conversations});
  final store = ConversationStore(persistence);
  await store.open();
  return store;
}

Widget _home(
  AgentCoreHost host, {
  ScheduledAgentRunner? schedules,
  String language = 'zh',
  String? activeConversationId,
  ValueChanged<String>? onOpen,
  VoidCallback? onNew,
}) => MaterialApp(
  home: Scaffold(
    body: ConversationHome(
      host: host,
      language: language,
      schedules: schedules,
      activeConversationId: activeConversationId,
      onOpen: onOpen ?? (_) {},
      onNew: onNew ?? () {},
    ),
  ),
);

Future<ScheduledAgentRunner> _runner() async {
  final life = LifeHost(
    repository: LocalLife(MemoryLifePersistence()),
    backgroundReader: true,
  );
  await life.open();
  addTearDown(life.dispose);
  final repository = ScheduleRepository(
    MemoryLifePersistence(),
    deviceId: 'phone',
    clock: ScheduleClock(),
  );
  await repository.open();
  addTearDown(repository.dispose);
  final runner = ScheduledAgentRunner(repository, life, ModelSettings());
  addTearDown(runner.dispose);
  return runner;
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('session durations keep the P4 shape in both languages', () {
    expect(formatSessionDuration(const Duration(seconds: 45), 'zh'), '45秒');
    expect(formatSessionDuration(const Duration(seconds: 45), 'en'), '45s');
    expect(
      formatSessionDuration(const Duration(minutes: 3, seconds: 20), 'zh'),
      '3分20秒',
    );
    expect(
      formatSessionDuration(const Duration(minutes: 3, seconds: 20), 'en'),
      '3m 20s',
    );
    expect(
      formatSessionDuration(const Duration(hours: 1, minutes: 5), 'zh'),
      '1小时5分',
    );
    expect(
      formatSessionDuration(const Duration(hours: 1, minutes: 5), 'en'),
      '1h 5m',
    );
  });

  testWidgets(
    'unsent conversations stay out of history until a message is saved',
    (tester) async {
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final first = await store.create();
      await store.create();
      await store.create();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      addTearDown(host.dispose);
      await tester.pumpWidget(_home(host));
      expect(find.text('新的对话'), findsNothing);
      expect(find.text('独立的事，在这里处理'), findsOneWidget);
      expect(store.conversations, hasLength(3));
      await store.append(first, {
        'role': 'user',
        'content': 'Synthetic first message',
      });
      await tester.pumpWidget(_home(host));
      await tester.pump();
      expect(find.text('Synthetic first message'), findsWidgets);
      expect(find.byType(NovaTile), findsOneWidget);
      expect(find.text('今天'), findsOneWidget);
      expect(find.text('独立的事，在这里处理'), findsNothing);
      expect(store.conversations, hasLength(3));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('task rows group by last-message day and show session duration', (
    tester,
  ) async {
    final now = DateTime.now();
    final noon = DateTime(now.year, now.month, now.day, 12);
    final store = await _openStore([
      _conversation('chat:a', 'Morning plan', [
        _message('user', 'Morning plan', noon),
        _message(
          'assistant',
          'Leave the afternoon open.',
          noon.add(const Duration(minutes: 3, seconds: 20)),
        ),
      ]),
      _conversation('chat:b', 'Long read', [
        _message('user', 'Long read', noon),
        _message(
          'assistant',
          'One hour later.',
          noon.add(const Duration(hours: 1, minutes: 5)),
        ),
      ]),
      _conversation('chat:c', 'Older note', [
        _message('user', 'Older note', noon.subtract(const Duration(days: 2))),
      ]),
      // An in-progress draft with no saved message still belongs to today.
      _conversation('chat:d', 'Unsaved draft', []),
    ]);
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await tester.pumpWidget(_home(host, activeConversationId: 'chat:d'));
    expect(find.text('今天'), findsOneWidget);
    expect(find.text('更早'), findsOneWidget);
    // Multi-message rows report the session span instead of relative time.
    expect(find.text('3分20秒'), findsOneWidget);
    expect(find.text('1小时5分'), findsOneWidget);
    // A single-message row keeps the existing relative-time label.
    expect(find.text('2 天前'), findsOneWidget);
    expect(find.byType(NovaTile), findsNWidgets(4));
    final draftY = tester.getTopLeft(find.text('Unsaved draft')).dy;
    expect(draftY, lessThan(tester.getTopLeft(find.text('更早')).dy));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'tasks and schedules segments switch and explain missing runner',
    (tester) async {
      final store = await _openStore([
        _conversation('chat:a', 'Morning plan', [
          _message('user', 'Morning plan', DateTime.now()),
        ]),
      ]);
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      addTearDown(host.dispose);
      await tester.pumpWidget(_home(host, language: 'en'));
      expect(find.text('Tasks'), findsOneWidget);
      expect(find.text('Schedules'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'New task'), findsOneWidget);
      expect(find.text('Today'), findsOneWidget);
      await tester.tap(find.text('Schedules'));
      await tester.pumpAndSettle();
      expect(find.text('Schedules are not ready yet'), findsOneWidget);
      expect(find.byType(NovaTile), findsNothing);
      expect(find.widgetWithText(FilledButton, 'New task'), findsNothing);
      await tester.tap(find.text('Tasks'));
      await tester.pumpAndSettle();
      expect(find.text('Schedules are not ready yet'), findsNothing);
      expect(find.byType(NovaTile), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'New task'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('the schedules segment embeds the phone scheduler page', (
    tester,
  ) async {
    final store = await _openStore([
      _conversation('chat:a', 'Morning plan', [
        _message('user', 'Morning plan', DateTime.now()),
      ]),
    ]);
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    final runner = await _runner();
    await tester.pumpWidget(_home(host, schedules: runner));
    await tester.tap(find.text('定时'));
    await tester.pumpAndSettle();
    expect(find.byType(LocalSchedulesPage), findsOneWidget);
    // The host owns the page chrome: no nested app bar or duplicate title.
    expect(find.byType(AppBar), findsNothing);
    expect(find.text('手机定时任务'), findsNothing);
    expect(find.text('定时任务尚未就绪'), findsNothing);
    // The list and the create action survive the embedded layout.
    expect(find.textContaining('任务由这台手机负责执行'), findsOneWidget);
    expect(find.byTooltip('新建定时任务'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the standalone schedules page keeps its own title and action', (
    tester,
  ) async {
    final runner = await _runner();
    await tester.pumpWidget(
      MaterialApp(home: LocalSchedulesPage(runner: runner)),
    );
    await tester.pumpAndSettle();
    expect(find.byType(AppBar), findsOneWidget);
    expect(find.text('手机定时任务'), findsOneWidget);
    expect(find.byTooltip('新建定时任务'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('search filters grouped tasks, then clears to the full list', (
    tester,
  ) async {
    final now = DateTime.now();
    final noon = DateTime(now.year, now.month, now.day, 12);
    final store = await _openStore([
      _conversation('chat:a', 'Morning plan', [
        _message('user', 'Morning plan', noon),
        _message('assistant', 'Leave the afternoon open.', noon),
      ]),
      _conversation('chat:b', 'Garden list', [
        _message('user', 'Garden list', noon.subtract(const Duration(days: 1))),
      ]),
    ]);
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await tester.pumpWidget(_home(host));
    expect(find.byType(NovaTile), findsNWidgets(2));
    await tester.tap(find.byTooltip('搜索任务'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Garden');
    await tester.pumpAndSettle();
    expect(find.text('Morning plan'), findsNothing);
    expect(find.text('Garden list'), findsWidgets);
    expect(find.text('今天'), findsNothing);
    expect(find.text('更早'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'missing');
    await tester.pumpAndSettle();
    expect(find.text('没有找到任务'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '');
    await tester.pumpAndSettle();
    expect(find.byType(NovaTile), findsNWidgets(2));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('new task and opening a row still reach the app callbacks', (
    tester,
  ) async {
    final store = await _openStore([
      _conversation('chat:a', 'Morning plan', [
        _message('user', 'Morning plan', DateTime.now()),
      ]),
    ]);
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    String? opened;
    var created = false;
    await tester.pumpWidget(
      _home(
        host,
        language: 'en',
        onOpen: (id) => opened = id,
        onNew: () => created = true,
      ),
    );
    expect(find.widgetWithText(FilledButton, 'New task'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'New task'));
    expect(created, isTrue);
    await tester.tap(find.text('Morning plan').first);
    expect(opened, 'chat:a');
    await tester.pumpWidget(const SizedBox());
  });
}
