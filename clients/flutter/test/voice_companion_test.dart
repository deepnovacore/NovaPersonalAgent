import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_companion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('nova/voice_companion');
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
      expect(calls[1].arguments, {'muted': true});
      await sub.cancel();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
}
