import 'dart:async';
import 'package:flutter/material.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'phone_voice_session_test.dart' show VoiceAudio;

class TopicHost extends AgentCoreHost {
  TopicHost(ConversationStore store)
    : super(store: store, settings: ModelSettings());
  final release = Completer<void>();
  final delivered = <String>[];
  int cancellations = 0;
  @override
  void cancel() {
    cancellations++;
    super.cancel();
    busy = false;
    notifyListeners();
  }

  @override
  Future<void> send(
    String conversationId,
    String text, {
    ToolApproval? approve,
    String? language,
    bool userAuthored = true,
  }) async {
    busy = true;
    delivered.add(text);
    await release.future;
    busy = false;
  }
}

class _MissingSettings extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => null;
}

class _TurnSettings extends ModelSettings {
  bool fail = false;
  @override
  Future<ModelConfiguration?> read() async {
    if (fail) {
      throw const AgentFailure('network_unavailable');
    }
    return ModelConfiguration(
      endpoint: 'https://example.com',
      model: 'fixture',
      key: 'fixture',
    );
  }
}

class _FailedModel extends ModelClient {
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    throw const AgentFailure('network_unavailable');
  }
}

void main() {
  for (final bridgeReady in [false, true]) {
    testWidgets(
      'delegated task cannot regenerate outside its bridge ($bridgeReady)',
      (tester) async {
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        final origin = await store.ensureMain();
        final chat = await store.delegateTask(
          origin: origin,
          task: 'task',
          request: 'Task request',
          language: 'zh',
        );
        await store.append(chat, {'role': 'user', 'content': 'Task request'});
        await store.append(chat, {
          'role': 'assistant',
          'content': 'Task result',
        });
        final host = TopicHost(store);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: LocalChatPanel(
                host: host,
                conversationId: chat,
                onTaskText: bridgeReady ? (_, _) async {} : null,
              ),
            ),
          ),
        );
        final regenerate = find.byWidgetPredicate(
          (widget) => widget is IconButton && widget.tooltip == '重新生成',
        );
        if (bridgeReady) {
          expect(regenerate, findsNothing);
        } else {
          expect(regenerate, findsOneWidget);
          expect(tester.widget<IconButton>(regenerate).onPressed, isNull);
        }
        expect(store.conversation(chat)['messages'], hasLength(2));
        await tester.pumpWidget(const SizedBox());
        host.dispose();
      },
    );
  }

  testWidgets('task error banner belongs to the failed conversation only', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final first = await store.create(), second = await store.create();
    final host = AgentCoreHost(store: store, settings: _MissingSettings());
    await host.send(first, 'Fail before storing');
    expect(host.errorConversationId, first);
    expect(host.activeConversationId, isNull);
    Widget panel(String chat, {bool task = true}) => MaterialApp(
      home: Scaffold(
        body: LocalChatPanel(
          host: host,
          conversationId: chat,
          onTaskText: task
              ? (text, approve) => host.send(chat, text, approve: approve)
              : null,
        ),
      ),
    );
    await tester.pumpWidget(panel(first));
    expect(find.text('先选择一个模型，就可以开始对话。'), findsOneWidget);
    await tester.pumpWidget(panel(second));
    expect(host.error, 'model_settings_required');
    expect(find.text('先选择一个模型，就可以开始对话。'), findsNothing);
    await tester.pumpWidget(panel(second, task: false));
    expect(find.text('先选择一个模型，就可以开始对话。'), findsOneWidget);
    host.error = null;
    expect(host.errorConversationId, isNull);
    expect(host.errorInTranscript, false);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });

  testWidgets(
    'pre-store failure matching an old interruption still has its own banner',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final chat = await store.create();
      final settings = _TurnSettings();
      final host = AgentCoreHost(
        store: store,
        settings: settings,
        clientFactory: _FailedModel.new,
      );
      await host.send(chat, 'First turn');
      expect(host.error, 'network_unavailable');
      expect(host.errorInTranscript, true);
      final previous = store.conversation(chat)['messages'];
      settings.fail = true;
      final key = GlobalKey<LocalChatPanelState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: chat,
              onTaskText: (text, approve) =>
                  host.send(chat, text, approve: approve),
            ),
          ),
        ),
      );
      expect(find.text('网络暂时不可用，进度已保存。'), findsOneWidget);
      key.currentState!.input.text = 'Retry';
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pumpAndSettle();
      expect(host.error, 'network_unavailable');
      expect(host.errorConversationId, chat);
      expect(host.errorInTranscript, false);
      expect(store.conversation(chat)['messages'], previous);
      expect(key.currentState!.input.text, 'Retry');
      expect(find.text('网络暂时不可用，进度已保存。'), findsNWidgets(2));
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );

  for (final code in [
    'model_http_401',
    'experience_quota_exceeded',
    'local_chat_failed',
  ]) {
    testWidgets('task banner preserves actionable $code feedback', (
      tester,
    ) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final chat = await store.create();
      await store.append(chat, {
        'role': 'assistant',
        'content': '',
        'interrupted': true,
        'error': code,
      });
      final host = TopicHost(store)
        ..activeConversationId = chat
        ..error = code
        ..errorInTranscript = true
        ..activeConversationId = null;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: chat,
              onTaskText: (_, _) async {},
              onChooseModel: () async {},
            ),
          ),
        ),
      );
      if (code == 'local_chat_failed') {
        expect(find.text('选择模型'), findsNothing);
        expect(find.text('这次执行未完成，已保留当前进度。'), findsOneWidget);
      } else {
        expect(find.text('选择模型'), findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    });
  }

  testWidgets('stop cancels the task host while voice text is active', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final chat = await store.create();
    final host = TopicHost(store)
      ..busy = true
      ..activeConversationId = chat;
    final key = GlobalKey<LocalChatPanelState>();
    final voiceTexts = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            key: key,
            host: host,
            conversationId: chat,
            onVoiceText: (text) async => voiceTexts.add(text),
          ),
        ),
      ),
    );
    key.currentState!.input.text = 'Keep this draft';
    await tester.pump();
    await tester.tap(find.byTooltip('停止'));
    expect(host.cancellations, 1);
    expect(voiceTexts, isEmpty);
    expect(key.currentState!.input.text, 'Keep this draft');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(voiceTexts, ['Keep this draft']);
    expect(key.currentState!.input.text, isEmpty);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });

  testWidgets('task pre-store setup failure shows feedback and keeps draft', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final chat = await store.create();
    final host = AgentCoreHost(store: store, settings: _MissingSettings());
    final key = GlobalKey<LocalChatPanelState>();
    var settingsOpened = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            key: key,
            host: host,
            conversationId: chat,
            onTaskText: (text, approve) =>
                host.send(chat, text, approve: approve),
            onChooseModel: () async {
              settingsOpened++;
            },
          ),
        ),
      ),
    );
    key.currentState!.input.text = 'Continue task';
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    expect(host.error, 'model_settings_required');
    expect(store.conversation(chat)['messages'], isEmpty);
    expect(key.currentState!.input.text, 'Continue task');
    expect(find.text('先选择一个模型，就可以开始对话。'), findsOneWidget);
    await tester.tap(find.text('选择模型'));
    expect(settingsOpened, 1);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });

  testWidgets(
    'shared idea retains draft and attachments without double sending',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      await store.ensureMain();
      final host = TopicHost(store);
      final key = GlobalKey<LocalChatPanelState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: ConversationStore.mainId,
            ),
          ),
        ),
      );
      await tester.pump();
      final panel = key.currentState!;
      panel.input.text = 'my unsent draft';
      panel.attachments.add({'path': 'draft.pdf'});
      final sending = panel.sendSharedIdea('How do I brew tea?');
      await panel.sendSharedIdea('How do I brew tea?');
      expect(host.delivered, ['How do I brew tea?']);
      host.release.complete();
      await sending;
      expect(panel.input.text, 'my unsent draft');
      expect(panel.attachments.single['path'], 'draft.pdf');
      await tester.pumpWidget(const SizedBox.shrink());
      host.dispose();
    },
  );

  testWidgets(
    'a running background task turns the empty send key into its stop; failed voice send keeps draft',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final chat = await store.create();
      final host = TopicHost(store);
      host.release.complete();
      var cancelled = 0;
      final key = GlobalKey<LocalChatPanelState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: chat,

              externalTaskBusy: true,
              onCancelExternalTask: () => cancelled++,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byTooltip('停止'), findsNothing);
      expect(find.byTooltip('停止任务'), findsOneWidget);
      // One key: typing turns it into send, without losing the task.
      key.currentState!.input.text = 'Continue our conversation';
      await tester.pump();
      expect(find.byTooltip('停止任务'), findsNothing);
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      expect(host.delivered, ['Continue our conversation']);
      expect(cancelled, 0);
      await tester.tap(find.byTooltip('停止任务'));
      expect(cancelled, 1);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: chat,

              onVoiceText: (_) async => throw StateError('busy'),
            ),
          ),
        ),
      );
      key.currentState!.input.text = 'please keep my request';
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      expect(key.currentState!.input.text, 'please keep my request');
      expect(find.textContaining('草稿已保留'), findsOneWidget);
      expect(store.conversation(chat)['messages'], isEmpty);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );
  testWidgets(
    'task receipts stay visible without process details and update from shared store',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final origin = await store.ensureMain();
      final child = await store.delegateTask(
        origin: origin,
        task: 'run',
        request: 'Build a game',
        language: 'en',
      );
      final host = TopicHost(store);
      String? opened;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: origin,
              showProcess: false,
              language: 'en',
              onOpenTask: (id) => opened = id,
            ),
          ),
        ),
      );
      await store.append(origin, {
        'role': 'assistant',
        'content': 'Created a task.',
        'delegate_id': 'run',
        'delegate_context': child,
        'delegate_status': 'dispatched',
      }, external: true);
      await tester.pump();
      expect(find.text('Created a task.'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('delegate.open:run:dispatched')),
      );
      expect(opened, child);
      await store.append(origin, {
        'role': 'assistant',
        'content': 'Finished the game.',
        'delegate_id': 'run',
        'delegate_context': child,
        'delegate_status': 'returned',
      }, external: true);
      await tester.pump();
      expect(find.text('Finished the game.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('delegate.open:run:returned')),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );

  testWidgets('task continuation uses its lane and keeps failed draft', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final chat = await store.create();
    final host = TopicHost(store);
    final key = GlobalKey<LocalChatPanelState>();
    final delivered = <String>[];
    host.error = 'provider_credential_missing';
    host.errorConversationId = chat;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            key: key,
            host: host,
            conversationId: chat,
            onTaskText: (text, approve) async {
              delivered.add(text);
              throw StateError('delegate_busy');
            },
          ),
        ),
      ),
    );
    expect(find.text('自配模型缺少有效密钥，请检查模型设置。'), findsOneWidget);
    key.currentState!.input.text = 'Add touch controls';
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(delivered, ['Add touch controls']);
    expect(host.delivered, isEmpty);
    expect(key.currentState!.input.text, 'Add touch controls');
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
  testWidgets('large delegate output remains bounded on small voice panel', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    final worker = AgentCoreHost(store: store, settings: host.settings)
      ..draft = List.filled(300, 'long output').join('\n');
    final bridge = VoiceDelegateBridge(primary: host, worker: worker)
      ..id = 'task';
    final audio = VoiceAudio();
    final session = PhoneVoiceSession(
      audio: audio,
      requestMicrophone: () async => true,
      store: store,
      delegates: bridge,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PhoneVoicePanel(
            petAvatar: PetAvatarStore(),
            session: session,
            onSettings: () {},
            onStart: () {},
          ),
        ),
      ),
    );
    await tester.ensureVisible(find.text('任务进行中'));
    await tester.tap(find.text('任务进行中'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('停止任务'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    session.dispose();
    bridge.dispose();
    host.dispose();
    await audio.controller.close();
  });

  testWidgets('during a call the row keeps only attach and the shared key', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final chat = await store.create();
    final host = TopicHost(store);
    host.release.complete();
    for (final inCall in [false, true]) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: chat,
              onVoice: () {},
              externalTaskBusy: true,
              onCancelExternalTask: () {},
              onVoiceText: inCall ? (_) async {} : null,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byTooltip('实时语音'), inCall ? findsNothing : findsOneWidget);
      expect(find.byTooltip('停止任务'), findsOneWidget);
    }
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
}
