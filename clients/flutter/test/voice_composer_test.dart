import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'phone_voice_session_test.dart' show VoiceAudio;

void main() {
  testWidgets(
    'ordinary composer stops external task with an empty draft; failed voice send preserves text visibly',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final chat = await store.create();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
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
      await tester.tap(find.byTooltip('停止'));
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
