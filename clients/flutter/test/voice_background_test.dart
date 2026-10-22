import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_companion.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'phone_voice_session_test.dart'
    show VoiceAudio, TestVoiceProvider, settle;

class FakeCompanion implements VoiceCompanion {
  final events = StreamController<String>.broadcast(sync: true);
  Completer<void>? acquiring;
  bool fail = false, failStop = false;
  int starts = 0, stops = 0;
  final states = <bool>[];
  @override
  Stream<String> get actions => events.stream;
  @override
  Future<void> start() async {
    starts++;
    await acquiring?.future;
    if (fail) throw StateError('native_unavailable');
  }

  @override
  Future<void> stop() async {
    stops++;
    if (failStop) throw StateError('native_stop_failed');
  }

  @override
  Future<void> update({required bool muted}) async {
    states.add(muted);
  }

  @override
  Future<bool> minimize() async => true;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeCompanion companion;
  late VoiceAudio audio;
  late TestVoiceProvider provider;
  late PhoneVoiceSession session;
  late String conversation;
  setUp(() async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    conversation = await store.create();
    companion = FakeCompanion();
    audio = VoiceAudio();
    provider = TestVoiceProvider();
    session = PhoneVoiceSession(
      audio: audio,
      requestMicrophone: () async => true,
      store: store,
      companion: companion,
    );
  });
  tearDown(() async {
    await session.stop();
    session.dispose();
    await settle();
    await companion.events.close();
    await audio.controller.close();
    await provider.controller.close();
  });
  Future<void> start() =>
      session.start(provider: provider, conversation: conversation);
  test('background keeps capture and provider until explicit end', () async {
    await start();
    session.didChangeAppLifecycleState(AppLifecycleState.paused);
    await settle();
    expect(session.active, isTrue);
    expect(provider.closes, 0);
    await session.stop();
    expect(companion.stops, 1);
    expect(provider.closes, 1);
  });
  test('companion cleanup failure preserves the original call error', () async {
    await start();
    companion.failStop = true;
    provider.controller.addError(StateError('provider_failed'));
    await session.stop();
    expect(session.error, 'provider_failed');
    expect(session.cleanupError, 'call_stop_failed');
    expect(provider.closes, 1);
  });
  test('stop during native acquisition cannot leak a late service', () async {
    companion.acquiring = Completer<void>();
    final starting = start();
    await settle();
    final stopping = session.stop();
    companion.acquiring!.complete();
    await starting;
    await stopping;
    expect(session.active, isFalse);
    expect(companion.stops, 1);
    expect(audio.generation, isNull);
  });
  test(
    'failed native acquisition cleans up and never starts capture',
    () async {
      companion.fail = true;
      await start();
      expect(session.active, isFalse);
      expect(companion.stops, 1);
      expect(audio.generation, isNull);
    },
  );
  test(
    'native controls mute the same microphone and end the same call',
    () async {
      await start();
      companion.events.add('mute');
      await settle();
      expect(session.muted, isTrue);
      expect(audio.muteRequests, [true]);
      expect(companion.states.last, isTrue);
      companion.events.add('end');
      await settle();
      expect(session.active, isFalse);
      expect(companion.stops, 1);
    },
  );
  test(
    'background during provider connection cancels before microphone starts',
    () async {
      provider.connecting = Completer<void>();
      final starting = start();
      await settle();
      session.didChangeAppLifecycleState(AppLifecycleState.paused);
      await settle();
      final stillConnecting = session.connecting;
      provider.connecting!.complete();
      await starting;
      await settle();
      expect(stillConnecting, isFalse);
      expect(audio.startCount, 0);
      expect(companion.stops, 1);
    },
  );
  test('detached engine ends even a retained call', () async {
    await start();
    session.didChangeAppLifecycleState(AppLifecycleState.detached);
    await settle();
    expect(session.active, isFalse);
    expect(companion.stops, 1);
  });
}
