import 'dart:async';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class DelayedSettings extends ModelSettings {
  final gate = Completer<ModelConfiguration?>();
  @override
  Future<ModelConfiguration?> read() => gate.future;
}

class RecordingHost extends AgentCoreHost {
  RecordingHost(ConversationStore store)
    : super(store: store, settings: ModelSettings());
  int cancellations = 0;
  @override
  void cancel() {
    cancellations++;
  }
}

void main() {
  testWidgets(
    'sending in another chat does not stop a busy task or lose draft',
    (tester) async {
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final first = await store.create(), second = await store.create();
      final host = RecordingHost(store)
        ..busy = true
        ..activeConversationId = first;
      final key = GlobalKey<LocalChatPanelState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: second,
              language: 'en',
            ),
          ),
        ),
      );
      key.currentState!.input.text = 'Keep for later';
      await tester.pump();
      expect(find.byTooltip('Stop'), findsNothing);
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      expect(host.cancellations, 0);
      expect(key.currentState!.input.text, 'Keep for later');
      expect(find.textContaining('Another task is running'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );

  testWidgets('failed send returns draft to its origin after switching chats', (
    tester,
  ) async {
    final store = ConversationStore(MemoryLifePersistence());
    await store.open();
    final first = await store.create(), second = await store.create();
    final settings = DelayedSettings();
    final host = AgentCoreHost(store: store, settings: settings);
    final key = GlobalKey<LocalChatPanelState>();
    Widget panel(String id) => MaterialApp(
      home: Scaffold(
        body: LocalChatPanel(
          key: key,
          host: host,
          conversationId: id,
          language: 'en',
        ),
      ),
    );
    await tester.pumpWidget(panel(first));
    key.currentState!.input.text = 'Original request';
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    await tester.pumpWidget(panel(second));
    settings.gate.complete(null);
    await tester.pumpAndSettle();
    expect(key.currentState!.input.text, isEmpty);
    await tester.pumpWidget(panel(first));
    expect(key.currentState!.input.text, 'Original request');
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
  testWidgets('voice completion cannot clear identical text in another chat', (
    tester,
  ) async {
    final store = ConversationStore(MemoryLifePersistence());
    await store.open();
    final first = await store.create(), second = await store.create();
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    final gate = Completer<void>();
    final key = GlobalKey<LocalChatPanelState>();
    Widget panel(String id) => MaterialApp(
      home: Scaffold(
        body: LocalChatPanel(
          key: key,
          host: host,
          conversationId: id,
          language: 'en',
          onVoiceText: (_) => gate.future,
        ),
      ),
    );
    await tester.pumpWidget(panel(first));
    key.currentState!.input.text = 'Same text';
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpWidget(panel(second));
    key.currentState!.input.text = 'Same text';
    gate.complete();
    await tester.pump();
    expect(key.currentState!.input.text, 'Same text');
    await tester.pumpWidget(panel(first));
    expect(key.currentState!.input.text, isEmpty);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
}
