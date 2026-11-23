import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/space_call_controller.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'space_call_controller_test.dart'
    show FakeMedia, FakeSignals, RecordingAudio;
import 'space_client_ui_test.dart' show ScriptedDictation;
import 'support/space_client_fixture.dart';

const _start = ValueKey('space.call.start');
const _panel = ValueKey('space.call.panel');
const _retry = ValueKey('space.call.retry');

/// A snapshot from the Host under [binding], optionally advertising voice.
Future<void> snapshot(
  WidgetTester tester,
  SpaceClientState state, {
  required String binding,
  List<String>? capabilities,
  int revision = 10,
  bool online = true,
}) async {
  state.capabilityBinding = binding;
  await tester.runAsync(
    () => state.apply({
      'v': 1,
      'type': 'snapshot',
      'snapshot': {
        'schema_version': 1,
        'revision': revision,
        'goals': [],
        'todos': [],
        'ideas': [],
        'chat': [],
        'host_capabilities': ?capabilities,
      },
    }),
  );
  // The fake controller's background sync cannot reach a relay; presence is set here.
  state.hostOnline = online;
  state.changed();
  await tester.pump();
}

class CallRig {
  final signals = FakeSignals();
  final media = FakeMedia();
  final audio = RecordingAudio();
  bool microphone = true;
  SpaceCallController? call;
  ScriptedDictation? dictation;
  SpaceCallController create(_) => call = SpaceCallController(
    signals: signals,
    media: media,
    audio: audio,
    audioOwner: AudioOwner(),
    requestMicrophone: () async => microphone,
  );
}

Future<CallRig> pumpCall(WidgetTester tester, SpaceClientState state) async {
  final rig = CallRig();
  await pumpClient(
    tester,
    state,
    createCall: rig.create,
    createDictation: (onText) => rig.dictation = ScriptedDictation(onText),
  );
  return rig;
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
  }
}

void main() {
  setUpAll(
    () => loadSpaceTestFonts(cjk: Platform.environment['NOVA_CLIENT_CJK_FONT']),
  );

  testWidgets(
    'old Host without host_capabilities: no call button, composer and dictation unchanged',
    (tester) async {
      final state = seededState();
      await pumpCall(tester, state);
      await snapshot(tester, state, binding: 'host|2|relay');
      expect(find.byKey(_start), findsNothing);
      expect(find.byKey(const ValueKey('space.dictation.mic')), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
    },
  );

  testWidgets(
    'a stale capability (Host, epoch or relay changed) hides the call until a fresh snapshot',
    (tester) async {
      final state = seededState();
      await pumpCall(tester, state);
      await snapshot(
        tester,
        state,
        binding: 'host|2|relay',
        capabilities: ['voice.v1'],
      );
      expect(find.byKey(_start), findsOneWidget);
      state.capabilityBinding = 'host|3|relay';
      state.changed();
      await tester.pump();
      expect(find.byKey(_start), findsNothing);
      await snapshot(
        tester,
        state,
        binding: 'host|3|relay',
        capabilities: ['voice.v1'],
        revision: 11,
      );
      expect(find.byKey(_start), findsOneWidget);
      // A capability for another feature or an empty list never shows the call.
      await snapshot(
        tester,
        state,
        binding: 'host|3|relay',
        capabilities: [],
        revision: 12,
      );
      expect(find.byKey(_start), findsNothing);
    },
  );

  testWidgets('Host offline disables the call button', (tester) async {
    final state = seededState(online: false);
    await pumpCall(tester, state);
    await snapshot(
      tester,
      state,
      binding: 'b',
      capabilities: ['voice.v1'],
      online: false,
    );
    expect(tester.widget<IconButton>(find.byKey(_start)).onPressed, isNull);
  });

  testWidgets(
    'call panel: calling, refusal reason with a visible Retry, and no automatic dictation',
    (tester) async {
      final state = seededState();
      final rig = await pumpCall(tester, state);
      await snapshot(tester, state, binding: 'b', capabilities: ['voice.v1']);
      await tester.tap(find.byKey(_start));
      await settle(tester);
      expect(find.byKey(_panel), findsOneWidget);
      expect(find.text('正在呼叫 Host…'), findsOneWidget);
      expect(rig.signals.intents.single['kind'], 'voice.start');
      // Called in the test zone: the call's futures were created there.
      unawaited(
        rig.call!.onHostMessage({
          'v': 1,
          'type': 'receipt',
          'op_id': rig.call!.opId,
          'status': 'rejected',
          'error': 'voice_active',
        }),
      );
      await settle(tester);
      expect(find.text('Host 上已有其他语音通话'), findsOneWidget);
      expect(
        tester.widget<TextButton>(find.byKey(_retry)).onPressed,
        isNotNull,
      );
      // The typed composer stays usable and dictation never starts on its own.
      expect(
        tester.widget<TextField>(find.byType(TextField)).enabled,
        isNot(false),
      );
      expect(rig.dictation!.recording, isFalse);
      await tester.tap(find.byKey(_retry));
      await settle(tester);
      expect(
        rig.signals.intents.where((i) => i['kind'] == 'voice.start').length,
        2,
      );
      expect(
        rig.signals.intents.first['input']['eph'],
        isNot(rig.signals.intents.last['input']['eph']),
        reason: 'Retry is a fresh handshake with new ephemerals',
      );
      await tester.tap(find.byKey(const ValueKey('space.call.end')));
      await settle(tester);
      expect(find.text('通话已结束'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('space.call.dismiss')));
      await tester.pump();
      expect(find.byKey(_panel), findsNothing);
    },
  );

  testWidgets(
    'microphone denied fails locally before voice.start and shows the permission hint',
    (tester) async {
      final state = seededState();
      final rig = await pumpCall(tester, state);
      rig.microphone = false;
      await snapshot(tester, state, binding: 'b', capabilities: ['voice.v1']);
      await tester.tap(find.byKey(_start));
      await settle(tester);
      expect(find.text('没有麦克风权限，请在系统设置中允许'), findsOneWidget);
      expect(rig.signals.intents, isEmpty);
    },
  );
}
