import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/agent/phone_run.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/ui/virtual_screen_pip.dart';
import 'support/fake_phone_channel.dart';

const _top = 56.0, _bottom = 96.0, _side = 8.0;

class _Harness {
  _Harness(this.channel) : tracker = PhoneRunTracker(channel)..start();
  final FakePhoneChannel channel;
  final PhoneRunTracker tracker;
  int stops = 0;
}

Future<_Harness> _pump(
  WidgetTester tester, {
  Size size = const Size(360, 640),
  bool reduced = false,
  bool visible = true,
  FakePhoneChannel? channel,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final harness = _Harness(channel ?? FakePhoneChannel());
  addTearDown(() async {
    harness.tracker.dispose();
    await harness.channel.close();
  });
  await tester.pumpWidget(_app(harness, size, reduced, visible));
  return harness;
}

Widget _app(_Harness harness, Size size, bool reduced, bool visible) =>
    MaterialApp(
      theme: novaTheme(),
      home: MediaQuery(
        data: MediaQueryData(size: size, disableAnimations: reduced),
        child: Scaffold(
          body: Stack(
            children: [
              Positioned.fill(
                child: VirtualScreenPip(
                  tracker: harness.tracker,
                  visible: visible,
                  topInset: _top,
                  bottomInset: _bottom,
                  sideInset: _side,
                  onStop: () => harness.stops++,
                ),
              ),
            ],
          ),
        ),
      ),
    );

Future<void> _emit(
  WidgetTester tester,
  _Harness harness,
  PhoneEvent event,
) async {
  harness.channel.emit(event);
  await tester.runAsync(pumpEventQueue);
  await tester.pump();
}

final _working = find.byKey(const ValueKey('pip-working'));
final _needsYou = find.byKey(const ValueKey('pip-needs-you'));
final _cross = find.byIcon(CupertinoIcons.xmark);

void main() {
  testWidgets('takeover maps known reasons and hides future reason codes', (
    tester,
  ) async {
    final h = await _pump(tester, reduced: true);
    await _emit(tester, h, stepEvent());
    for (final entry in {
      'secure_page': '遇到受保护页面',
      'outside_target_app': '离开了目标 App',
      'future_takeover_reason': '需要你处理后才能继续',
    }.entries) {
      await _emit(
        tester,
        h,
        PhoneTakeoverEvent(
          taskId: 't1',
          state: TakeoverState.requested,
          byModel: true,
          reason: entry.key,
        ),
      );
      expect(find.text('${entry.value}。点“我来”接管到主屏。'), findsOneWidget);
      expect(find.textContaining(entry.key), findsNothing);
    }
  });
  testWidgets(
    'nothing shows, and no frames are asked for, without a virtual task',
    (tester) async {
      final h = await _pump(tester);
      expect(_working, findsNothing);
      expect(h.channel.previews, isEmpty);
      await _emit(tester, h, stepEvent(tier: PhoneTier.main));
      expect(_working, findsNothing);
      expect(h.channel.previews, isEmpty);
    },
  );

  testWidgets(
    'a virtual task shows the small picture and turns the preview on',
    (tester) async {
      final h = await _pump(tester);
      await _emit(tester, h, stepEvent());
      expect(_working, findsOneWidget);
      expect(h.channel.previews, [true]);
      final rect = tester.getRect(_working);
      expect(rect.width, pipCollapsedWidth);
      // Starts in the bottom-right corner, above the composer.
      expect(rect.right, 360 - _side);
      expect(rect.bottom, 640 - _bottom);
      // Follows the main screen's shape before any frame arrives.
      expect(rect.height, closeTo(96 * 640 / 360, 1));
    },
  );

  testWidgets('frames show as an image and the shape follows the frame', (
    tester,
  ) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    expect(find.byType(Image), findsNothing);
    h.channel.frameController.add(tinyFrame);
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    final image = tester.widget<Image>(find.byType(Image));
    expect(image.gaplessPlayback, isTrue);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
  });

  testWidgets('finishing the task hides it and stops the frames', (
    tester,
  ) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await _emit(tester, h, doneEvent());
    expect(_working, findsNothing);
    expect(h.channel.previews, [true, false]);
    expect(h.channel.frameController.hasListener, isFalse);
  });

  testWidgets('hiding the widget or leaving the app stops the preview', (
    tester,
  ) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    expect(h.channel.previews, [true]);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.runAsync(pumpEventQueue);
    expect(h.channel.previews, [true, false]);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.runAsync(pumpEventQueue);
    expect(h.channel.previews, [true, false, true]);
    await tester.pumpWidget(_app(h, const Size(360, 640), false, false));
    await tester.runAsync(pumpEventQueue);
    expect(_working, findsNothing);
    expect(h.channel.previews.last, isFalse);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(pumpEventQueue);
    expect(h.channel.previews.last, isFalse);
  });

  testWidgets('tap expands to 220, the cross collapses', (tester) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await tester.tap(_working);
    await tester.pumpAndSettle();
    expect(tester.getRect(_working).width, pipExpandedWidth);
    expect(find.text('我来'), findsOneWidget);
    await tester.tap(_cross);
    await tester.pumpAndSettle();
    expect(tester.getRect(_working).width, pipCollapsedWidth);
    expect(find.text('我来'), findsNothing);
  });

  testWidgets('the cross has at least a 44dp target', (tester) async {
    final semantics = tester.ensureSemantics();
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await tester.tap(_working);
    await tester.pumpAndSettle();
    final size = tester.getSize(find.bySemanticsLabel('收起'));
    expect(size.width, greaterThanOrEqualTo(44));
    expect(size.height, greaterThanOrEqualTo(44));
    semantics.dispose();
  });

  testWidgets('take over, hand back and stop reach their handlers', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await tester.tap(_working);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pip-take-over')));
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    expect(h.channel.calls, contains('takeover:t1'));
    // The app is now on the main screen: the state is "needs you" with the
    // hand-back button.
    expect(_needsYou, findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('pip-hand-back')));
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    expect(h.channel.calls, contains('handBack:t1'));
    expect(_working, findsOneWidget);
    final stop = find.byKey(const ValueKey('pip-stop'));
    expect(tester.getSemantics(stop).tooltip, '停止任务');
    expect(tester.getSize(stop).width, greaterThanOrEqualTo(44));
    expect(tester.getSize(stop).height, greaterThanOrEqualTo(44));
    await tester.tap(stop);
    expect(h.stops, 1);
    semantics.dispose();
  });

  testWidgets('a takeover request expands it and glows orange', (tester) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    expect(_working, findsOneWidget);
    await _emit(tester, h, takeoverEvent(TakeoverState.requested));
    expect(find.text('需要你处理后才能继续。点“我来”接管到主屏。'), findsOneWidget);
    expect(h.channel.calls.where((c) => c.startsWith('takeover:')), isEmpty);
    // It breathes, so time is advanced by hand.
    await tester.pump(const Duration(milliseconds: 300));
    expect(_needsYou, findsOneWidget);
    expect(_working, findsNothing);
    expect(tester.getRect(_needsYou).width, pipExpandedWidth);
    final decoration =
        (tester.widget<DecoratedBox>(_needsYou).decoration as BoxDecoration);
    expect((decoration.border! as Border).top.color.a, greaterThan(0));
    // Back to working colour once the app returns.
    await _emit(tester, h, takeoverEvent(TakeoverState.active));
    await _emit(tester, h, takeoverEvent(TakeoverState.returned));
    await tester.pump(const Duration(milliseconds: 300));
    expect(_working, findsOneWidget);
  });

  testWidgets('the user can collapse it again after a takeover request', (
    tester,
  ) async {
    final h = await _pump(tester, reduced: true);
    await _emit(tester, h, stepEvent());
    await _emit(tester, h, takeoverEvent(TakeoverState.requested));
    await tester.pumpAndSettle();
    await tester.tap(_cross);
    await tester.pumpAndSettle();
    expect(tester.getRect(_needsYou).width, pipCollapsedWidth);
    // The same request does not re-open it.
    await _emit(tester, h, stepEvent(step: 2));
    expect(tester.getRect(_needsYou).width, pipCollapsedWidth);
  });

  testWidgets('needs-you breathes, unless motion is reduced', (tester) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await _emit(tester, h, takeoverEvent(TakeoverState.requested));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await tester.pumpWidget(const SizedBox());
    await tester.pump();

    final calm = await _pump(tester, reduced: true);
    await _emit(tester, calm, stepEvent());
    await _emit(tester, calm, takeoverEvent(TakeoverState.requested));
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
    expect(_needsYou, findsOneWidget);
  });

  testWidgets('working is a still glow', (tester) async {
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
    'dragging snaps to the nearest corner and stays inside the insets',
    (tester) async {
      final h = await _pump(tester, reduced: true);
      await _emit(tester, h, stepEvent());
      await tester.drag(_working, const Offset(-500, -700));
      await tester.pumpAndSettle();
      var rect = tester.getRect(_working);
      expect(rect.left, _side);
      expect(rect.top, _top);
      await tester.drag(_working, const Offset(500, 0));
      await tester.pumpAndSettle();
      rect = tester.getRect(_working);
      expect(rect.right, 360 - _side);
      expect(rect.top, _top);
      await tester.drag(_working, const Offset(0, 700));
      await tester.pumpAndSettle();
      rect = tester.getRect(_working);
      expect(rect.bottom, 640 - _bottom);
      // A short nudge stays in its corner.
      await tester.drag(_working, const Offset(-20, -20));
      await tester.pumpAndSettle();
      expect(tester.getRect(_working).bottom, 640 - _bottom);
      expect(tester.getRect(_working).right, 360 - _side);
    },
  );

  testWidgets(
    'fits 360dp when expanded and never covers the top bar or composer',
    (tester) async {
      final h = await _pump(tester, size: const Size(360, 560), reduced: true);
      await _emit(tester, h, stepEvent());
      await tester.tap(_working);
      await tester.pumpAndSettle();
      for (final corner in const [
        Offset(-500, -700),
        Offset(500, 0),
        Offset(0, 700),
        Offset(-500, 0),
      ]) {
        await tester.drag(_working, corner);
        await tester.pumpAndSettle();
        final rect = tester.getRect(_working);
        expect(rect.left, greaterThanOrEqualTo(_side));
        expect(rect.right, lessThanOrEqualTo(360 - _side));
        expect(rect.top, greaterThanOrEqualTo(_top));
        expect(rect.bottom, lessThanOrEqualTo(560 - _bottom));
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a wide tablet keeps the pip small and in the corner', (
    tester,
  ) async {
    final h = await _pump(tester, size: const Size(900, 600));
    await _emit(tester, h, stepEvent());
    await tester.tap(_working);
    await tester.pumpAndSettle();
    final rect = tester.getRect(_working);
    expect(rect.width, lessThanOrEqualTo(pipExpandedWidth));
    expect(rect.right, 900 - _side);
  });

  testWidgets('the state is available to screen readers without text on it', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final h = await _pump(tester);
    await _emit(tester, h, stepEvent());
    expect(find.bySemanticsLabel('正在手机上操作'), findsOneWidget);
    await _emit(tester, h, takeoverEvent(TakeoverState.requested));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.bySemanticsLabel('需要你处理'), findsOneWidget);
    semantics.dispose();
  });
}
