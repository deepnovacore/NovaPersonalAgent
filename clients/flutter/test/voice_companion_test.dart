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
  group('task companion', () {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    late NativeVoiceCompanion companion;
    late List<MethodCall> calls;
    Future<void> action(String id, String value) async {
      await messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('action', {'taskId': id, 'action': value}),
        ),
        (_) {},
      );
    }

    setUp(() {
      calls = [];
      companion = NativeVoiceCompanion();
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return call.method == 'showTask' ? true : null;
      });
    });
    tearDown(() async {
      await companion.hideTask();
      await companion.stop();
      messenger.setMockMethodCallHandler(channel, null);
    });

    test(
      'task-only lifetime forwards states, portrait and scoped actions',
      () async {
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        await companion.setAvatar(filePath: '/private/portrait.png');
        expect(
          await companion.showTask(
            taskId: 'one',
            status: 'running',
            label: 'Open',
            step: 2,
          ),
          isTrue,
        );
        await action('stale', 'task_stop');
        await action('one', 'task_takeover');
        await companion.showTask(taskId: 'one', status: 'needs_user');
        await action('one', 'open');
        await companion.showTask(taskId: 'two', status: 'failed');
        await action('one', 'task_stop');
        await action('two', 'task_stop');
        expect(actions, ['task_takeover', 'open', 'task_stop']);
        expect(calls.first.arguments, {
          'pngBytes': null,
          'filePath': '/private/portrait.png',
        });
        expect(calls[1].arguments, {
          'taskId': 'one',
          'status': 'running',
          'label': 'Open',
          'step': 2,
        });
        expect(calls.any((call) => call.method == 'start'), isFalse);
        await sub.cancel();
      },
    );

    test(
      'call stop preserves task callbacks; task hide preserves call',
      () async {
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        await companion.start();
        await companion.showTask(taskId: 'one', status: 'running');
        await companion.stop();
        await action('one', 'task_stop');
        expect(actions, ['task_stop']);
        await companion.start();
        final id = (calls.last.arguments as Map)['callId'];
        await companion.hideTask();
        await action('one', 'task_takeover');
        await messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('action', {'callId': id, 'action': 'mute'}),
          ),
          (_) {},
        );
        expect(actions, ['task_stop', 'mute']);
        await sub.cancel();
      },
    );

    test(
      'permission denial returns false and ignores task actions and frames',
      () async {
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return false;
        });
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        expect(
          await companion.showTask(taskId: 'one', status: 'running'),
          isFalse,
        );
        await action('one', 'task_stop');
        await companion.taskFrame(Uint8List.fromList([1, 2]));
        expect(actions, isEmpty);
        expect(calls.map((call) => call.method), ['showTask']);
        await sub.cancel();
      },
    );

    test(
      'frames throttle to five per second and drop without a task',
      () async {
        final jpeg = Uint8List.fromList([255, 216, 255]);
        await companion.taskFrame(jpeg);
        await companion.showTask(taskId: 'one', status: 'running');
        await companion.taskFrame(jpeg);
        await companion.taskFrame(jpeg);
        await Future<void>.delayed(const Duration(milliseconds: 210));
        await companion.taskFrame(jpeg);
        await companion.hideTask();
        await companion.taskFrame(jpeg);
        final frames = calls
            .where((call) => call.method == 'taskFrame')
            .toList();
        expect(frames, hasLength(2));
        expect(frames.first.arguments, {'taskId': 'one', 'jpeg': jpeg});
      },
    );

    test(
      'superseded show response cannot clear newer state for the same task',
      () async {
        final first = Completer<bool>();
        var shows = 0;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'showTask') {
            return shows++ == 0 ? first.future : true;
          }
          return null;
        });
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        final pending = companion.showTask(taskId: 'one', status: 'running');
        await companion.showTask(taskId: 'one', status: 'needs_user');
        first.complete(false);
        expect(await pending, isFalse);
        await action('one', 'task_takeover');
        expect(actions, ['task_takeover']);
        await sub.cancel();
      },
    );

    test('frames do not queue behind a slow native send', () async {
      final pending = Completer<void>();
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        if (call.method == 'taskFrame') await pending.future;
        return call.method == 'showTask' ? true : null;
      });
      await companion.showTask(taskId: 'one', status: 'running');
      final first = companion.taskFrame(Uint8List(1));
      await Future<void>.delayed(const Duration(milliseconds: 210));
      await companion.taskFrame(Uint8List(1));
      expect(calls.where((call) => call.method == 'taskFrame'), hasLength(1));
      pending.complete();
      await first;
    });

    test(
      'portrait bytes and reset; invalid inputs never cross channel',
      () async {
        final png = Uint8List.fromList([137, 80, 78, 71]);
        await companion.setAvatar(pngBytes: png);
        await companion.setAvatar();
        expect(calls.first.arguments, {'pngBytes': png, 'filePath': null});
        expect(calls.last.arguments, {'pngBytes': null, 'filePath': null});
        expect(
          () => companion.setAvatar(pngBytes: png, filePath: '/a'),
          throwsArgumentError,
        );
        await expectLater(
          companion.showTask(taskId: '', status: 'running'),
          throwsArgumentError,
        );
        await expectLater(
          companion.showTask(taskId: 'a', status: 'unknown'),
          throwsArgumentError,
        );
        await expectLater(
          companion.showTask(taskId: 'a', status: 'running', step: -1),
          throwsArgumentError,
        );
        expect(calls, hasLength(2));
      },
    );
  });
}
