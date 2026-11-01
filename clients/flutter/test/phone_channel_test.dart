import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';

const _method = MethodChannel('nova/phone/v1');
const _eventsChannel = EventChannel('nova/phone/events');
const _framesChannel = EventChannel('nova/phone/frames');

String _doneJson(String id) => jsonEncode({
  'type': 'done',
  'task_id': id,
  'outcome': 'completed',
  'steps': 1,
  'duration_ms': 5,
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late List<MethodCall> calls;
  late int eventListens, eventCancels, frameListens, frameCancels;
  MockStreamHandlerEventSink? eventSink, frameSink;
  Object? Function(MethodCall call) answer = (_) => '{}';

  setUp(() {
    calls = [];
    eventListens = eventCancels = frameListens = frameCancels = 0;
    eventSink = frameSink = null;
    answer = (_) => '{}';
    messenger.setMockMethodCallHandler(_method, (call) async {
      calls.add(call);
      return answer(call);
    });
    messenger.setMockStreamHandler(
      _eventsChannel,
      MockStreamHandler.inline(
        onListen: (arguments, sink) {
          eventListens++;
          eventSink = sink;
        },
        onCancel: (arguments) {
          eventCancels++;
          eventSink = null;
        },
      ),
    );
    messenger.setMockStreamHandler(
      _framesChannel,
      MockStreamHandler.inline(
        onListen: (arguments, sink) {
          frameListens++;
          frameSink = sink;
        },
        onCancel: (arguments) {
          frameCancels++;
          frameSink = null;
        },
      ),
    );
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(_method, null);
    messenger.setMockStreamHandler(_eventsChannel, null);
    messenger.setMockStreamHandler(_framesChannel, null);
  });

  group('shared native subscriptions', () {
    test(
      'two listeners share one platform subscription and a cancel keeps the other',
      () async {
        const channel = NativePhoneChannel();
        final first = <String>[], second = <String>[];
        final a = channel.events.listen(
          (e) => first.add((e as PhoneDoneEvent).taskId),
        );
        final b = channel.events.listen(
          (e) => second.add((e as PhoneDoneEvent).taskId),
        );
        await pumpEventQueue();
        expect(eventListens, 1);

        eventSink!.success(_doneJson('t1'));
        await pumpEventQueue();
        expect(first, ['t1']);
        expect(second, ['t1']);

        await a.cancel();
        await pumpEventQueue();
        expect(eventCancels, 0, reason: 'one listener is still attached');

        eventSink!.success(_doneJson('t2'));
        await pumpEventQueue();
        expect(first, ['t1']);
        expect(second, ['t1', 't2']);

        await b.cancel();
        await pumpEventQueue();
        expect(eventCancels, 1);
      },
    );

    test('a later listener reopens the platform stream', () async {
      const channel = NativePhoneChannel();
      final a = channel.events.listen((_) {});
      await pumpEventQueue();
      await a.cancel();
      await pumpEventQueue();
      expect((eventListens, eventCancels), (1, 1));

      final got = <PhoneEvent>[];
      final b = channel.events.listen(got.add);
      await pumpEventQueue();
      expect(eventListens, 2);
      eventSink!.success(_doneJson('t3'));
      await pumpEventQueue();
      expect(got, hasLength(1));
      await b.cancel();
    });

    test('frames are shared the same way and ignore empty payloads', () async {
      const channel = NativePhoneChannel();
      final first = <int>[], second = <int>[];
      final a = channel.frames.listen((f) => first.add(f.length));
      final b = channel.frames.listen((f) => second.add(f.length));
      await pumpEventQueue();
      expect(frameListens, 1);

      frameSink!.success(Uint8List.fromList([1, 2, 3]));
      frameSink!.success(Uint8List(0));
      await pumpEventQueue();
      expect(first, [3]);
      expect(second, [3]);

      await a.cancel();
      await pumpEventQueue();
      expect(frameCancels, 0);
      await b.cancel();
      await pumpEventQueue();
      expect(frameCancels, 1);
    });

    test('malformed events are dropped without breaking the stream', () async {
      const channel = NativePhoneChannel();
      final got = <PhoneEvent>[];
      final sub = channel.events.listen(got.add);
      await pumpEventQueue();
      eventSink!.success('not json');
      eventSink!.success(_doneJson('t4'));
      await pumpEventQueue();
      expect(got.map((e) => (e as PhoneDoneEvent).taskId), ['t4']);
      await sub.cancel();
    });
  });

  group('experimental acknowledgement', () {
    test('goes to native and the answer is the status', () async {
      answer = (call) => jsonEncode({
        'api_level': 33,
        'experimental': true,
        'experimental_ack': true,
      });
      final status = await const NativePhoneChannel().setExperimentalAck(true);
      expect(calls.single.method, 'setExperimentalAck');
      expect(jsonDecode(calls.single.arguments as String), {
        'acknowledged': true,
      });
      expect(status.experimentalAck, isTrue);
      expect(status.experimental, isTrue);
    });

    test('a native without the handler is a failure, not a success', () async {
      messenger.setMockMethodCallHandler(_method, null);
      await expectLater(
        const NativePhoneChannel().setExperimentalAck(true),
        throwsA(isA<PhoneChannelException>()),
      );
    });

    test('a native error is a failure carrying its safe code', () async {
      messenger.setMockMethodCallHandler(
        _method,
        (call) async => throw PlatformException(code: 'x', message: 'unknown'),
      );
      await expectLater(
        const NativePhoneChannel().setExperimentalAck(true),
        throwsA(
          isA<PhoneChannelException>().having((e) => e.code, 'code', 'unknown'),
        ),
      );
    });

    test('status parses experimental_ack and defaults to false', () {
      expect(PhoneStatus.fromJson(const {}).experimentalAck, isFalse);
      expect(
        PhoneStatus.fromJson(const {'experimental_ack': true}).experimentalAck,
        isTrue,
      );
    });
  });

  test('openSettings sends the snake_case kind', () async {
    answer = (call) => jsonEncode({'opened': true});
    final channel = const NativePhoneChannel();
    await channel.openSettings(PhoneSettingsKind.notifications);
    await channel.openSettings(PhoneSettingsKind.appInfo);
    await channel.openSettings(PhoneSettingsKind.wirelessDebugging);
    expect(
      calls.map((c) => (jsonDecode(c.arguments as String) as Map)['kind']),
      ['notifications', 'app_info', 'wireless_debugging'],
    );
  });
}
