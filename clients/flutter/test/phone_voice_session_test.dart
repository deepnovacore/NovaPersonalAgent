import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/protocol/wire.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'support/fake_audio.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class VoiceAudio extends FakeAudio {
  int? generation;
  bool failEnqueueOnce = false;
  Completer<void>? stopping, muting, switchingSpeaker;
  final muteRequests = <bool>[], speakerRequests = <bool>[];
  @override
  Future<void> mute(bool value) async {
    muteRequests.add(value);
    if (muting != null) await muting!.future;
  }

  @override
  Future<void> setSpeaker(bool value) async {
    speakerRequests.add(value);
    if (switchingSpeaker != null) await switchingSpeaker!.future;
  }

  @override
  Future<void> stop() async {
    if (stopping != null) await stopping!.future;
    await super.stop();
  }

  final frames = <AudioFrame>[];
  final cleared = <PlaybackIdentity>[];
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    this.generation = generation;
    await super.startRelay(
      generation: generation,
      capture: capture,
      threshold: threshold,
    );
  }

  @override
  Future<void> enqueue(Uint8List f) async {
    if (failEnqueueOnce) {
      failEnqueueOnce = false;
      throw StateError('native');
    }
    frames.add(Wire.audio(f));
  }

  @override
  Future<void> clear(String u, int e) async {
    cleared.add(PlaybackIdentity(u, e));
  }
}

class TestVoiceProvider implements VoiceProvider {
  final controller = StreamController<VoiceEvent>.broadcast(sync: true);
  int epoch = 0, closes = 0, requests = 0;
  final cancels = <String>[], playback = <int>[];
  List<VoiceHistoryItem> history = [];
  String instructions = '';
  Completer<void>? connecting;
  Completer<void>? injecting;
  final injected = <String>[],
      submitted = <String>[],
      requestedItems = <String>[];
  bool busyActivation = false, failText = false;
  @override
  VoiceCapabilities capabilities = const VoiceCapabilities(
    automaticResponse: true,
    serverEndpointing: true,
    history: true,
    playbackReport: true,
    hostItems: true,
    hostItemAcknowledged: true,
  );
  @override
  Stream<VoiceEvent> get events => controller.stream;
  @override
  Future<void> connect({
    required int epoch,
    required String instructions,
    List<VoiceHistoryItem> history = const [],
    List<Map<String, dynamic>> tools = const [],
  }) async {
    this.epoch = epoch;
    this.history = history;
    this.instructions = instructions;
    if (connecting != null) await connecting!.future;
  }

  void emit(
    VoiceEventKind kind, {
    String? id,
    String? item,
    String? text,
    bool finalText = false,
    bool? hostOrigin,
    Uint8List? pcm,
  }) => controller.add(
    VoiceEvent(
      kind,
      epoch: epoch,
      responseId: id,
      itemId: item,
      text: text,
      isFinal: finalText,
      hostOrigin: hostOrigin,
      pcm: pcm,
    ),
  );
  @override
  Future<void> sendAudio(Uint8List pcm16) async {}
  @override
  Future<void> submitText(String text) async {
    if (failText) throw StateError('busy');
    submitted.add(text);
  }

  @override
  Future<void> cancelResponse(String responseId) async {
    cancels.add(responseId);
  }

  @override
  Future<void> injectHostItem(VoiceHostItem item) async {
    injected.add(item.id);
    if (injecting != null) await injecting!.future;
    emit(VoiceEventKind.hostAck, item: item.id);
  }

  @override
  Future<Set<String>> requestHostResponse(String itemId) async {
    requests++;
    if (busyActivation) throw VoiceHostBusy('busy');
    requestedItems.add(itemId);
    return {itemId};
  }

  @override
  Future<void> reportPlayback(
    String responseId,
    int playedMs, {
    required bool interrupted,
  }) async {
    playback.add(playedMs);
  }

  @override
  Future<void> close() async {
    closes++;
  }
}

Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class FactBridge extends VoiceDelegateBridge {
  FactBridge(AgentCoreHost host)
    : super(
        primary: host,
        worker: AgentCoreHost(store: host.store, settings: host.settings),
      );
  int starts = 0;
  String? receivedLanguage;
  @override
  Future<String> start({
    required String conversation,
    required String callId,
    required String request,
    String language = 'zh',
  }) async {
    starts++;
    receivedLanguage = language;
    return 'accepted';
  }

  final facts = StreamController<VoiceDelegateUpdate>.broadcast(sync: true);
  @override
  Stream<VoiceDelegateUpdate> get updates => facts.stream;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ConversationStore store;
  late String conversation;
  late VoiceAudio audio;
  late TestVoiceProvider provider;
  late PhoneVoiceSession session;
  setUp(() async {
    store = ConversationStore(MemoryPersistence());
    await store.open();
    conversation = await store.create();
    audio = VoiceAudio();
    provider = TestVoiceProvider();
    session = PhoneVoiceSession(
      audio: audio,
      requestMicrophone: () async => true,
      store: store,
    );
  });
  tearDown(() async {
    await session.stop();
    session.dispose();
    await provider.controller.close();
    await audio.controller.close();
  });
  Future<void> start() =>
      session.start(provider: provider, conversation: conversation);

  test(
    'automatic response uses real NOVA frame and render receipt, never creates duplicate response',
    () async {
      await start();
      provider.emit(VoiceEventKind.responseStart, id: 'r1');
      provider.emit(VoiceEventKind.text, id: 'r1', text: '你好');
      provider.emit(VoiceEventKind.audio, id: 'r1', pcm: Uint8List(480));
      provider.emit(VoiceEventKind.responseEnd, id: 'r1');
      await settle();
      expect(audio.frames, hasLength(1));
      expect(audio.frames.single.pcm, hasLength(480));
      expect(provider.requests, 0);
      final identity = audio.frames.single.identity;
      audio.controller.add({
        'kind': 'control',
        'generation': audio.generation,
        'control': {
          'type': 'playback.done',
          ...identity.fields,
          'played_ms': 10,
        },
      });
      await settle();
      expect(provider.playback, [10]);
      expect(
        (store.conversation(conversation)['messages'] as List)
            .last['voice_played_ms'],
        10,
      );
    },
  );
  test('native onset fences late queued audio and cancels only once', () async {
    await start();
    provider.emit(VoiceEventKind.responseStart, id: 'r1');
    await settle();
    provider.emit(VoiceEventKind.audio, id: 'r1', pcm: Uint8List(480));
    await settle();
    audio.controller.add({
      'kind': 'control',
      'generation': audio.generation,
      'control': {'type': 'speech.onset'},
    });
    provider.emit(VoiceEventKind.speechStart, item: 'speech2');
    provider.emit(VoiceEventKind.audio, id: 'r1', pcm: Uint8List(480));
    await settle();
    expect(audio.frames, hasLength(1));
    expect(provider.cancels, ['r1']);
    expect(audio.cleared, hasLength(1));
    expect(session.active, true);
  });
  test(
    'ASR final after assistant response stays before that response and duplicate final is idempotent',
    () async {
      await start();
      provider.emit(VoiceEventKind.speechStart, item: 'speech1');
      provider.emit(VoiceEventKind.speechEnd, item: 'speech1');
      provider.emit(VoiceEventKind.responseStart, id: 'r1');
      provider.emit(VoiceEventKind.text, id: 'r1', text: 'answer');
      provider.emit(VoiceEventKind.responseEnd, id: 'r1');
      provider.emit(
        VoiceEventKind.transcript,
        item: 'speech1',
        text: 'question',
        finalText: true,
      );
      provider.emit(
        VoiceEventKind.transcript,
        item: 'speech1',
        text: 'question',
        finalText: true,
      );
      await settle();
      final messages = store.conversation(conversation)['messages'] as List;
      expect(messages.map((e) => e['role']).toList(), ['user', 'assistant']);
      expect(messages.first['content'], 'question');
    },
  );
  test(
    'stop during connect prevents late microphone start and stale events',
    () async {
      provider.connecting = Completer<void>();
      final starting = start();
      await settle();
      await session.stop();
      provider.connecting!.complete();
      await starting;
      provider.emit(VoiceEventKind.responseStart, id: 'late');
      provider.emit(VoiceEventKind.audio, id: 'late', pcm: Uint8List(480));
      await settle();
      expect(audio.startCount, 0);
      expect(audio.frames, isEmpty);
      expect(session.active, false);
    },
  );
  test(
    'unsupported audio format stops rather than playing corrupt data',
    () async {
      await start();
      provider.emit(VoiceEventKind.responseStart, id: 'r1');
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.audio,
          epoch: provider.epoch,
          responseId: 'r1',
          pcm: Uint8List(480),
          sampleRate: 16000,
        ),
      );
      await settle();
      expect(session.active, false);
      expect(audio.frames, isEmpty);
    },
  );
  test(
    'unowned PC shutdown never stops independent voice and generations remap',
    () async {
      final native = VoiceAudio(), owner = AudioOwner();
      final phone = OwnedAudioPort(native, owner),
          pc = OwnedAudioPort(native, owner);
      final events = <Map<String, Object?>>[];
      final subscription = phone.events.listen(events.add);
      await phone.startRelay(generation: 7, capture: true, threshold: .045);
      await pc.stop();
      expect(native.stopCount, 0);
      await expectLater(
        pc.startRelay(generation: 8, capture: true, threshold: .045),
        throwsStateError,
      );
      native.controller.add({
        'generation': native.generation,
        'kind': 'level',
        'level': .1,
      });
      expect(events.single['generation'], 7);
      await phone.stop();
      expect(native.stopCount, 1);
      await pc.startRelay(generation: 8, capture: true, threshold: .045);
      await phone.dispose();
      await pc.dispose();
      await subscription.cancel();
      await native.controller.close();
    },
  );
  test('start waits for the complete prior native shutdown', () async {
    await start();
    audio.stopping = Completer<void>();
    final stopped = session.stop();
    final next = TestVoiceProvider();
    final starting = session.start(provider: next, conversation: conversation);
    await settle();
    expect(next.epoch, 0);
    expect(audio.startCount, 1);
    audio.stopping!.complete();
    await stopped;
    await starting;
    expect(session.active, true);
    expect(audio.startCount, 2);
    await session.stop();
    await next.controller.close();
  });
  test('native enqueue failure does not poison the next call', () async {
    audio.failEnqueueOnce = true;
    await start();
    provider.emit(VoiceEventKind.responseStart, id: 'bad');
    provider.emit(VoiceEventKind.audio, id: 'bad', pcm: Uint8List(480));
    await settle();
    expect(session.active, false);
    final next = TestVoiceProvider();
    await session.start(provider: next, conversation: conversation);
    next.emit(VoiceEventKind.responseStart, id: 'good');
    next.emit(VoiceEventKind.audio, id: 'good', pcm: Uint8List(480));
    await settle();
    expect(session.active, true);
    expect(audio.frames, hasLength(1));
    await session.stop();
    await next.controller.close();
  });
  test(
    'typed interruption remains unsent until terminal and rejected send is not persisted',
    () async {
      await start();
      provider.emit(VoiceEventKind.responseStart, id: 'old');
      await settle();
      await expectLater(
        session.submitText('keep this draft'),
        throwsStateError,
      );
      expect(provider.submitted, isEmpty);
      expect(store.conversation(conversation)['messages'], isEmpty);
      provider.emit(VoiceEventKind.responseEnd, id: 'old');
      await settle();
      provider.failText = true;
      await expectLater(
        session.submitText('keep this draft'),
        throwsStateError,
      );
      expect(store.conversation(conversation)['messages'], isEmpty);
      provider.failText = false;
      await session.submitText('keep this draft');
      expect(provider.submitted, ['keep this draft']);
      expect(
        (store.conversation(conversation)['messages'] as List)
            .single['content'],
        'keep this draft',
      );
    },
  );
  test(
    '90 second batch is bounded by real render credit and cancellation releases blocked handoff',
    () async {
      await start();
      provider.emit(VoiceEventKind.responseStart, id: 'long');
      provider.emit(
        VoiceEventKind.audio,
        id: 'long',
        pcm: Uint8List(90 * 48000),
      );
      await settle();
      var accepted = audio.frames.fold<int>(0, (n, f) => n + f.pcm.length);
      expect(accepted, greaterThan(5 * 48000));
      expect(accepted, lessThanOrEqualTo(50 * 48000));
      final identity = audio.frames.first.identity;
      audio.controller.add({
        'kind': 'control',
        'generation': audio.generation,
        'control': {
          'type': 'playback.progress',
          ...identity.fields,
          'played_ms': 20000,
        },
      });
      await settle();
      final progressed = audio.frames.fold<int>(0, (n, f) => n + f.pcm.length);
      expect(progressed, greaterThan(accepted));
      expect(progressed, lessThanOrEqualTo(70 * 48000));
      await session.interruptPlayback();
      await settle();
      expect(audio.frames.fold<int>(0, (n, f) => n + f.pcm.length), progressed);
      expect(provider.cancels, ['long']);
      expect(session.active, true);
    },
  );
  test(
    'bridge attachment keeps call stable and acknowledged facts wait for speech without reinjection',
    () async {
      await start();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      expect(session.active, true);
      expect(audio.stopCount, 0);
      // Attaching a late bridge cannot retroactively register wire tools.
      expect(session.supportsVoiceDelegation, false);
      provider.injecting = Completer<void>();
      bridge.facts.add(
        VoiceDelegateUpdate('task', conversation, 'done', terminal: true),
      );
      await settle();
      provider.emit(VoiceEventKind.speechStart, item: 'speech');
      provider.injecting!.complete();
      await settle();
      expect(provider.requests, 0);
      provider.emit(VoiceEventKind.speechEnd);
      provider.emit(VoiceEventKind.responseStart, id: 'user');
      provider.emit(VoiceEventKind.responseEnd, id: 'user');
      await settle();
      expect(provider.requests, 1);
      expect(provider.injected, ['task:terminal']);
      final journal =
          store.conversation(conversation)['voice_deliveries'] as Map;
      expect(journal['task:terminal'], {
        'injection': 'acknowledged',
        'activation': 'requested',
      });
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'worker progress stays visual and only the terminal result requests speech',
    () async {
      await start();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      for (final text in [
        'Starting work',
        '正在调用 artifact_write',
        'Still working',
      ]) {
        bridge.facts.add(
          VoiceDelegateUpdate('task', conversation, text, terminal: false),
        );
        await settle();
      }
      expect(provider.injected, isEmpty);
      expect(provider.requests, 0);
      bridge.facts.add(
        VoiceDelegateUpdate('task', conversation, '作品已生成', terminal: true),
      );
      await settle();
      bridge.facts.add(
        VoiceDelegateUpdate(
          'task',
          conversation,
          'late progress',
          terminal: false,
        ),
      );
      bridge.facts.add(
        VoiceDelegateUpdate(
          'task',
          conversation,
          'duplicate terminal',
          terminal: true,
        ),
      );
      await settle();
      expect(provider.injected, ['task:terminal']);
      expect(provider.requests, 1);
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  for (final alreadyReplied in [true, false]) {
    test(
      'successful dispatch receipt speaks only when the frontbrain was silent: $alreadyReplied',
      () async {
        final host = AgentCoreHost(store: store, settings: ModelSettings());
        final bridge = FactBridge(host);
        session.attachDelegates(bridge);
        await start();
        await session.submitText('做一个计数器');
        provider.emit(
          VoiceEventKind.responseStart,
          id: 'dispatch',
          hostOrigin: false,
        );
        provider.controller.add(
          VoiceEvent(
            VoiceEventKind.toolCall,
            epoch: provider.epoch,
            responseId: 'dispatch',
            callId: 'call',
            name: 'delegate_task',
            arguments: {'request': '做一个计数器'},
          ),
        );
        await settle();
        // Text may arrive after the tool receipt: decide at response completion.
        if (alreadyReplied) {
          provider.emit(VoiceEventKind.text, id: 'dispatch', text: '我来帮你做。');
        }
        provider.emit(VoiceEventKind.responseEnd, id: 'dispatch');
        await settle();
        expect(bridge.starts, 1);
        expect(provider.injected, hasLength(1));
        expect(provider.requests, alreadyReplied ? 0 : 1);
        final delivery =
            (store.conversation(conversation)['voice_deliveries'] as Map)
                .values
                .single;
        expect(delivery['injection'], 'acknowledged');
        expect(
          delivery['activation'],
          alreadyReplied ? 'not_needed' : 'requested',
        );
        await session.stop();
        bridge.dispose();
        host.dispose();
        await bridge.facts.close();
      },
    );
  }
  test(
    'terminal queued behind a redundant receipt still narrates exactly once',
    () async {
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      await start();
      await session.submitText('做一个计数器');
      provider.emit(
        VoiceEventKind.responseStart,
        id: 'dispatch',
        hostOrigin: false,
      );
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.toolCall,
          epoch: provider.epoch,
          responseId: 'dispatch',
          callId: 'call',
          name: 'delegate_task',
          arguments: {'request': '做一个计数器'},
        ),
      );
      await settle();
      bridge.facts.add(
        VoiceDelegateUpdate('accepted', conversation, '已生成', terminal: true),
      );
      provider.emit(VoiceEventKind.text, id: 'dispatch', text: '我来帮你做。');
      provider.emit(VoiceEventKind.responseEnd, id: 'dispatch');
      await settle();
      expect(provider.injected, hasLength(2));
      expect(provider.requests, 1);
      final journal =
          store.conversation(conversation)['voice_deliveries'] as Map;
      expect(
        journal.values.where((v) => v['activation'] == 'not_needed'),
        hasLength(1),
      );
      expect(journal['accepted:terminal']['activation'], 'requested');
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'pending host activation holds the next terminal until response completion',
    () async {
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      await start();
      bridge.facts.add(
        VoiceDelegateUpdate(
          'first',
          conversation,
          'first done',
          terminal: true,
        ),
      );
      await settle();
      bridge.facts.add(
        VoiceDelegateUpdate(
          'second',
          conversation,
          'second done',
          terminal: true,
        ),
      );
      await settle();
      expect(provider.injected, ['first:terminal']);
      expect(provider.requestedItems, ['first:terminal']);
      provider.emit(
        VoiceEventKind.responseStart,
        id: 'host-first',
        hostOrigin: true,
      );
      provider.emit(VoiceEventKind.responseEnd, id: 'host-first');
      await settle();
      expect(provider.injected, ['first:terminal', 'second:terminal']);
      expect(provider.requestedItems, ['first:terminal', 'second:terminal']);
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'busy host activation defers without reinjecting acknowledged fact',
    () async {
      await start();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      provider.busyActivation = true;
      bridge.facts.add(
        VoiceDelegateUpdate('task', conversation, 'done', terminal: true),
      );
      await settle();
      expect(provider.requests, 1);
      final journal =
          store.conversation(conversation)['voice_deliveries'] as Map;
      expect(journal['task:terminal']['activation'], 'deferred');
      provider.busyActivation = false;
      provider.emit(VoiceEventKind.speechStart, item: 'new');
      provider.emit(VoiceEventKind.speechEnd);
      provider.emit(VoiceEventKind.responseStart, id: 'ordinary');
      provider.emit(VoiceEventKind.responseEnd, id: 'ordinary');
      await settle();
      expect(provider.requests, 2);
      expect(provider.injected, hasLength(1));
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'explicit user response origin never inherits pending host activation',
    () async {
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      await start();
      bridge.facts.add(
        VoiceDelegateUpdate('task', conversation, 'done', terminal: true),
      );
      await settle();
      expect(provider.requests, 1);
      await session.submitText('find my document');
      provider.emit(
        VoiceEventKind.responseStart,
        id: 'ordinary',
        hostOrigin: false,
      );
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.toolCall,
          epoch: provider.epoch,
          responseId: 'ordinary',
          callId: 'tool',
          name: 'delegate_task',
          arguments: {'request': 'find my document'},
        ),
      );
      await settle();
      expect(bridge.starts, 1);
      expect(bridge.receivedLanguage, 'zh');
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'unacknowledged provider injection is never journaled as acknowledged',
    () async {
      provider.capabilities = const VoiceCapabilities(
        automaticResponse: true,
        serverEndpointing: true,
        hostItems: true,
      );
      await start();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      bridge.facts.add(
        VoiceDelegateUpdate('task', conversation, 'done', terminal: true),
      );
      await settle();
      final journal =
          store.conversation(conversation)['voice_deliveries'] as Map;
      expect(journal['task:terminal'], {
        'injection': 'sent_unknown',
        'activation': 'requested',
      });
      expect(provider.injected, hasLength(1));
      await session.stop();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'response boundary preserves tentative transcript without granting final authority',
    () async {
      await start();
      provider.emit(VoiceEventKind.speechStart, item: 'observed');
      provider.emit(VoiceEventKind.transcript, item: 'observed', text: '五个苹果');
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.speechEnd,
          epoch: provider.epoch,
          itemId: 'observed',
          code: 'response_boundary',
        ),
      );
      provider.emit(VoiceEventKind.responseStart, id: 'reply');
      provider.emit(VoiceEventKind.text, id: 'reply', text: '好的。');
      provider.emit(VoiceEventKind.audio, id: 'reply', pcm: Uint8List(960));
      provider.emit(VoiceEventKind.responseEnd, id: 'reply');
      await settle();
      final messages = store.conversation(conversation)['messages'] as List;
      final user = messages.firstWhere((m) => m['role'] == 'user');
      expect(user['content'], '五个苹果');
      expect(user['voice_transcript_final'], false);
      expect(audio.frames, isNotEmpty);
      expect(provider.cancels, isEmpty);
      await session.stop();
      final next = TestVoiceProvider();
      await session.start(provider: next, conversation: conversation);
      expect(next.history, isEmpty);
      await session.stop();
      await next.controller.close();
    },
  );
  test(
    'final ASR without verified ownership cannot dispatch a task or enter replay',
    () async {
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      final bridge = FactBridge(host);
      session.attachDelegates(bridge);
      await start();
      provider.emit(VoiceEventKind.speechStart, item: 'late');
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.transcript,
          epoch: provider.epoch,
          itemId: 'late',
          text: 'delete my files',
          isFinal: true,
          inputOriginVerified: false,
        ),
      );
      provider.emit(VoiceEventKind.speechEnd, item: 'late');
      provider.emit(VoiceEventKind.responseStart, id: 'reply');
      provider.controller.add(
        VoiceEvent(
          VoiceEventKind.toolCall,
          epoch: provider.epoch,
          responseId: 'reply',
          callId: 'unverified-tool',
          name: 'delegate_task',
          arguments: {'request': 'delete my files'},
        ),
      );
      await settle();
      expect(bridge.starts, 0);
      final messages = store.conversation(conversation)['messages'] as List;
      expect(messages.first['voice_transcript_final'], true);
      expect(messages.first['voice_input_origin_verified'], false);
      await session.stop();
      final next = TestVoiceProvider();
      await session.start(provider: next, conversation: conversation);
      expect(next.history, isEmpty);
      await session.stop();
      await next.controller.close();
      bridge.dispose();
      host.dispose();
      await bridge.facts.close();
    },
  );
  test(
    'PCM input level is measured, throttled separately, and reset on mute and stop',
    () async {
      await start();
      var sessionChanges = 0, levelChanges = 0;
      session.addListener(() {
        sessionChanges++;
      });
      session.audioLevel.addListener(() {
        levelChanges++;
      });
      Uint8List pcm(int sample) {
        final bytes = ByteData(320);
        for (var i = 0; i < 320; i += 2) {
          bytes.setInt16(i, sample, Endian.little);
        }
        return bytes.buffer.asUint8List();
      }

      void capture(Uint8List bytes, [int? generation]) => audio.controller.add({
        'kind': 'pcm',
        'generation': generation ?? audio.generation,
        'pcm': bytes,
      });
      capture(pcm(16384), audio.generation! - 1);
      expect(session.inputLevel, 0);
      capture(pcm(16384));
      expect(session.inputLevel, closeTo(.5, .00001));
      for (var i = 0; i < 20; i++) {
        capture(pcm(-32768));
      }
      expect(levelChanges, 1);
      expect(
        sessionChanges,
        0,
        reason: 'PCM meter must not rebuild app listeners',
      );
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(session.inputLevel, 1);
      expect(levelChanges, 2);
      expect(sessionChanges, 0);
      await session.toggleMute();
      expect(session.inputLevel, 0);
      expect(session.status, 'muted');
      capture(pcm(16384));
      await Future<void>.delayed(const Duration(milliseconds: 110));
      expect(session.inputLevel, 0);
      await session.toggleMute();
      capture(pcm(16384));
      expect(session.inputLevel, closeTo(.5, .00001));
      await session.stop();
      expect(session.inputLevel, 0);
      expect(session.status, 'idle');
      expect(session.isPlaying, false);
      expect(session.isUserSpeaking, false);
    },
  );

  test(
    'response creation and queued audio are thinking until real render progress',
    () async {
      expect(session.status, 'idle');
      provider.connecting = Completer<void>();
      final beginning = start();
      await settle();
      expect(session.status, 'connecting');
      provider.connecting!.complete();
      await beginning;
      expect(session.status, 'listening');
      provider.emit(VoiceEventKind.speechStart, item: 's1');
      await settle();
      expect(session.isUserSpeaking, true);
      expect(session.status, 'listening');
      provider.emit(VoiceEventKind.speechEnd, item: 's1');
      await settle();
      expect(session.isUserSpeaking, false);
      expect(session.status, 'thinking');
      provider.emit(VoiceEventKind.responseStart, id: 'r1');
      provider.emit(VoiceEventKind.audio, id: 'r1', pcm: Uint8List(480));
      await settle();
      expect(session.isPlaying, false);
      expect(session.status, 'thinking');
      final identity = audio.frames.single.identity;
      void progress(int milliseconds) => audio.controller.add({
        'kind': 'control',
        'generation': audio.generation,
        'control': {
          'type': 'playback.progress',
          ...identity.fields,
          'played_ms': milliseconds,
        },
      });
      progress(0);
      expect(session.isPlaying, false);
      progress(5);
      expect(session.isPlaying, true);
      expect(session.status, 'speaking');
      provider.emit(VoiceEventKind.responseEnd, id: 'r1');
      await settle();
      expect(
        session.isPlaying,
        true,
        reason: 'model completion is not playback completion',
      );
      audio.controller.add({
        'kind': 'control',
        'generation': audio.generation,
        'control': {
          'type': 'playback.done',
          ...identity.fields,
          'played_ms': 10,
        },
      });
      expect(session.isPlaying, false);
      expect(session.status, 'listening');
    },
  );

  test(
    'interrupt and stale render progress cannot revive speaking state',
    () async {
      await start();
      provider.emit(VoiceEventKind.responseStart, id: 'old');
      provider.emit(VoiceEventKind.audio, id: 'old', pcm: Uint8List(480));
      await settle();
      final identity = audio.frames.single.identity;
      void progress(int milliseconds) => audio.controller.add({
        'kind': 'control',
        'generation': audio.generation,
        'control': {
          'type': 'playback.progress',
          ...identity.fields,
          'played_ms': milliseconds,
        },
      });
      progress(5);
      expect(session.isPlaying, true);
      provider.emit(VoiceEventKind.speechStart, item: 'new');
      expect(session.isPlaying, false);
      progress(10);
      expect(session.isPlaying, false);
      await settle();
      expect(session.isUserSpeaking, true);
      expect(session.status, 'listening');
    },
  );

  test(
    'current caption replaces stale reply and ignores late transcripts from previous turn',
    () async {
      await start();
      provider.emit(VoiceEventKind.speechStart, item: 'old-speech');
      provider.emit(
        VoiceEventKind.transcript,
        item: 'old-speech',
        text: 'old question',
        finalText: true,
      );
      provider.emit(VoiceEventKind.speechEnd, item: 'old-speech');
      await settle();
      expect(session.captionText, 'old question');
      expect(session.captionIsUser, true);
      provider.emit(VoiceEventKind.responseStart, id: 'old-reply');
      provider.emit(VoiceEventKind.text, id: 'old-reply', text: 'old answer');
      await settle();
      expect(session.captionText, 'old answer');
      expect(session.captionIsUser, false);
      provider.emit(VoiceEventKind.speechStart, item: 'new-speech');
      expect(session.reply, isEmpty);
      expect(session.captionText, isEmpty);
      provider.emit(
        VoiceEventKind.transcript,
        item: 'old-speech',
        text: 'late old final',
        finalText: true,
      );
      provider.emit(
        VoiceEventKind.text,
        id: 'old-reply',
        text: 'late old answer',
      );
      await settle();
      expect(session.captionText, isEmpty);
      provider.emit(
        VoiceEventKind.transcript,
        item: 'new-speech',
        text: 'new question',
        finalText: true,
      );
      await settle();
      expect(session.captionText, 'new question');
      expect(session.captionIsUser, true);
      expect(session.transcript, 'new question');
      expect(session.reply, isEmpty);
    },
  );

  test(
    'late ASR final in current turn cannot replace an already visible answer caption',
    () async {
      await start();
      provider.emit(VoiceEventKind.speechStart, item: 'speech');
      provider.emit(VoiceEventKind.speechEnd, item: 'speech');
      provider.emit(VoiceEventKind.responseStart, id: 'answer');
      provider.emit(VoiceEventKind.text, id: 'answer', text: 'answer text');
      await settle();
      provider.emit(
        VoiceEventKind.transcript,
        item: 'speech',
        text: 'late question',
        finalText: true,
      );
      await settle();
      expect(session.transcript, 'late question');
      expect(session.captionText, 'answer text');
      expect(session.captionIsUser, false);
    },
  );

  test(
    'submitted text shows user caption and rejected delivery restores prior caption',
    () async {
      await start();
      provider.failText = true;
      await expectLater(
        session.submitText('rejected'),
        throwsA(isA<StateError>()),
      );
      expect(session.captionText, isEmpty);
      provider.failText = false;
      await session.submitText('accepted text');
      expect(session.captionText, 'accepted text');
      expect(session.captionIsUser, true);
      expect(session.reply, isEmpty);
      expect(session.status, 'thinking');
    },
  );
  test(
    'delayed mute and speaker completions cannot overwrite a restarted call or unlock its pending controls',
    () async {
      await start();
      final oldMuteGate = audio.muting = Completer<void>();
      final oldSpeakerGate = audio.switchingSpeaker = Completer<void>();
      final oldMute = session.toggleMute();
      final oldSpeaker = session.toggleSpeaker();
      expect(identical(session.toggleMute(), oldMute), true);
      expect(identical(session.toggleSpeaker(), oldSpeaker), true);
      expect(audio.muteRequests, [true]);
      expect(audio.speakerRequests, [true]);
      await session.stop();
      final next = TestVoiceProvider();
      await session.start(provider: next, conversation: conversation);
      expect(session.muted, false);
      expect(session.speaker, false);
      final newMuteGate = audio.muting = Completer<void>();
      final newSpeakerGate = audio.switchingSpeaker = Completer<void>();
      final newMute = session.toggleMute();
      final newSpeaker = session.toggleSpeaker();
      oldMuteGate.complete();
      oldSpeakerGate.complete();
      await Future.wait([oldMute, oldSpeaker]);
      expect(session.muted, false);
      expect(session.speaker, false);
      expect(identical(session.toggleMute(), newMute), true);
      expect(identical(session.toggleSpeaker(), newSpeaker), true);
      expect(audio.muteRequests, [true, true]);
      expect(audio.speakerRequests, [true, true]);
      newMuteGate.complete();
      newSpeakerGate.complete();
      await Future.wait([newMute, newSpeaker]);
      expect(session.muted, true);
      expect(session.speaker, true);
      await session.toggleMute();
      await session.toggleSpeaker();
      expect(audio.muteRequests, [true, true, false]);
      expect(audio.speakerRequests, [true, true, false]);
      expect(session.muted, false);
      expect(session.speaker, false);
      await session.stop();
      await next.controller.close();
    },
  );

  test(
    'failed native toggle releases its action lock for an explicit retry',
    () async {
      await start();
      final gate = audio.muting = Completer<void>();
      final attempt = session.toggleMute();
      final failure = expectLater(attempt, throwsA(isA<StateError>()));
      gate.completeError(StateError('native mute unavailable'));
      await failure;
      expect(session.muted, false);
      audio.muting = null;
      await session.toggleMute();
      expect(session.muted, true);
      expect(audio.muteRequests, [true, true]);
    },
  );

  test(
    'frontbrain describes runnable phone artifacts without promising Python execution',
    () async {
      await start();
      expect(provider.instructions, contains('Use Simplified Chinese'));
      expect(
        provider.instructions,
        contains('self-contained HTML, CSS and JavaScript'),
      );
      expect(
        provider.instructions,
        contains('Do not promise Python or pygame execution on the phone'),
      );
      expect(
        provider.instructions,
        contains('generate their source code when requested'),
      );
    },
  );
}
