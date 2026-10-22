import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_companion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('nova/voice_companion');
  test(
    'restore acknowledges rendering and rejects completion after hangup',
    () async {
      String? id;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'start') {
          id = (call.arguments as Map)['callId'] as String;
        }
        return null;
      });
      final companion = NativeVoiceCompanion();
      var render = Completer<bool>();
      companion.onRestore = () => render.future;
      await companion.start();
      Future<Object?> restore() {
        final response = Completer<Object?>();
        unawaited(
          messenger.handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              MethodCall('restore', {'callId': id}),
            ),
            (data) => response.complete(
              const StandardMethodCodec().decodeEnvelope(data!),
            ),
          ),
        );
        return response.future;
      }

      final first = restore();
      render.complete(true);
      expect(await first, isTrue);
      render = Completer<bool>();
      final pending = restore();
      await Future<void>.delayed(Duration.zero);
      await companion.stop();
      render.complete(true);
      expect(await pending, isFalse);
      messenger.setMockMethodCallHandler(channel, null);
    },
  );
  test(
    'late PiP events from a previous call cannot affect the next call',
    () async {
      final starts = <Object?>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'start') starts.add(call.arguments);
            return null;
          });
      final companion = NativeVoiceCompanion();
      final actions = <String>[];
      final sub = companion.actions.listen(actions.add);
      await companion.start();
      await companion.stop();
      await companion.start();
      expect(starts.first, isA<Map>());
      final oldId = (starts.first as Map)['callId'];
      final newId = (starts.last as Map)['callId'];
      expect(newId, isNot(oldId));
      for (final id in [oldId, newId]) {
        await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                MethodCall('action', {'callId': id, 'action': 'end'}),
              ),
              (_) {},
            );
      }
      expect(actions, ['end']);
      await companion.stop();
      await sub.cancel();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
  test(
    'platform lifetime, denied overlay, and native controls share one channel',
    () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return call.method == 'minimize' ? false : null;
          });
      final companion = NativeVoiceCompanion();
      final actions = <String>[];
      final sub = companion.actions.listen(actions.add);
      await companion.start();
      await companion.update(muted: true);
      expect(await companion.minimize(), isFalse);
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('action', 'end'),
            ),
            (_) {},
          );
      await Future<void>.delayed(Duration.zero);
      expect(actions, ['end']);
      await companion.stop();
      expect(calls.map((c) => c.method), [
        'start',
        'update',
        'minimize',
        'stop',
      ]);
      expect(calls[1].arguments, {
        'callId': (calls.first.arguments as Map)['callId'],
        'muted': true,
        'status': 'listening',
        'language': 'zh',
      });
      await sub.cancel();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
}
