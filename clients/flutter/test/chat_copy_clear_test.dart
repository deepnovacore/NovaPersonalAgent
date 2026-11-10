import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/life_reducer.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'agent_chat_test.dart' show FakeNative;
import 'agent_core_test.dart' show MemoryPersistence;
import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';
import 'device_lane_test.dart' show args;

class _Model extends ModelClient {
  final requests = <List<Map<String, dynamic>>>[];
  Completer<void>? gate;
  bool device = false;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    requests.add(messages);
    if (gate != null) await gate!.future;
    if (device && messages.last['role'] == 'user') {
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'device-call',
            'type': 'function',
            'function': {
              'name': 'device_run_task',
              'arguments': jsonEncode(args),
            },
          },
        ],
      };
      return;
    }
    yield {'content': 'fresh answer'};
  }
}

class _GatedPersistence extends MemoryPersistence {
  Completer<void>? gate;
  bool fail = false;
  @override
  Future<void> write(String data) async {
    await gate?.future;
    if (fail) throw StateError('disk unavailable');
    await super.write(data);
  }
}

Future<ModelSettings> _settings() async {
  final settings = ModelSettings(native: FakeNative());
  await settings.save(
    endpoint: 'https://api.example.com/v1',
    model: 'm',
    key: 'secret',
  );
  return settings;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'assistant actions persist exclusive feedback and rerun only latest reply',
    (tester) async {
      final persistence = MemoryPersistence();
      final store = ConversationStore(persistence);
      await store.open();
      final id = await store.create();
      await store.append(id, {'role': 'user', 'content': 'old question'});
      await store.append(id, {'role': 'assistant', 'content': 'old answer'});
      const text = 'same question$_attach/workspace/a.pdf';
      await store.append(id, {'role': 'user', 'content': text});
      await store.append(id, {'role': 'assistant', 'content': 'last answer'});
      final model = _Model();
      final host = AgentCoreHost(
        store: store,
        settings: await _settings(),
        clientFactory: () => model,
      );
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,
              language: 'en',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('Like'), findsNWidgets(2));
      expect(find.byTooltip('Dislike'), findsNWidgets(2));
      expect(find.byTooltip('Regenerate'), findsOneWidget);
      await tester.tap(find.byTooltip('Like').last);
      await tester.pumpAndSettle();
      expect(
        (store.conversation(id)['messages'] as List).last['feedback'],
        'like',
      );
      await tester.tap(find.byTooltip('Dislike').last);
      await tester.pumpAndSettle();
      final reopened = ConversationStore(persistence);
      await reopened.open();
      expect(
        (reopened.conversation(id)['messages'] as List).last['feedback'],
        'dislike',
      );
      await tester.tap(find.byTooltip('Dislike').last);
      await tester.pumpAndSettle();
      expect(
        (store.conversation(id)['messages'] as List).last['feedback'],
        isNull,
      );
      for (final blocked in ['busy', 'voice', 'external', 'device']) {
        host.busy = blocked == 'busy';
        host.deviceHeldByOther = () => blocked == 'device';
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: LocalChatPanel(
                host: host,
                conversationId: id,
                language: 'en',
                voiceBusy: blocked == 'voice',
                externalTaskBusy: blocked == 'external',
              ),
            ),
          ),
        );
        expect(
          tester
              .widget<IconButton>(
                find.ancestor(
                  of: find.byTooltip('Regenerate'),
                  matching: find.byType(IconButton),
                ),
              )
              .onPressed,
          isNull,
        );
      }
      host.busy = false;
      host.deviceHeldByOther = null;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,
              language: 'en',
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('Regenerate'));
      await tester.pumpAndSettle();
      final request = model.requests.single;
      expect(request.last['content'], text);
      expect(jsonEncode(request), isNot(contains('last answer')));
      expect(jsonEncode(request), contains('old answer'));
      expect(
        (store.conversation(id)['messages'] as List).where(
          (m) => m['content'] == text,
        ),
        hasLength(1),
      );
      expect(find.text('fresh answer'), findsOneWidget);
    },
  );

  testWidgets('device rerun asks first and keeps the replay guard', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    var executions = 0;
    final result = {
      'status': 'outcome_unknown',
      'reason': 'model_invalid_action_fields',
      'dispatched_actions': 1,
      'unresolved_actions': 0,
      'action_in_flight': false,
    };
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    final model = _Model()..device = true;
    final host = AgentCoreHost(
      store: store,
      settings: await _settings(),
      clientFactory: () => model,
      tools: ToolRunner(
        journal: journal,
        registry: ToolRegistry(
          snapshot: emptyLife,
          mutate: (_, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {},
          requestDeviceTask: (_, id) async {
            executions++;
            return {...result, 'task_id': id};
          },
        ),
      ),
    );
    addTearDown(host.dispose);
    await host.send(id, 'open app', approve: (_) async => true);
    expect(executions, 1);
    expect(journal.hasUnresolved, isTrue);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'en'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Dispatched steps are accounted for'),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('Regenerate'));
    await tester.pumpAndSettle();
    expect(find.text('Regenerate?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(executions, 1);
    await tester.tap(find.byTooltip('Regenerate'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Regenerate'));
    await tester.pumpAndSettle();
    expect(executions, 1);
    expect(journal.hasUnresolved, isTrue);
    expect(
      jsonEncode(store.conversation(id)),
      contains('blocked_by_unresolved_prior_action'),
    );
    expect(find.text('I checked it; it can run again'), findsOneWidget);
  });

  test('regenerate reserves the lane while truncation persists', () async {
    final persistence = _GatedPersistence();
    final store = ConversationStore(persistence);
    await store.open();
    final id = await store.create();
    await store.append(id, {'role': 'user', 'content': 'again'});
    await store.append(id, {'role': 'assistant', 'content': 'old answer'});
    final time =
        (store.conversation(id)['messages'] as List).last['time'] as String;
    final model = _Model();
    final host = AgentCoreHost(
      store: store,
      settings: await _settings(),
      clientFactory: () => model,
    );
    addTearDown(host.dispose);
    persistence.gate = Completer<void>();
    final rerun = host.regenerate(id, time);
    expect(host.busy, isTrue);
    await host.send(id, 'racing send');
    expect(await host.clearConversation(id), isFalse);
    persistence.gate!.complete();
    await rerun;
    expect(model.requests, hasLength(1));
    expect(model.requests.single.last['content'], 'again');
    expect(host.busy, isFalse);
  });

  test(
    'readiness is refreshed before history and omitted when unavailable',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      await store.append(id, {
        'role': 'assistant',
        'content': 'Earlier accessibility failure',
      });
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      String? readiness = 'Live accessibility on';
      final model = _Model();
      final host = AgentCoreHost(
        store: store,
        settings: await _settings(),
        clientFactory: () => model,
        tools: ToolRunner(
          journal: journal,
          registry: ToolRegistry(
            snapshot: emptyLife,
            mutate: (_, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => {},
            spaceMode: SpaceMode.standalone,
            deviceReadiness: () async => readiness,
          ),
        ),
      );
      addTearDown(host.dispose);
      for (final status in [
        'Live accessibility on',
        'Live accessibility off',
        null,
      ]) {
        readiness = status;
        await host.send(id, 'new request');
        final request = model.requests.last;
        final systems = request
            .takeWhile((m) => m['role'] == 'system')
            .toList();
        expect(
          request.skip(systems.length).any((m) => m['role'] == 'system'),
          isFalse,
        );
        expect(
          systems
              .where((m) => '${m['content']}'.startsWith('Live accessibility'))
              .map((m) => m['content']),
          status == null ? isEmpty : equals([status]),
        );
      }
    },
  );

  test(
    'clear reserves the lane through persistence and releases it on failure',
    () async {
      final persistence = _GatedPersistence();
      final store = ConversationStore(persistence);
      await store.open();
      final id = await store.create();
      await store.append(id, {'role': 'user', 'content': 'old'});
      final model = _Model();
      final host = AgentCoreHost(
        store: store,
        settings: await _settings(),
        clientFactory: () => model,
      );
      addTearDown(host.dispose);
      persistence.gate = Completer<void>();
      final clear = host.clearConversation(id);
      expect(host.busy, isTrue);
      await host.send(id, 'must not start');
      expect(await host.clearConversation(id), isFalse);
      expect(model.requests, isEmpty);
      persistence.gate!.complete();
      expect(await clear, isTrue);
      expect(store.conversation(id)['messages'], isEmpty);
      expect(host.busy, isFalse);
      persistence.fail = true;
      await expectLater(host.clearConversation(id), throwsStateError);
      expect(host.busy, isFalse);
      persistence.fail = false;
      await host.send(id, 'new');
      expect(model.requests, hasLength(1));
    },
  );

  test(
    'clear forgets linked delegate context without touching another chat',
    () async {
      final store = ConversationStore(MemoryPersistence());
      final workerStore = ConversationStore(MemoryPersistence());
      await store.open();
      await workerStore.open();
      final id = await store.create();
      final context = await workerStore.create();
      final other = await workerStore.create();
      await store.append(id, {
        'role': 'assistant',
        'content': 'old result',
        'delegate_context': context,
      });
      for (final c in [context, other]) {
        await workerStore.append(c, {
          'role': 'user',
          'content': 'private task',
        });
      }
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final worker = AgentCoreHost(
        store: workerStore,
        settings: ModelSettings(),
      );
      final bridge = VoiceDelegateBridge(primary: host, worker: worker);
      addTearDown(host.dispose);
      addTearDown(bridge.dispose);
      expect(
        await host.clearConversation(
          id,
          clearDerivedContext: () => bridge.clearConversationContext(id),
        ),
        isTrue,
      );
      expect(workerStore.conversation(context)['messages'], isEmpty);
      expect(workerStore.conversation(other)['messages'], hasLength(1));
      await bridge.reconcile();
      expect(store.conversation(id)['messages'], isEmpty);
    },
  );

  testWidgets('every text message has a copy button that copies its text', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    await store.append(id, {
      'role': 'user',
      'content': 'hello there$_attach/workspace/a.pdf',
    });
    await store.append(id, {
      'role': 'assistant',
      'content': '',
      'reasoning_content': 'plan',
      'tool_calls': [
        {
          'id': 'c1',
          'type': 'function',
          'function': {'name': 'file_read', 'arguments': '{}'},
        },
      ],
    });
    await store.append(id, {
      'role': 'tool',
      'content': jsonEncode({'status': 'completed'}),
      'tool_call_id': 'c1',
      'tool_name': 'file_read',
    });
    await store.append(id, {
      'role': 'assistant',
      'content': 'the answer [file](nova-file:///workspace/a.pdf)',
      'reasoning_content': 'secret thoughts',
    });
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'en'),
        ),
      ),
    );
    final buttons = find.byTooltip('Copy');
    // Only the user message and the final answer; not tool or thinking rows.
    expect(buttons, findsNWidgets(2));
    expect(find.byTooltip('Like'), findsOneWidget);
    expect(find.byTooltip('Dislike'), findsOneWidget);
    expect(tester.getSemantics(buttons.first).tooltip, 'Copy');
    expect(tester.getSize(buttons.first).width, greaterThanOrEqualTo(32));

    await tester.tap(buttons.first);
    await tester.pump();
    expect(copied, ['hello there']);
    expect(find.byTooltip('Copied'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1600));
    expect(find.byTooltip('Copied'), findsNothing);

    await tester.tap(find.byTooltip('Copy').last);
    await tester.pump();
    expect(copied.last, 'the answer [file](nova-file:///workspace/a.pdf)');
    await tester.pump(const Duration(milliseconds: 1600));
    semantics.dispose();
  });

  testWidgets('no copy button on a message that is still streaming', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final model = _Model()..gate = Completer<void>();
    final host = AgentCoreHost(
      store: store,
      settings: await _settings(),
      clientFactory: () => model,
    );
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'en'),
        ),
      ),
    );
    final turn = host.send(id, 'question');
    await tester.pump();
    await tester.pump();
    // The stored user message is final; the pending reply has no copy button.
    expect(find.byTooltip('Copy'), findsOneWidget);
    expect(find.byTooltip('Like'), findsNothing);
    expect(find.byTooltip('Regenerate'), findsNothing);
    model.gate!.complete();
    await turn;
    await tester.pump();
    expect(find.byTooltip('Copy'), findsNWidgets(2));
  });

  testWidgets('clear erases messages and context but keeps the tool journal', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final persistence = MemoryLifePersistence();
    final store = ConversationStore(persistence);
    await store.open();
    final main = await store.ensureMain();
    await store.append(main, {'role': 'user', 'content': 'old secret topic'});
    await store.append(main, {'role': 'assistant', 'content': 'old reply'});
    await store.recordVoiceDelivery(main, 'v1', injection: 'unknown');
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    await journal.put('turn:fp', {
      'tool': 'device.run_task',
      'status': 'outcome_unknown',
      'operation_id': 'op1',
    });
    final model = _Model();
    final host = AgentCoreHost(
      store: store,
      settings: await _settings(),
      clientFactory: () => model,
      tools: ToolRunner(
        journal: journal,
        registry: ToolRegistry(
          snapshot: emptyLife,
          mutate: (_, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {},
          spaceMode: SpaceMode.standalone,
        ),
      ),
    );
    await tester.pumpWidget(
      NovaApp(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
        preferences: Preferences(await SharedPreferences.getInstance()),
        agentCore: host,
        lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
      ),
    );
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('old reply'), findsOneWidget);

    // Disabled while this conversation's task runs; never cancels it.
    model.gate = Completer<void>();
    final running = host.send(main, 'busy one');
    await tester.pump();
    await tester.pump();
    expect(host.busy, isTrue);
    final blocked = tester.widget<IconButton>(
      find.byKey(const ValueKey('global.clear')),
    );
    expect(blocked.onPressed, isNull);
    expect(blocked.tooltip, 'A task is running. Clear after it ends.');
    expect(await host.clearConversation(main), isFalse);
    model.gate!.complete();
    await running;
    await tester.pump();
    model.gate = null;
    model.requests.clear();

    await tester.tap(find.byKey(const ValueKey('global.clear')));
    await tester.pumpAndSettle();
    expect(find.text('Clear this conversation?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('old reply'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('global.clear')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(find.text('old reply'), findsNothing);
    expect(find.text('Start here.'), findsOneWidget);
    expect(store.conversation(main)['messages'], isEmpty);
    expect(store.conversation(main).containsKey('voice_deliveries'), isFalse);
    final saved = ConversationStore(persistence);
    await saved.open();
    expect(saved.conversation(main)['messages'], isEmpty);
    expect(journal.hasUnresolved, isTrue);
    expect(journal.awaitsConfirmation('op1'), isTrue);

    await host.send(main, 'brand new');
    final sent = jsonEncode(model.requests.single);
    expect(sent, contains('brand new'));
    expect(sent, isNot(contains('old secret topic')));
    expect(sent, isNot(contains('old reply')));
    expect(sent, isNot(contains('busy one')));
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
}

const _attach = '\n\n$localAttachmentHeader';
