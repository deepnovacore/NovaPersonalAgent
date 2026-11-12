import 'dart:async';
import 'package:flutter/material.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
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

void main() {
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
    'background task stop is separate from the main send button; failed voice send keeps draft',
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
      key.currentState!.input.text = 'Continue our conversation';
      await tester.pump();
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
    expect(find.text('自配模型缺少有效密钥，请检查模型设置。'), findsNothing);
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
}
