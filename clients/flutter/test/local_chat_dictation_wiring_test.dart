import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

import 'agent_core_test.dart' show MemoryPersistence;
import 'support/fake_audio.dart';

class _ComposerFixture {
  final audio = FakeAudio();
  final owner = AudioOwner();
  final key = GlobalKey<LocalChatPanelState>();
  late final ConversationStore store;
  late final AgentCoreHost host;
  late final String first, second;
  int microphoneRequests = 0;

  Future<void> open() async {
    store = ConversationStore(MemoryPersistence());
    await store.open();
    first = await store.create();
    second = await store.create();
    host = AgentCoreHost(store: store, settings: ModelSettings());
  }

  Widget panel(String conversation) => MaterialApp(
    home: Scaffold(
      body: LocalChatPanel(
        key: key,
        host: host,
        conversationId: conversation,

        audioOwner: owner,
        dictationAudio: audio,
        requestMicrophone: () async {
          microphoneRequests++;
          return true;
        },
      ),
    ),
  );

  Future<TestGesture> record(WidgetTester tester) async {
    final gesture = await tester.startGesture(
      tester.getCenter(find.byIcon(CupertinoIcons.mic_fill)),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(key.currentState!.dictation!.recording, true);
    return gesture;
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    host.dispose();
    await audio.controller.close();
  }
}

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      VoiceSettings.storageKey: jsonEncode(
        const VoiceConfiguration(
          asr: VoiceServiceConfiguration(
            endpoint: 'https://example.com/v1beta',
            model: 'fixture-asr',
            key: 'fixture-key',
          ),
        ).toJson(),
      ),
    });
  });

  testWidgets('opening the local composer never requests microphone access', (
    tester,
  ) async {
    final fixture = _ComposerFixture();
    await fixture.open();
    await tester.pumpWidget(fixture.panel(fixture.first));
    await tester.pumpAndSettle();
    expect(find.byIcon(CupertinoIcons.mic_fill), findsOneWidget);
    expect(fixture.microphoneRequests, 0);
    expect(fixture.audio.startCount, 0);
    expect(fixture.key.currentState!.dictation!.busy, false);
    expect(fixture.store.conversation(fixture.first)['messages'], isEmpty);
    await fixture.close(tester);
  });

  testWidgets('recording disables sending an existing draft without autosend', (
    tester,
  ) async {
    final fixture = _ComposerFixture();
    await fixture.open();
    await tester.pumpWidget(fixture.panel(fixture.first));
    await tester.pumpAndSettle();
    fixture.key.currentState!.input.text = 'Keep my existing draft';
    await tester.pump();
    final gesture = await fixture.record(tester);
    final send = find.widgetWithIcon(IconButton, CupertinoIcons.arrow_up);
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    expect(fixture.key.currentState!.input.text, 'Keep my existing draft');
    expect(fixture.store.conversation(fixture.first)['messages'], isEmpty);
    expect(fixture.host.busy, false);
    await fixture.key.currentState!.cancelDictation();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(fixture.audio.stopCount, 1);
    expect(fixture.key.currentState!.input.text, 'Keep my existing draft');
    expect(fixture.store.conversation(fixture.first)['messages'], isEmpty);
    expect(tester.widget<IconButton>(send).onPressed, isNotNull);
    await fixture.close(tester);
  });

  testWidgets('switching chats cancels recording and preserves each draft', (
    tester,
  ) async {
    final fixture = _ComposerFixture();
    await fixture.open();
    await tester.pumpWidget(fixture.panel(fixture.second));
    await tester.pumpAndSettle();
    fixture.key.currentState!.input.text = 'Second chat draft';
    await tester.pumpWidget(fixture.panel(fixture.first));
    await tester.pumpAndSettle();
    fixture.key.currentState!.input.text = 'First chat draft';
    final gesture = await fixture.record(tester);
    await tester.pumpWidget(fixture.panel(fixture.second));
    expect(fixture.key.currentState!.dictation!.busy, false);
    await tester.pumpAndSettle();
    expect(fixture.audio.stopCount, 1);
    expect(fixture.key.currentState!.input.text, 'Second chat draft');
    await gesture.up();
    await tester.pumpAndSettle();
    expect(fixture.key.currentState!.input.text, 'Second chat draft');
    expect(fixture.store.conversation(fixture.first)['messages'], isEmpty);
    expect(fixture.store.conversation(fixture.second)['messages'], isEmpty);
    await tester.pumpWidget(fixture.panel(fixture.first));
    await tester.pumpAndSettle();
    expect(fixture.key.currentState!.input.text, 'First chat draft');
    expect(fixture.microphoneRequests, 1);
    expect(fixture.audio.startCount, 1);
    await fixture.close(tester);
  });
}
