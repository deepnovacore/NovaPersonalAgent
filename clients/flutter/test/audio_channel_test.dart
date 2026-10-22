import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_audio/channel_audio.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'continuous PCM acknowledges every frame and rejects stale generations',
    () async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        const MethodChannel('nova/audio'),
        (_) async => null,
      );
      final audio = ChannelAudio();
      var received = 0;
      final subscription = audio.events.listen((event) {
        if (event['kind'] == 'pcm') received++;
      });
      await audio.startRelay(
        generation: 1000001,
        capture: true,
        threshold: 0.045,
      );
      final frame = ByteData(648)..setInt64(0, 1000001, Endian.big);
      for (var index = 0; index < 1000; index++) {
        ByteData? acknowledgement;
        await messenger.handlePlatformMessage(
          'nova/audio/pcm',
          frame,
          (reply) => acknowledgement = reply,
        );
        expect(acknowledgement?.getUint8(0), 1, reason: 'frame $index');
      }
      expect(received, 1000);
      frame.setInt64(0, 1000000, Endian.big);
      ByteData? stale;
      await messenger.handlePlatformMessage(
        'nova/audio/pcm',
        frame,
        (reply) => stale = reply,
      );
      expect(stale?.getUint8(0), 0);
      expect(received, 1000);
      await audio.disconnect();
      await subscription.cancel();
      messenger.setMockMethodCallHandler(
        const MethodChannel('nova/audio'),
        null,
      );
    },
  );

  test('native commands carry generation and typed PCM frames', () async {
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('nova/audio'), (
      call,
    ) async {
      calls.add(call);
      return null;
    });
    final audio = ChannelAudio();
    await audio.startRelay(generation: 9, capture: true, threshold: 0.045);
    await audio.enqueue(Uint8List.fromList([78, 79, 86, 65]));
    expect(calls.first.arguments, {
      'generation': 9,
      'capture': true,
      'threshold': 0.045,
    });
    expect(calls[1].arguments['generation'], 9);
    await audio.disconnect();
    expect(calls.last.method, 'disconnect');
    messenger.setMockMethodCallHandler(const MethodChannel('nova/audio'), null);
  });
}
