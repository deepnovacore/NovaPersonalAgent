import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';

Future<({AgentCoreHost host, FakeAudio audio})> openChat(
  WidgetTester tester, {
  VoiceConfiguration? voiceConfiguration,
}) async {
  SharedPreferences.setMockInitialValues({'language': 'en'});
  final configuration =
      voiceConfiguration ??
      const VoiceConfiguration().copyWith(
        integrated: const VoiceConfiguration().integrated.copyWith(
          endpoint: 'wss://voice.example.invalid/realtime',
          key: 'synthetic-test-key',
        ),
      );
  FlutterSecureStorage.setMockInitialValues({
    VoiceSettings.storageKey: jsonEncode(configuration.toJson()),
  });
  final audio = FakeAudio();
  // Permission is denied before any provider connects or native capture starts.
  final audioConfig = (audio: audio, requestMicrophone: () async => false);
  final store = ConversationStore(MemoryLifePersistence());
  await store.open();
  final host = AgentCoreHost(store: store, settings: ModelSettings());

  addTearDown(host.dispose);
  await tester.pumpWidget(
    NovaApp(
      audio: audioConfig.audio,
      requestMicrophone: audioConfig.requestMicrophone,
      agentCore: host,

      preferences: Preferences(await SharedPreferences.getInstance()),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('New chat'));
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextField), 'Keep this unsent draft');
  return (host: host, audio: audio);
}

void main() {
  for (final useBack in [false, true]) {
    testWidgets(
      'fullscreen call hides chat and tabs; ${useBack ? 'back' : 'minimize'} preserves mounted draft',
      (tester) async {
        final fixture = await openChat(tester);
        final chatBefore = tester.state<LocalChatPanelState>(
          find.byType(LocalChatPanel),
        );
        final controllerBefore = tester
            .widget<TextField>(find.byType(TextField))
            .controller;
        final conversationBefore =
            fixture.host.store.conversations.single['id'];
        await tester.tap(find.byTooltip('Live voice'));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('voice-fullscreen')), findsOneWidget);
        expect(find.byType(LocalChatPanel), findsNothing);
        expect(find.byType(BottomAppBarTabs), findsNothing);
        expect(find.byTooltip('All conversations'), findsNothing);
        expect(find.text('Keep this unsent draft'), findsNothing);
        expect(
          tester.state<LocalChatPanelState>(
            find.byType(LocalChatPanel, skipOffstage: false),
          ),
          same(chatBefore),
        );
        expect(fixture.audio.startCount, 0);
        if (useBack) {
          await tester.binding.handlePopRoute();
        } else {
          await tester.tap(find.byTooltip('Minimize call'));
        }
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('voice-fullscreen')), findsNothing);
        expect(find.byType(LocalChatPanel), findsOneWidget);
        expect(find.byType(BottomAppBarTabs), findsOneWidget);
        expect(
          tester.state<LocalChatPanelState>(find.byType(LocalChatPanel)),
          same(chatBefore),
        );
        final field = tester.widget<TextField>(find.byType(TextField));
        expect(field.controller, same(controllerBefore));
        expect(field.controller!.text, 'Keep this unsent draft');
        expect(
          fixture.host.store.conversations.single['id'],
          conversationBefore,
        );
        expect(fixture.host.store.conversations.single['messages'], isEmpty);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      },
    );
  }

  testWidgets(
    'startup configuration failure is visible inside fullscreen call',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final invalid = const VoiceConfiguration().copyWith(
        integrated: const VoiceConfiguration().integrated.copyWith(
          endpoint: 'http://voice.example.invalid/realtime',
          key: 'synthetic-test-key',
        ),
      );
      final fixture = await openChat(tester, voiceConfiguration: invalid);
      await tester.tap(find.byTooltip('Live voice'));
      await tester.pumpAndSettle();
      final fullscreen = find.byKey(const ValueKey('voice-fullscreen'));
      const message =
          'Voice unavailable. Check settings or wait for the text task.';
      expect(fullscreen, findsOneWidget);
      expect(
        find.descendant(of: fullscreen, matching: find.text(message)),
        findsOneWidget,
      );
      expect(find.text(message).hitTestable(), findsOneWidget);
      expect(find.byType(SnackBar), findsNothing);
      expect(find.byType(LocalChatPanel), findsNothing);
      expect(find.byType(BottomAppBarTabs), findsNothing);
      final panel = tester.widget<PhoneVoicePanel>(
        find.byType(PhoneVoicePanel),
      );
      expect(panel.startupError, message);
      expect(panel.session.active, isFalse);
      expect(panel.session.connecting, isFalse);
      expect(fixture.audio.startCount, 0);
      expect(find.byTooltip('Voice settings'), findsOneWidget);
      await tester.tap(find.byTooltip('Minimize call'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Keep this unsent draft',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    },
  );

  testWidgets('active compact call resumes fullscreen without recreating chat', (
    tester,
  ) async {
    await openChat(tester);
    final original = tester.state<LocalChatPanelState>(
      find.byType(LocalChatPanel),
    );
    await tester.tap(find.byTooltip('Live voice'));
    await tester.pumpAndSettle();
    final call = tester
        .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
        .session;
    // Synthetic presentation state only. The permission-denied call has already
    // stopped; no provider connection or native recording is performed here.
    call.active = true;
    call.error = null;
    await tester.tap(find.byTooltip('Minimize call'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('voice-compact-bar')), findsOneWidget);
    expect(find.byType(LocalChatPanel), findsOneWidget);
    expect(find.byType(BottomAppBarTabs), findsOneWidget);
    expect(find.byKey(const ValueKey('voice-captions')), findsNothing);
    expect(
      tester.state<LocalChatPanelState>(find.byType(LocalChatPanel)),
      same(original),
    );
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Keep this unsent draft',
    );
    await tester.tap(find.textContaining('Nova ·'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('voice-fullscreen')), findsOneWidget);
    expect(find.byKey(const ValueKey('voice-compact-bar')), findsNothing);
    expect(find.byType(LocalChatPanel), findsNothing);
    expect(
      tester.state<LocalChatPanelState>(
        find.byType(LocalChatPanel, skipOffstage: false),
      ),
      same(original),
    );
    await tester.tap(find.byTooltip('Minimize call'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Keep this unsent draft',
    );
    call.active = false;
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
