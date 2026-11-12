import 'dart:async';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/agent/phone_run.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:nova_mobile/voice/phone_task_pet.dart';
import 'package:nova_mobile/voice/voice_companion.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_phone_channel.dart';

class FakeTaskCompanion implements TaskCompanion {
  final shows = <String>[];
  final hides = <String?>[];
  final frames = <Uint8List>[];
  final avatars = <Object?>[];
  int permissionRequests = 0;

  /// Thrown by the next showTask calls, in order; null = success.
  final errors = <Object?>[];
  bool _previewWanted = false;
  final _preview = StreamController<bool>.broadcast(sync: true);
  final gone = StreamController<TaskOverlayGone>.broadcast(sync: true);

  void wantPreview(bool wanted) {
    _previewWanted = wanted;
    _preview.add(wanted);
  }

  @override
  Future<bool> showTask({
    required String taskId,
    required String status,
    String label = '',
    int? step,
  }) async {
    shows.add('$taskId|$status|$label|$step');
    if (status != 'running') _previewWanted = false;
    final error = errors.isEmpty ? null : errors.removeAt(0);
    if (error != null) throw error;
    return true;
  }

  @override
  Future<void> hideTask({String? taskId}) async => hides.add(taskId);
  @override
  Future<void> taskFrame(Uint8List jpeg) async => frames.add(jpeg);
  @override
  Future<void> setAvatar({Uint8List? pngBytes, String? filePath}) async =>
      avatars.add(filePath ?? pngBytes?.length);
  @override
  Future<void> requestOverlayPermission() async => permissionRequests++;
  @override
  bool get previewWanted => _previewWanted;
  @override
  Stream<bool> get previewChanges => _preview.stream;
  @override
  Stream<TaskOverlayGone> get taskDisappearances => gone.stream;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakePhoneChannel channel;
  late PhoneRunTracker tracker;
  late FakeTaskCompanion companion;
  late StreamController<String> actions;
  late List<String> stopped;
  late int opened, hints;
  late List<(String, bool)> covers;
  late PhoneTaskPet pet;

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  setUp(() {
    channel = FakePhoneChannel();
    tracker = PhoneRunTracker(channel)..start();
    companion = FakeTaskCompanion();
    actions = StreamController<String>.broadcast(sync: true);
    stopped = [];
    opened = 0;
    hints = 0;
    covers = [];
    pet = PhoneTaskPet(
      tracker: tracker,
      companion: companion,
      actions: actions.stream,
      onStop: stopped.add,
      onOpen: () => opened++,
      onOverlayPermissionNeeded: () => hints++,
      onStopCoverChanged: (id, covered) => covers.add((id, covered)),
    )..start();
  });

  tearDown(() {
    pet.dispose();
    tracker.dispose();
  });

  Future<void> resume() async {
    final binding = WidgetsBinding.instance;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await settle();
  }

  test('maps a virtual run to running, needs_user and done', () async {
    channel.emit(stepEvent(status: StepStatus.running, label: '打开小红书'));
    await settle();
    // The step's completion changes nothing the pet shows.
    channel.emit(stepEvent(label: '打开小红书'));
    await settle();
    channel.emit(takeoverEvent(TakeoverState.requested));
    await settle();
    channel.emit(takeoverEvent(TakeoverState.returned));
    channel.emit(stepEvent(step: 2, label: '点击搜索'));
    await settle();
    channel.emit(doneEvent());
    await settle();
    expect(companion.shows, [
      't1|running|打开小红书|1',
      't1|needs_user|打开小红书|1',
      't1|running|打开小红书|1',
      't1|running|点击搜索|2',
      't1|done|点击搜索|2',
    ]);
    expect(companion.hides, isEmpty, reason: 'native expires done itself');
  });

  test(
    'failed and interrupted runs are failed; a cancelled run hides',
    () async {
      channel.emit(stepEvent());
      channel.emit(doneEvent(outcome: 'interrupted'));
      await settle();
      expect(companion.shows.last, 't1|failed|点击搜索|1');
      channel.emit(stepEvent(taskId: 't2'));
      channel.emit(doneEvent(taskId: 't2', outcome: 'cancelled'));
      await settle();
      expect(companion.shows.last, 't2|running|点击搜索|1');
      expect(companion.hides, ['t2']);
    },
  );

  test('a run whose result arrives without done releases the pet', () async {
    channel.emit(stepEvent());
    await settle();
    tracker.markEnded('t1');
    await settle();
    expect(companion.hides, ['t1']);
  });

  test('main-tier steps never reach the pet', () async {
    channel.emit(stepEvent(tier: PhoneTier.main));
    await settle();
    expect(companion.shows, isEmpty);
  });

  test('a newer run replaces the task in place without a hide', () async {
    channel.emit(stepEvent());
    channel.emit(stepEvent(taskId: 't2'));
    await settle();
    expect(companion.shows, ['t1|running|点击搜索|1', 't2|running|点击搜索|1']);
    expect(companion.hides, isEmpty);
  });

  test('stop and open run on the current task; takeover is in-app', () async {
    actions.add('task_stop');
    actions.add('open');
    expect(stopped, isEmpty, reason: 'no task shown yet');
    expect(opened, 0);
    channel.emit(stepEvent());
    await settle();
    actions.add('task_takeover');
    await settle();
    expect(channel.calls, isNot(contains('takeover:t1')));
    actions.add('task_stop');
    actions.add('task_stop');
    expect(stopped, ['t1'], reason: 'a repeated stop request is ignored');
    actions.add('open');
    expect(opened, 1);
    // Call controls on the shared stream are not task actions.
    actions.add('end');
    actions.add('mute');
    expect(stopped, ['t1']);
  });

  test(
    'missing permission hints once and never retries until resume',
    () async {
      companion.errors.add(
        PlatformException(code: 'overlay_permission', message: 'x'),
      );
      channel.emit(stepEvent());
      await settle();
      channel.emit(stepEvent(step: 2));
      channel.emit(stepEvent(step: 3));
      await settle();
      expect(companion.shows, hasLength(1));
      expect(hints, 1);
      // Another task without the permission does not hint again.
      companion.errors.add(
        PlatformException(code: 'overlay_permission', message: 'x'),
      );
      channel.emit(stepEvent(taskId: 't2'));
      await settle();
      expect(hints, 1);
      await resume();
      expect(companion.shows.last, 't2|running|点击搜索|1');
      expect(companion.shows, hasLength(3));
    },
  );

  test('blocked startup is silent and not retried per step', () async {
    for (final code in ['foreground_blocked', 'overlay_blocked', 'timeout']) {
      companion.errors.add(PlatformException(code: code));
    }
    channel.emit(stepEvent());
    await settle();
    for (var step = 2; step < 6; step++) {
      channel.emit(stepEvent(step: step));
    }
    await settle();
    expect(companion.shows, hasLength(1));
    expect(hints, 0);
    await resume();
    await resume();
    expect(companion.shows, hasLength(3));
    await resume();
    expect(companion.shows, hasLength(4));
    expect(companion.shows.last, 't1|running|点击搜索|5');
    await resume();
    expect(companion.shows, hasLength(4), reason: 'nothing blocked any more');
  });

  test('an overlay lost to the system is not re-shown for that task', () async {
    channel.emit(stepEvent());
    await settle();
    companion.gone.add(const TaskOverlayGone('t1', 'overlay_permission'));
    channel.emit(stepEvent(step: 2));
    await settle();
    expect(companion.shows, hasLength(1));
    expect(hints, 1);
    // A stale disappearance of another task is ignored.
    channel.emit(stepEvent(taskId: 't2'));
    await settle();
    companion.gone.add(const TaskOverlayGone('t1', 'overlay_blocked'));
    channel.emit(stepEvent(taskId: 't2', step: 2));
    await settle();
    expect(companion.shows.last, 't2|running|点击搜索|2');
  });

  test(
    'frames flow only while the pet preview is wanted and running',
    () async {
      channel.emit(stepEvent());
      await settle();
      expect(channel.previews, isEmpty);
      companion.wantPreview(true);
      await settle();
      expect(channel.previews, [true]);
      channel.frameController.add(tinyFrame);
      await settle();
      expect(companion.frames, hasLength(1));
      // A takeover hides the preview: native stops wanting it and no frame is
      // forwarded.
      channel.emit(takeoverEvent(TakeoverState.requested));
      await settle();
      expect(channel.previews, [true, false]);
      channel.frameController.add(tinyFrame);
      await settle();
      expect(companion.frames, hasLength(1));
    },
  );

  test('the shared preview stays on for the in-app picture', () async {
    channel.emit(stepEvent());
    await settle();
    tracker.preview.retain();
    companion.wantPreview(true);
    companion.wantPreview(false);
    await settle();
    expect(tracker.preview.holders, 1);
    expect(channel.previews, [true]);
    tracker.preview.release();
  });

  test('binds the avatar and hides the captured task on dispose', () async {
    SharedPreferences.setMockInitialValues({});
    final store = PetAvatarStore();
    await store.load();
    final second = PhoneTaskPet(
      tracker: tracker,
      companion: companion,
      actions: actions.stream,
      onStop: stopped.add,
    )..start(avatar: store);
    await settle();
    await settle();
    expect(companion.avatars, hasLength(1));
    channel.emit(stepEvent());
    await settle();
    second.dispose();
    expect(companion.hides, ['t1']);
    store.dispose();
  });

  group('stop cover', () {
    test('a shown run is covered once', () async {
      channel.emit(stepEvent());
      await settle();
      channel.emit(stepEvent(step: 2));
      channel.emit(takeoverEvent(TakeoverState.requested));
      await settle();
      expect(companion.shows, hasLength(3));
      expect(covers, [('t1', true)]);
    });

    test('a failed show uncovers until a retry succeeds', () async {
      companion.errors.add(PlatformException(code: 'overlay_blocked'));
      channel.emit(stepEvent());
      await settle();
      expect(covers, [('t1', false)]);
      await resume();
      expect(covers, [('t1', false), ('t1', true)]);
    });

    test('a failed update of a covered run uncovers it', () async {
      channel.emit(stepEvent());
      await settle();
      companion.errors.add(PlatformException(code: 'timeout'));
      channel.emit(stepEvent(step: 2));
      await settle();
      expect(covers, [('t1', true), ('t1', false)]);
    });

    test('expiry and our own hide never uncover', () async {
      channel.emit(stepEvent());
      await settle();
      companion.gone.add(const TaskOverlayGone('t1', 'hidden'));
      await settle();
      channel.emit(stepEvent(taskId: 't2'));
      await settle();
      companion.gone.add(const TaskOverlayGone('t2', 'expired'));
      await settle();
      expect(covers, [('t1', true), ('t2', true)]);
    });

    test('an overlay lost while the run is active uncovers it', () async {
      channel.emit(stepEvent());
      await settle();
      companion.gone.add(const TaskOverlayGone('t1', 'notification_stop'));
      await settle();
      expect(covers, [('t1', true), ('t1', false)]);
    });

    test('an overlay lost after the run ended does not uncover', () async {
      channel.emit(stepEvent());
      await settle();
      channel.emit(doneEvent());
      await settle();
      companion.gone.add(const TaskOverlayGone('t1', 'overlay_blocked'));
      await settle();
      expect(covers, [('t1', true)]);
    });

    test('dispose uncovers the active run', () async {
      channel.emit(stepEvent());
      await settle();
      pet.dispose();
      expect(covers, [('t1', true), ('t1', false)]);
    });

    // Everything is built inside the fake zone so its timers and microtasks
    // are the ones being elapsed.
    void leased(
      void Function(
        FakeAsync,
        FakePhoneChannel,
        FakeTaskCompanion,
        PhoneTaskPet,
      )
      body,
    ) {
      fakeAsync((async) {
        final channel = FakePhoneChannel();
        final tracker = PhoneRunTracker(channel)..start();
        final companion = FakeTaskCompanion();
        final pet = PhoneTaskPet(
          tracker: tracker,
          companion: companion,
          actions: const Stream.empty(),
          onStop: (_) {},
          onStopCoverChanged: (id, covered) => covers.add((id, covered)),
        )..start();
        channel.emit(stepEvent());
        async.flushMicrotasks();
        body(async, channel, companion, pet);
        pet.dispose();
        tracker.dispose();
        async.flushMicrotasks();
      });
    }

    const every = PhoneTaskPet.renewCoverEvery;

    test('a covered run renews its lease until the run ends', () {
      leased((async, channel, companion, pet) {
        async.elapse(every * 2);
        expect(covers, [('t1', true), ('t1', true), ('t1', true)]);
        channel.emit(doneEvent());
        async.flushMicrotasks();
        async.elapse(every * 3);
        expect(covers, hasLength(3));
        expect(async.periodicTimerCount, 0);
      });
    });

    test('renewals stop after an uncover', () {
      leased((async, channel, companion, pet) {
        async.elapse(every);
        companion.gone.add(const TaskOverlayGone('t1', 'overlay_blocked'));
        async.elapse(every * 3);
        expect(covers, [('t1', true), ('t1', true), ('t1', false)]);
        expect(async.periodicTimerCount, 0);
      });
    });

    test('renewals stop on dispose', () {
      leased((async, channel, companion, pet) {
        pet.dispose();
        async.elapse(every * 3);
        expect(covers, [('t1', true), ('t1', false)]);
        expect(async.periodicTimerCount, 0);
      });
    });

    test('renewals stop when a cancelled run hides the pet', () {
      leased((async, channel, companion, pet) {
        channel.emit(doneEvent(outcome: 'cancelled'));
        async.flushMicrotasks();
        async.elapse(every * 3);
        expect(covers, [('t1', true)]);
        expect(async.periodicTimerCount, 0);
      });
    });

    test('main-tier runs are never covered or uncovered', () async {
      companion.errors.add(PlatformException(code: 'overlay_blocked'));
      channel.emit(stepEvent(tier: PhoneTier.main));
      await settle();
      pet.dispose();
      expect(covers, isEmpty);
    });
  });
}
