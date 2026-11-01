import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/agent/phone_run.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'phone_voice_panel_test.dart' show PanelSession;
import 'support/fake_phone_channel.dart';

class _Setup {
  _Setup(this.channel, this.tracker, this.session);
  final FakePhoneChannel channel;
  final PhoneRunTracker tracker;
  final PanelSession session;
}

Future<_Setup> _pump(
  WidgetTester tester,
  Size size, {
  bool reduced = false,
}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final channel = FakePhoneChannel();
  final tracker = PhoneRunTracker(channel)..start();
  final session = PanelSession();
  addTearDown(() async {
    tracker.dispose();
    await channel.close();
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: MediaQuery(
        data: MediaQueryData(size: size, disableAnimations: reduced),
        child: Scaffold(
          body: PhoneVoicePanel(
            session: session,
            petAvatar: PetAvatarStore(),
            onSettings: () {},
            onStart: () {},
            phoneRun: tracker,
          ),
        ),
      ),
    ),
  );
  return _Setup(channel, tracker, session);
}

Future<void> _emit(WidgetTester tester, _Setup s, PhoneEvent event) async {
  s.channel.emit(event);
  await tester.runAsync(pumpEventQueue);
  await tester.pump(const Duration(milliseconds: 50));
}

final _pet = find.byType(VoicePetVisual);
final _screen = find.byKey(const ValueKey('voice-screen'));

void main() {
  testWidgets('without a phone task only the character shows', (tester) async {
    final s = await _pump(tester, const Size(390, 844));
    expect(_pet, findsOneWidget);
    expect(_screen, findsNothing);
    expect(s.channel.previews, isEmpty);
  });

  testWidgets('a main-screen task does not open the virtual screen', (
    tester,
  ) async {
    final s = await _pump(tester, const Size(390, 844));
    await _emit(tester, s, stepEvent(tier: PhoneTier.main));
    expect(_screen, findsNothing);
    expect(s.channel.previews, isEmpty);
  });

  testWidgets('wide: character and screen sit side by side', (tester) async {
    final s = await _pump(tester, const Size(900, 600), reduced: true);
    await _emit(tester, s, stepEvent());
    expect(
      find.byKey(const ValueKey('voice-pet-and-screen-row')),
      findsOneWidget,
    );
    expect(_pet, findsOneWidget);
    expect(_screen, findsOneWidget);
    final pet = tester.getRect(_pet), screen = tester.getRect(_screen);
    expect(pet.right, lessThanOrEqualTo(screen.left));
    expect(screen.width, lessThanOrEqualTo(180));
    expect(s.channel.previews, [true]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('narrow: the screen sits below the character without overflow', (
    tester,
  ) async {
    final s = await _pump(tester, const Size(360, 700), reduced: true);
    await _emit(tester, s, stepEvent());
    expect(
      find.byKey(const ValueKey('voice-pet-and-screen-column')),
      findsOneWidget,
    );
    final pet = tester.getRect(_pet), screen = tester.getRect(_screen);
    expect(screen.top, greaterThanOrEqualTo(pet.bottom - 1));
    expect(screen.width, lessThanOrEqualTo(140));
    expect(screen.right, lessThanOrEqualTo(360));
    expect(tester.takeException(), isNull);
  });

  for (final size in [const Size(360, 640), const Size(320, 568)]) {
    testWidgets(
      'narrow ${size.width.toInt()}x${size.height.toInt()}: end call and the '
      'captions stay on screen beside the virtual screen',
      (tester) async {
        final s = await _pump(tester, size, reduced: true);
        await _emit(tester, s, stepEvent());
        expect(_screen, findsOneWidget);
        final viewport = Offset.zero & size;
        final end = tester.getRect(find.text('结束通话'));
        expect(viewport.contains(end.center), isTrue);
        expect(end.bottom, lessThanOrEqualTo(size.height));
        // The call controls live outside the scrolling content.
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('voice-call-content')),
            matching: find.text('结束通话'),
          ),
          findsNothing,
        );
        // The captions are inside the viewport without scrolling.
        final captions = tester.getRect(
          find.byKey(const ValueKey('voice-captions')),
        );
        expect(captions.bottom, lessThanOrEqualTo(end.top));
        expect(captions.top, greaterThanOrEqualTo(0));
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('frames reach the screen and the call keeps its controls', (
    tester,
  ) async {
    final s = await _pump(tester, const Size(390, 844), reduced: true);
    await _emit(tester, s, stepEvent());
    s.channel.frameController.add(tinyFrame);
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    expect(
      find.descendant(of: _screen, matching: find.byType(Image)),
      findsOneWidget,
    );
    expect(find.text('静音'), findsOneWidget);
    expect(find.text('结束通话'), findsOneWidget);
  });

  testWidgets('the task ending falls back to the character alone', (
    tester,
  ) async {
    final s = await _pump(tester, const Size(390, 844), reduced: true);
    await _emit(tester, s, stepEvent());
    expect(_screen, findsOneWidget);
    await _emit(tester, s, doneEvent());
    expect(_screen, findsNothing);
    expect(_pet, findsOneWidget);
    expect(s.channel.previews, [true, false]);
  });

  testWidgets('leaving the page stops the frames', (tester) async {
    final s = await _pump(tester, const Size(390, 844), reduced: true);
    await _emit(tester, s, stepEvent());
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(pumpEventQueue);
    expect(s.channel.previews, [true, false]);
  });

  testWidgets('needs-you glows and offers take over / hand back', (
    tester,
  ) async {
    final s = await _pump(tester, const Size(390, 844));
    await _emit(tester, s, stepEvent());
    expect(find.byKey(const ValueKey('voice-screen-working')), findsOneWidget);
    await _emit(tester, s, takeoverEvent(TakeoverState.requested));
    expect(
      find.byKey(const ValueKey('voice-screen-needs-you')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('voice-screen-take-over')));
    await tester.runAsync(pumpEventQueue);
    await tester.pump(const Duration(milliseconds: 50));
    expect(s.channel.calls, contains('takeover:t1'));
    await tester.tap(find.byKey(const ValueKey('voice-screen-hand-back')));
    await tester.runAsync(pumpEventQueue);
    expect(s.channel.calls, contains('handBack:t1'));
  });
}
