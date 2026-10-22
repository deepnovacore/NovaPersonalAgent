import 'dart:async';
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
import 'phone_voice_session_test.dart' show TestVoiceProvider;
import 'support/fake_audio.dart';

Future<({AgentCoreHost host, FakeAudio audio})> openChat(
  WidgetTester tester, {
  VoiceConfiguration? voiceConfiguration,
  FakeAudio? testAudio,
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
  final audio = testAudio ?? FakeAudio();
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

class DelayedStopAudio extends FakeAudio {
  Completer<void>? stopGate;
  bool failStop = false;

  @override
  Future<void> stop() async {
    await super.stop();
    await stopGate?.future;
    if (failStop) throw StateError('native_stop_failed');
  }
}

void main() {
  testWidgets('voice controls do not rebuild the chat shell', (
    tester,
  ) async {
    await openChat(tester);
    await tester.tap(find.byTooltip('Live voice'));
    await tester.pumpAndSettle();
    final call = tester
        .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
        .session;
    call.active = true;
    call.error = null;
    await call.toggleMute();
    await tester.pump();
    final chatFinder = find.byType(LocalChatPanel, skipOffstage: false);
    final shellBefore = tester.widget<LocalChatPanel>(chatFinder);
    expect(shellBefore.voiceBusy, isTrue);
    expect(shellBefore.onVoiceText, isNotNull);
    expect(find.byTooltip('Unmute'), findsOneWidget);
    await call.toggleMute();
    await tester.pump();
    expect(find.byTooltip('Mute'), findsOneWidget);
    expect(tester.widget<LocalChatPanel>(chatFinder), same(shellBefore));
    await call.toggleSpeaker();
    await tester.pump();
    expect(tester.widget<LocalChatPanel>(chatFinder), same(shellBefore));
    final stopping = call.stop();
    await tester.pumpAndSettle();
    await stopping;
    final shellAfter = tester.widget<LocalChatPanel>(chatFinder);
    expect(shellAfter.voiceBusy, isFalse);
    expect(shellAfter.onVoiceText, isNull);
    expect(find.byKey(const ValueKey('voice-fullscreen')), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

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

  for (final compact in [false, true]) {
    testWidgets(
      '${compact ? 'compact' : 'fullscreen'} hangup returns to the draft before audio shutdown completes',
      (tester) async {
        final audio = DelayedStopAudio();
        await openChat(tester, testAudio: audio);
        final original = tester.state<LocalChatPanelState>(
          find.byType(LocalChatPanel),
        );
        await tester.tap(find.byTooltip('Live voice'));
        await tester.pumpAndSettle();
        final call = tester
            .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
            .session;
        call.active = true;
        call.error = null;
        await call.audio.startRelay(
          generation: 1,
          capture: true,
          threshold: .045,
        );
        await call.toggleMute();
        await tester.pump();
        if (compact) {
          await tester.tap(find.byTooltip('Minimize call'));
          await tester.pumpAndSettle();
          expect(call.active, isTrue);
        }
        final stoppedBefore = audio.stopCount;
        final gate = audio.stopGate = Completer<void>();
        addTearDown(() {
          if (!gate.isCompleted) gate.complete();
        });
        await tester.tap(find.byTooltip('End call'));
        await tester.pump();
        expect(find.byKey(const ValueKey('voice-fullscreen')), findsNothing);
        expect(find.byKey(const ValueKey('voice-compact-bar')), findsNothing);
        expect(
          tester.state<LocalChatPanelState>(find.byType(LocalChatPanel)),
          same(original),
        );
        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          'Keep this unsent draft',
        );
        expect(audio.stopCount, stoppedBefore + 1);
        expect(gate.isCompleted, isFalse);
        gate.complete();
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }

  testWidgets(
    'external session hangup closes an active call before cleanup completes',
    (tester) async {
      final audio = DelayedStopAudio();
      await openChat(tester, testAudio: audio);
      await tester.tap(find.byTooltip('Live voice'));
      await tester.pumpAndSettle();
      final call = tester
          .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
          .session;
      call.active = true;
      call.error = null;
      await call.audio.startRelay(
        generation: 1,
        capture: true,
        threshold: .045,
      );
      await call.toggleMute();
      await tester.pump();
      final gate = audio.stopGate = Completer<void>();
      addTearDown(() {
        if (!gate.isCompleted) gate.complete();
      });
      final stopping = call.stop();
      await tester.pump();
      expect(find.byKey(const ValueKey('voice-fullscreen')), findsNothing);
      expect(find.byKey(const ValueKey('voice-compact-bar')), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Keep this unsent draft',
      );
      expect(gate.isCompleted, isFalse);
      gate.complete();
      await stopping;
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'cleanup failure is visible after hangup and again on the next call',
    (tester) async {
      final audio = DelayedStopAudio();
      await openChat(tester, testAudio: audio);
      await tester.tap(find.byTooltip('Live voice'));
      await tester.pumpAndSettle();
      final call = tester
          .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
          .session;
      call.active = true;
      call.error = 'provider_failed';
      await call.audio.startRelay(
        generation: 1,
        capture: true,
        threshold: .045,
      );
      await call.toggleMute();
      await tester.pump();
      final gate = audio.stopGate = Completer<void>();
      addTearDown(() {
        if (!gate.isCompleted) gate.complete();
      });
      audio.failStop = true;
      await tester.tap(find.byTooltip('End call'));
      await tester.pump();
      expect(find.byKey(const ValueKey('voice-fullscreen')), findsNothing);
      expect(find.byType(LocalChatPanel), findsOneWidget);
      const message =
          'Call cleanup failed. Your microphone or call service may still be running.';
      expect(find.text(message), findsNothing);
      gate.complete();
      await tester.pumpAndSettle();
      expect(call.error, 'provider_failed');
      expect(find.text(message), findsOneWidget);
      final messenger = tester.state<ScaffoldMessengerState>(
        find.byType(ScaffoldMessenger),
      );
      messenger.removeCurrentSnackBar();
      await call.stop();
      await tester.pumpAndSettle();
      expect(find.text(message), findsNothing);

      final next = TestVoiceProvider();
      await call.start(
        provider: next,
        conversation: call.conversationId!,
      );
      await tester.pumpAndSettle();
      expect(find.text(message), findsOneWidget);
      audio.failStop = false;
      await call.audio.stop();
      await next.controller.close();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'an interrupted active call keeps its error and restart controls visible',
    (tester) async {
      await openChat(tester);
      await tester.tap(find.byTooltip('Live voice'));
      await tester.pumpAndSettle();
      final call = tester
          .widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel))
          .session;
      call.active = true;
      call.error = null;
      await call.toggleMute();
      await tester.pump();
      call.error = 'audio_stopped';
      await call.stop();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('voice-fullscreen')), findsOneWidget);
      expect(
        find.text('Device audio was interrupted. Please restart the call.'),
        findsOneWidget,
      );
      expect(find.byTooltip('Voice settings'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

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
