import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_companion.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
    var now = 0;
    Future<void> event(
      String method,
      String id,
      Map<String, Object?> fields,
    ) async {
      await messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall(method, {'taskId': id, ...fields}),
        ),
        (_) {},
      );
    }

    Future<void> wantsFrames([bool wanted = true]) =>
        event('previewWanted', 'one', {'wanted': wanted});
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
      now = 0;
      companion = NativeVoiceCompanion(frameMilliseconds: () => now);
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
        await action('one', 'task_stop');
        await companion.showTask(taskId: 'one', status: 'needs_user');
        await action('one', 'open');
        await companion.showTask(taskId: 'two', status: 'failed');
        await action('one', 'task_stop');
        await action('two', 'task_stop');
        expect(actions, ['task_stop', 'open', 'task_stop']);
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
        await action('one', 'task_stop');
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
      'permission denial is typed and ignores task actions and frames',
      () async {
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'showTask') {
            throw PlatformException(code: 'overlay_permission');
          }
          return null;
        });
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        await expectLater(
          companion.showTask(taskId: 'one', status: 'running'),
          throwsA(
            isA<PlatformException>().having(
              (e) => e.code,
              'code',
              'overlay_permission',
            ),
          ),
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
        await companion.taskFrame(jpeg); // Hidden/collapsed: no bridge copies.
        await wantsFrames();
        await companion.taskFrame(jpeg);
        await companion.taskFrame(jpeg);
        now += 210;
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
      'coalesced show responses preserve newer state for the same task',
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
        first.complete(true);
        expect(await pending, isTrue);
        await action('one', 'task_stop');
        expect(actions, ['task_stop']);
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
      await wantsFrames();
      final first = companion.taskFrame(Uint8List(1));
      now += 210;
      await companion.taskFrame(Uint8List(1));
      expect(calls.where((call) => call.method == 'taskFrame'), hasLength(1));
      pending.complete();
      await first;
    });

    test('scoped hide cannot clear a replacement task', () async {
      final actions = <String>[];
      final sub = companion.actions.listen(actions.add);
      await companion.showTask(taskId: 'one', status: 'done');
      await companion.showTask(taskId: 'two', status: 'running');
      await companion.hideTask(taskId: 'one');
      await action('two', 'task_stop');
      expect(actions, ['task_stop']);
      expect(calls.where((c) => c.method == 'hideTask'), isEmpty);
      await companion.hideTask(taskId: 'two');
      expect(calls.last.arguments, {'taskId': 'two'});
      await sub.cancel();
    });

    test(
      'native disappearance clears preview and task, not call callbacks',
      () async {
        final changes = <bool>[];
        final gone = <TaskOverlayGone>[];
        final actions = <String>[];
        final subscriptions = [
          companion.previewChanges.listen(changes.add),
          companion.taskDisappearances.listen(gone.add),
          companion.actions.listen(actions.add),
        ];
        await companion.start();
        final callId = (calls.last.arguments as Map)['callId'];
        await companion.showTask(taskId: 'one', status: 'running');
        await wantsFrames();
        expect(companion.previewWanted, isTrue);
        await event('taskGone', 'stale', {'reason': 'expired'});
        expect(companion.previewWanted, isTrue);
        await event('taskGone', 'one', {'reason': 'expired'});
        await companion.taskFrame(Uint8List(1));
        await action('one', 'task_stop');
        await messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('action', {'callId': callId, 'action': 'mute'}),
          ),
          (_) {},
        );
        expect(changes, [true, false]);
        expect(gone.single.taskId, 'one');
        expect(gone.single.reason, 'expired');
        expect(actions, ['mute']);
        expect(calls.where((c) => c.method == 'taskFrame'), isEmpty);
        for (final sub in subscriptions) {
          await sub.cancel();
        }
      },
    );

    test(
      'typed startup errors retain an active call and permission is explicit',
      () async {
        await companion.start();
        final callId = (calls.last.arguments as Map)['callId'];
        final actions = <String>[];
        final sub = companion.actions.listen(actions.add);
        for (final code in [
          'overlay_permission',
          'foreground_blocked',
          'timeout',
          'overlay_blocked',
        ]) {
          messenger.setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            if (call.method == 'showTask') throw PlatformException(code: code);
            return null;
          });
          await expectLater(
            companion.showTask(taskId: 'one', status: 'running'),
            throwsA(
              isA<PlatformException>().having((e) => e.code, 'code', code),
            ),
          );
        }
        await companion.requestOverlayPermission();
        expect(calls.last.method, 'requestOverlayPermission');
        await messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('action', {'callId': callId, 'action': 'mute'}),
          ),
          (_) {},
        );
        expect(actions, ['mute']);
        await sub.cancel();
      },
    );

    test(
      'avatar binding sends bundled default, follows store and detaches',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'nova-avatar-binding-',
        );
        final file = File('${directory.path}/portrait.png');
        await file.writeAsBytes([1]);
        SharedPreferences.setMockInitialValues({
          petAvatarPreferenceKey: jsonEncode({
            'mode': 'custom',
            'path': file.path,
          }),
        });
        final store = PetAvatarStore(writePreference: (_) async => true);
        final unbind = await bindTaskAvatar(
          companion,
          store,
          onError: (e, s) => fail('$e'),
        );
        final bundled = await rootBundle.load(petAvatarAsset);
        expect(
          (calls.last.arguments as Map)['pngBytes'],
          bundled.buffer.asUint8List(),
        );
        await store.load();
        expect((calls.last.arguments as Map)['filePath'], file.path);
        await store.resetToDefault();
        await Future<void>.delayed(Duration.zero);
        expect(
          (calls.last.arguments as Map)['pngBytes'],
          bundled.buffer.asUint8List(),
        );
        unbind();
        final count = calls.length;
        await store.resetToDefault();
        expect(calls.length, count);
        store.dispose();
        await directory.delete(recursive: true);
      },
    );

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
