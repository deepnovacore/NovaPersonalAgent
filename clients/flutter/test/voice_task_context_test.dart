import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/background_execution.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class _Settings extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => ModelConfiguration(
    endpoint: 'https://example.com',
    model: 'fixture',
    key: 'fixture',
  );
}

class _MissingSettings extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => null;
}

class _Summary extends ModelClient {
  _Summary(this.rounds, {this.gate, this.text = '已验证完成'});
  final List<List<Map<String, dynamic>>> rounds;
  final Completer<void>? gate;
  final String text;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    rounds.add(messages);
    await gate?.future;
    yield {'content': text};
  }
}

class _FailDispatch extends MemoryPersistence {
  bool fail = false;
  @override
  Future<void> write(String data) async {
    final rows = (jsonDecode(data) as Map)['conversations'] as List;
    final main = rows
        .where((row) => row['id'] == ConversationStore.mainId)
        .firstOrNull;
    if (fail &&
        main != null &&
        (main['messages'] as List).any(
          (m) => m['delegate_status'] == 'dispatched',
        )) {
      fail = false;
      throw const FileSystemException('fixture dispatch failure');
    }
    await super.write(data);
  }
}

class _FailTerminal extends MemoryPersistence {
  bool fail = true;
  @override
  Future<void> write(String data) async {
    final rows = (jsonDecode(data) as Map)['conversations'] as List;
    final main = rows
        .where((row) => row['id'] == ConversationStore.mainId)
        .firstOrNull;
    if (fail &&
        main != null &&
        (main['messages'] as List).any(
          (m) => m['delegate_status'] == 'returned',
        )) {
      fail = false;
      throw const FileSystemException('fixture terminal failure');
    }
    await super.write(data);
  }
}

class _GateCreation extends MemoryPersistence {
  final entered = Completer<void>(), release = Completer<void>();
  bool gate = false;
  @override
  Future<void> write(String data) async {
    final rows = (jsonDecode(data) as Map)['conversations'] as List;
    if (gate && rows.any((row) => row['delegate_origin'] is String)) {
      gate = false;
      entered.complete();
      await release.future;
    }
    await super.write(data);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'opened worker inherits options and continues with an experience model',
    () async {
      final root = await Directory.systemTemp.createTemp('voice-task-options-');
      addTearDown(() => root.delete(recursive: true));
      const channel = MethodChannel('plugins.flutter.io/path_provider');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => root.path);
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final child = await store.delegateTask(
        origin: origin,
        task: 'initial',
        request: 'Build a game',
        language: 'en',
      );
      final rounds = <List<Map<String, dynamic>>>[];
      final primary = AgentCoreHost(
        store: store,
        settings: _MissingSettings(),
        experienceModel: () async => (await _Settings().read())!,
        experiencePersona: true,
        additionalContext: (_) async => 'Fixture persona context',
        backgroundExecution: BackgroundExecution(),
        clientFactory: () => _Summary(rounds, text: 'Finished'),
      );
      addTearDown(primary.dispose);
      final bridge = await VoiceDelegateBridge.open(primary);
      addTearDown(bridge.dispose);
      expect(bridge.worker.experienceModel, same(primary.experienceModel));
      expect(bridge.worker.experiencePersona, true);
      expect(bridge.worker.additionalContext, same(primary.additionalContext));
      expect(
        bridge.worker.backgroundExecution,
        same(primary.backgroundExecution),
      );
      expect(bridge.worker.clientFactory, same(primary.clientFactory));
      expect(bridge.worker.allowLocalMemory, false);
      expect(bridge.worker.owner, 'voice:delegate');
      await bridge.continueTask(child, 'Add touch controls');
      expect(bridge.worker.error, isNull);
      expect(bridge.worker.lastTurnCompleted, true);
      expect(store.conversation(child)['delegate_status'], 'returned');
      expect(store.conversation(child)['delegate_language'], 'en');
      expect(
        rounds.single.any((m) => m['content'] == 'Fixture persona context'),
        true,
      );
      expect(
        (store.conversation(child)['messages'] as List).last['content'],
        'Finished',
      );
    },
  );

  test(
    'independent requests get separate task histories and continuation returns to origin',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final rounds = <List<Map<String, dynamic>>>[];
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final worker = AgentCoreHost(
        store: store,
        settings: primary.settings,
        allowLocalMemory: false,
        clientFactory: () => _Summary(rounds),
      );
      final bridge = VoiceDelegateBridge(primary: primary, worker: worker);
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      Future<String> run(String call, String request) async {
        final terminal = bridge.updates.firstWhere((u) => u.terminal);
        await bridge.start(
          conversation: origin,
          callId: call,
          request: request,
        );
        final context = bridge.taskConversationId!;
        await terminal;
        return context;
      }

      final first = await run('game', '开发俄罗斯方块');
      expect(
        (store.conversation(first)['messages'] as List).where(
          (m) =>
              m['role'] == 'assistant' && (m['content'] as String).isNotEmpty,
        ),
        hasLength(1),
      );
      final second = await run('report', '整理一份报告');
      expect(second, isNot(first));
      expect(
        rounds.last.where((m) => m['role'] == 'user').map((m) => m['content']),
        ['整理一份报告'],
      );
      expect(
        store.conversations.where((c) => c['delegate_origin'] == origin),
        hasLength(2),
      );
      expect(bridge.ownsConversation(first), true);
      expect(bridge.hostForConversation(first), same(worker));
      expect(bridge.hostForConversation(origin), same(primary));
      await bridge.continueTask(first, '增加触屏按钮', approve: (_) async => true);
      expect(
        rounds.last.where((m) => m['role'] == 'user').map((m) => m['content']),
        ['开发俄罗斯方块', '增加触屏按钮'],
      );
      final parent = store.conversation(origin)['messages'] as List;
      expect(parent.last['delegate_context'], first);
      expect(parent.last['content'], '已验证完成');
      expect(store.conversation(first)['delegate_status'], 'returned');
      expect(bridge.busy, false);
    },
  );

  test(
    'creation and terminal projections preserve an unrelated active parent turn',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      await store.checkpointTurn(origin, {'draft': '主聊尚未结束', 'units': 12});
      final checkpoint = store.conversation(origin)['active_turn'];
      var changed = 0;
      store.addListener(() => changed++);
      final gate = Completer<void>();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([], gate: gate),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: origin,
        callId: 'once',
        request: '做一个游戏',
      );
      final child = bridge.taskConversationId!;
      expect(primary.busy, false);
      expect(store.conversation(origin)['active_turn'], checkpoint);
      expect(store.conversation(child)['delegate_status'], 'dispatched');
      expect(store.conversation(child)['preview'], '做一个游戏');
      expect(
        (store.conversation(origin)['messages'] as List)
            .single['delegate_context'],
        child,
      );
      expect(changed, greaterThan(0));
      await expectLater(
        bridge.start(conversation: origin, callId: 'once', request: '重复'),
        throwsStateError,
      );
      gate.complete();
      await terminal;
      expect(store.conversation(origin)['active_turn'], checkpoint);
      final before = (store.conversation(origin)['messages'] as List).length;
      await bridge.reconcile();
      await bridge.reconcile();
      expect((store.conversation(origin)['messages'] as List).length, before);
    },
  );

  test(
    'legacy import skips invalid and colliding rows while importing valid rows once without rewriting bytes',
    () async {
      final root = await Directory.systemTemp.createTemp('voice-task-import-');
      addTearDown(() => root.delete(recursive: true));
      const channel = MethodChannel('plugins.flutter.io/path_provider');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => root.path);
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      const space = SpaceRecord(
        id: 'migration',
        name: 'migration',
        mode: SpaceMode.standalone,
      );
      final directory = await SpaceStorage.runScoped(
        space,
        () => SpaceStorage.directory(),
      );
      final legacy = File('${directory.path}/voice-delegate-contexts-v1.json');
      final raw = jsonEncode({
        'schema_version': 1,
        'conversations': [
          42,
          {
            'id': 'invalid-context',
            'backend': 'local',
            'messages': [
              {'role': 'user', 'content': 42},
            ],
          },
          {'id': ConversationStore.mainId, 'backend': 'local', 'messages': []},
          {'id': 'unlinked-context'},
          {
            'id': 'old-context',
            'backend': 'local',
            'messages': [
              {
                'role': 'user',
                'content': '开发游戏',
                'time': '2026-11-12T01:00:01Z',
              },
              {
                'role': 'assistant',
                'content': '旧任务已验证完成',
                'time': '2026-11-12T01:00:02Z',
                'delegate_result': 'old-run',
                'delegate_status': 'returned',
              },
            ],
          },
        ],
      });
      await legacy.writeAsString(raw);
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      for (final context in ['invalid-context', origin]) {
        await store.append(origin, {
          'role': 'assistant',
          'content': '',
          'delegate_id': 'bad-$context',
          'delegate_context': context,
          'delegate_status': 'returned',
        });
      }
      await store.append(origin, {
        'role': 'assistant',
        'content': '',
        'delegate_id': 'old-run',
        'delegate_context': 'old-context',
        'delegate_status': 'dispatched',
        'delegate_language': 'zh',
      });
      final primary = AgentCoreHost(store: store, settings: _Settings());
      addTearDown(primary.dispose);
      var bridge = await SpaceStorage.runScoped(
        space,
        () => VoiceDelegateBridge.open(primary),
      );
      expect(bridge.ownsConversation('old-context'), true);
      expect(store.conversation('old-context')['delegate_origin'], origin);
      expect(
        (store.conversation(origin)['messages'] as List).last['content'],
        '旧任务已验证完成',
      );
      expect(bridge.busy, false);
      bridge.dispose();
      bridge = await SpaceStorage.runScoped(
        space,
        () => VoiceDelegateBridge.open(primary),
      );
      addTearDown(bridge.dispose);
      expect(
        store.conversations.where((c) => c['id'] == 'old-context'),
        hasLength(1),
      );
      expect(store.conversation(origin)['messages'], hasLength(4));
      expect(
        store.conversations.any((c) => c['id'] == 'invalid-context'),
        false,
      );
      expect(store.conversation(origin)['delegate_origin'], isNull);
      expect(await legacy.readAsBytes(), utf8.encode(raw));
    },
  );

  test(
    'unreadable or unsupported legacy data does not disable delegation',
    () async {
      final root = await Directory.systemTemp.createTemp('voice-task-invalid-');
      addTearDown(() => root.delete(recursive: true));
      const channel = MethodChannel('plugins.flutter.io/path_provider');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => root.path);
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final directory = await SpaceStorage.directory();
      final legacy = File('${directory.path}/voice-delegate-contexts-v1.json');
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      await store.ensureMain();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      addTearDown(primary.dispose);
      for (final bytes in [
        [0xff],
        utf8.encode('{'),
        utf8.encode('{"schema_version":2,"conversations":[]}'),
      ]) {
        await legacy.writeAsBytes(bytes);
        final bridge = await VoiceDelegateBridge.open(primary);
        expect(bridge.busy, false);
        expect(store.conversations, hasLength(1));
        expect(await legacy.readAsBytes(), bytes);
        bridge.dispose();
      }
    },
  );

  test(
    'interrupted continuation cannot reuse a previous run final as its outcome',
    () async {
      final disk = MemoryPersistence();
      var store = ConversationStore(disk);
      await store.open();
      final origin = await store.ensureMain();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([]),
        ),
      );
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(conversation: origin, callId: 'old', request: '第一步');
      final child = bridge.taskConversationId!;
      await terminal;
      await store.append(origin, {
        'role': 'assistant',
        'content': '',
        'delegate_id': 'new-run',
        'delegate_context': child,
        'delegate_status': 'dispatched',
      });
      bridge.dispose();
      primary.dispose();
      store = ConversationStore(disk);
      await store.open();
      final reopened = AgentCoreHost(store: store, settings: _Settings());
      final recovered = VoiceDelegateBridge(
        primary: reopened,
        worker: AgentCoreHost(store: store, settings: reopened.settings),
      );
      addTearDown(recovered.dispose);
      addTearDown(reopened.dispose);
      await recovered.reconcile();
      final last = (store.conversation(origin)['messages'] as List).last;
      expect(last['delegate_id'], 'new-run');
      expect(last['delegate_status'], 'process_interrupted_unknown');
      expect(last['content'], isNot('已验证完成'));
    },
  );
  test(
    'long task results stay in the task and parent receives a bounded excerpt',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final text = List.filled(1000, '结果😀').join();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([], text: text),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(conversation: origin, callId: 'long', request: '详细报告');
      final child = bridge.taskConversationId!;
      final update = await terminal;
      final projection = (store.conversation(origin)['messages'] as List).last;
      expect((projection['content'] as String).runes.length, lessThan(700));
      expect(projection['content'], contains('完整结果见任务'));
      expect(projection['content'], isNot(contains('�')));
      expect(update.text, projection['content']);
      expect(
        (store.conversation(child)['messages'] as List).last['content'],
        text,
      );
    },
  );

  test(
    'failed creation projection never executes and releases the worker lane',
    () async {
      final disk = _FailDispatch();
      final store = ConversationStore(disk);
      await store.open();
      final origin = await store.ensureMain();
      final rounds = <List<Map<String, dynamic>>>[];
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary(rounds),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      disk.fail = true;
      await expectLater(
        bridge.start(conversation: origin, callId: 'fail', request: '不要执行'),
        throwsA(isA<FileSystemException>()),
      );
      expect(rounds, isEmpty);
      expect(bridge.busy, false);
      expect(bridge.worker.busy, false);
      expect(
        store.conversations.singleWhere(
          (c) => c['delegate_origin'] == origin,
        )['delegate_status'],
        'failed',
      );
      expect(store.conversation(origin)['messages'], isEmpty);
    },
  );
  test(
    'clearing the main conversation preserves visible task history',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([]),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: origin,
        callId: 'keep',
        request: '保留游戏成果',
      );
      final child = bridge.taskConversationId!;
      await terminal;
      final saved = store.conversation(child)['messages'];
      expect(
        await primary.clearConversation(
          origin,
          clearDerivedContext: () => bridge.clearConversationContext(origin),
        ),
        true,
      );
      expect(store.conversation(origin)['messages'], isEmpty);
      expect(store.conversation(child)['messages'], saved);
      expect(bridge.ownsConversation(child), true);
    },
  );
  test(
    'restart marks a task interrupted if dispatch receipt was never persisted',
    () async {
      final disk = MemoryPersistence();
      var store = ConversationStore(disk);
      await store.open();
      final origin = await store.ensureMain();
      final child = await store.delegateTask(
        origin: origin,
        task: 'orphan',
        request: '尚未执行',
        language: 'zh',
      );
      store = ConversationStore(disk);
      await store.open();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(store: store, settings: primary.settings),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      await bridge.reconcile();
      expect(
        store.conversation(child)['delegate_status'],
        'process_interrupted_unknown',
      );
      expect(store.conversation(origin)['messages'], isEmpty);
      expect(bridge.busy, false);
    },
  );
  test(
    'saved task result repairs a failed parent projection exactly once without duplicate task bubbles',
    () async {
      final store = ConversationStore(_FailTerminal());
      await store.open();
      final origin = await store.ensureMain();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([]),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: origin,
        callId: 'repair',
        request: '保存结果',
      );
      final child = bridge.taskConversationId!;
      await terminal;
      expect(bridge.busy, false);
      expect(store.conversation(origin)['messages'], hasLength(1));
      final replies = (store.conversation(child)['messages'] as List)
          .where(
            (m) =>
                m['role'] == 'assistant' && (m['content'] as String).isNotEmpty,
          )
          .toList();
      expect(replies, hasLength(1));
      expect(replies.single['delegate_result'], isNotNull);
      await bridge.reconcile();
      await bridge.reconcile();
      final parent = store.conversation(origin)['messages'] as List;
      expect(parent, hasLength(2));
      expect(parent.last['content'], '已验证完成');
    },
  );
  test(
    'task labels show the original multiline request without changing model history',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final rounds = <List<Map<String, dynamic>>>[];
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary(rounds),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      const request =
          'User request: 第一行\n第二行\nTask requested by voice front brain (within that scope): 具体执行要求';
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: origin,
        callId: 'label',
        request: request,
      );
      final child = bridge.taskConversationId!;
      await terminal;
      expect(store.conversation(child)['title'], '第一行\n第二行');
      expect(store.conversation(child)['preview'], '第一行\n第二行');
      expect(
        rounds.last.singleWhere((m) => m['role'] == 'user')['content'],
        request,
      );
      const plain =
          '原始文本\nTask requested by voice front brain (within that scope): 保留全部';
      final done = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(conversation: origin, callId: 'plain', request: plain);
      final other = bridge.taskConversationId!;
      await done;
      expect(store.conversation(other)['title'], plain);
    },
  );

  test(
    'voice continuation in a task delivers live result to that task while projecting to original parent',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary([]),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: origin,
        callId: 'first',
        request: '开发游戏',
      );
      final child = bridge.taskConversationId!;
      await terminal;
      final done = bridge.updates.firstWhere((u) => u.terminal);
      await bridge.start(
        conversation: child,
        callId: 'follow-up',
        request: '增加按钮',
      );
      expect(bridge.taskConversationId, child);
      expect(bridge.conversationId, origin);
      expect((await done).conversationId, child);
      expect(
        (store.conversation(origin)['messages'] as List)
            .last['delegate_context'],
        child,
      );
    },
  );
  test(
    'external summaries stay outside an unfinished parent tool round',
    () async {
      final disk = MemoryPersistence();
      final store = ConversationStore(disk);
      await store.open();
      final origin = await store.ensureMain();
      await store.append(origin, {'role': 'user', 'content': '主聊任务'});
      await store.append(origin, {
        'role': 'assistant',
        'content': '',
        'tool_calls': [
          {
            'id': 'first',
            'function': {'name': 'web_fetch', 'arguments': '{}'},
          },
          {
            'id': 'second',
            'function': {'name': 'web_fetch', 'arguments': '{}'},
          },
        ],
      });
      await store.append(origin, {
        'role': 'tool',
        'content': '{}',
        'tool_call_id': 'first',
      });
      await store.append(origin, {
        'role': 'assistant',
        'content': '独立任务结果',
        'delegate_id': 'child',
        'delegate_status': 'returned',
      }, external: true);
      await store.append(origin, {
        'role': 'tool',
        'content': '{}',
        'tool_call_id': 'second',
      });
      final messages = store.conversation(origin)['messages'] as List;
      expect(messages.map((m) => m['role']), [
        'user',
        'assistant',
        'assistant',
        'tool',
        'tool',
      ]);
      expect(messages[1]['content'], '独立任务结果');
      expect(messages[2]['tool_calls'], hasLength(2));
      await store.recoverInterruptedCalls(conversationId: origin);
      expect(store.conversation(origin)['messages'], messages);
      final reopened = ConversationStore(disk);
      await reopened.open();
      expect(reopened.conversation(origin)['messages'], messages);
    },
  );
  for (final role in ['user', 'assistant']) {
    test('voice $role stays before an unfinished task tool round', () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final child = await store.delegateTask(
        origin: origin,
        task: 'task',
        request: 'Run a tool',
        language: 'en',
      );
      await store.append(child, {
        'role': 'assistant',
        'content': '',
        'tool_calls': [
          {
            'id': 'call',
            'function': {'name': 'web_fetch', 'arguments': '{}'},
          },
        ],
      });
      await store.upsertVoiceMessage(
        child,
        itemId: 'voice',
        role: role,
        text: 'Voice text',
        turnId: 'turn',
      );
      var messages = store.conversation(child)['messages'] as List;
      expect(messages.first['voice_item'], 'voice');
      expect(messages.last['tool_calls'], hasLength(1));
      await store.append(child, {
        'role': 'tool',
        'content': '{}',
        'tool_call_id': 'call',
      });
      await store.upsertVoiceMessage(
        child,
        itemId: 'next',
        role: 'assistant',
        text: 'Next reply',
        turnId: 'next-turn',
      );
      await store.upsertVoiceMessage(
        child,
        itemId: 'next-user',
        role: 'user',
        text: 'Late transcript',
        turnId: 'next-turn',
      );
      await store.upsertVoiceMessage(
        child,
        itemId: 'voice',
        role: role,
        text: 'Final voice text',
        turnId: 'turn',
      );
      messages = store.conversation(child)['messages'] as List;
      expect(messages.map((m) => m['role']), [
        role,
        'assistant',
        'tool',
        'user',
        'assistant',
      ]);
      expect(messages.first['content'], 'Final voice text');
      expect(messages[3]['content'], 'Late transcript');
      expect(messages.last['content'], 'Next reply');
    });
  }
  test(
    'cancellation while task creation persists prevents the worker from starting',
    () async {
      final disk = _GateCreation();
      final store = ConversationStore(disk);
      await store.open();
      final origin = await store.ensureMain();
      final rounds = <List<Map<String, dynamic>>>[];
      final primary = AgentCoreHost(store: store, settings: _Settings());
      final bridge = VoiceDelegateBridge(
        primary: primary,
        worker: AgentCoreHost(
          store: store,
          settings: primary.settings,
          clientFactory: () => _Summary(rounds),
        ),
      );
      addTearDown(bridge.dispose);
      addTearDown(primary.dispose);
      disk.gate = true;
      final terminal = bridge.updates.firstWhere((u) => u.terminal);
      final starting = bridge.start(
        conversation: origin,
        callId: 'cancel-early',
        request: '不要执行',
      );
      await disk.entered.future;
      bridge.cancel(bridge.id!);
      disk.release.complete();
      await starting;
      await terminal;
      expect(rounds, isEmpty);
      expect(bridge.busy, false);
      final child = store.conversations.singleWhere(
        (row) => row['delegate_origin'] == origin,
      );
      expect(child['delegate_status'], 'cancelled');
      expect(
        (store.conversation(origin)['messages'] as List)
            .last['delegate_status'],
        'cancelled',
      );
    },
  );
}
