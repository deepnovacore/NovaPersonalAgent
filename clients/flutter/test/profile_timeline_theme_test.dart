import 'dart:math' as math;
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'experience_test.dart' show fixture;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/my_overview.dart';
import 'package:nova_mobile/ui/timeline_briefs.dart';
import 'package:nova_mobile/ui/timeline_page.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'timeline_axis_test.dart' show timelineStore;

void expectReadable(WidgetTester tester, String text) {
  final finder = find.text(text);
  expect(finder, findsOneWidget);
  final rich = tester.widget<RichText>(
    find.descendant(of: finder, matching: find.byType(RichText)).first,
  );
  final foreground = rich.text.style!.color!;
  Color? background;
  tester.element(finder).visitAncestorElements((element) {
    final widget = element.widget;
    if (widget is Material && widget.color?.a == 1) background = widget.color;
    if (widget is DecoratedBox && widget.decoration is BoxDecoration) {
      final decoration = widget.decoration as BoxDecoration;
      if (decoration.color?.a == 1) background = decoration.color;
      if (decoration.gradient != null) {
        background = decoration.gradient!.colors.first;
      }
    }
    return background == null;
  });
  expect(background, isNotNull);
  final ink = Color.alphaBlend(foreground, background!).computeLuminance();
  final paper = background!.computeLuminance();
  final contrast = (math.max(ink, paper) + .05) / (math.min(ink, paper) + .05);
  expect(
    contrast,
    greaterThanOrEqualTo(4.5),
    reason: '$text must remain readable on its painted background',
  );
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('experience fallback card follows $brightness', (tester) async {
      final bundle = fixture();
      await ExperiencePersona.loadManifest(bundle: bundle);
      rootBundle.clear();
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMessageHandler('flutter/assets', (message) async {
        final bytes = bundle.files[utf8.decode(message!.buffer.asUint8List())];
        return bytes == null ? null : ByteData.sublistView(bytes);
      });
      addTearDown(() {
        messenger.setMockMessageHandler('flutter/assets', null);
        rootBundle.clear();
        ExperiencePersona.choices = const [];
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor: Nova.mint,
              brightness: brightness,
            ),
          ),
          home: Scaffold(
            body: ExperiencePersonaTimeline(
              personaId: 'sample',
              anchor: DateTime.utc(2026),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expectReadable(tester, 'A new idea');
      expectReadable(tester, 'Planning a garden');
      expect(tester.takeException(), isNull);
    });

    final theme = ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: Nova.mint,
        brightness: brightness,
      ),
    );
    testWidgets('Profile text and labels contrast in $brightness', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(
            body: MyOverview(
              language: 'en',
              life: const {
                'profile': {'about': 'Sample profile', 'version': 1},
              },
              draft: const {},
              onOpen: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expectReadable(tester, 'Sample profile');
      expectReadable(tester, 'Profile');
      expectReadable(tester, 'Written by you');
      expectReadable(tester, 'View and edit');
      expect(tester.takeException(), isNull);
    });
    testWidgets('Timeline cards and nested step contrast in $brightness', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(440, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = timelineStore([
        {
          'id': 'sample',
          'title': 'Sample task',
          'due': '2026-01-01',
          'status': 'open',
        },
      ]);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(
            body: TimelinePage(
              store: store,
              language: 'en',
              now: DateTime(2026, 1, 1),
              sourceTimeline: TimelineBriefs(
                onOpenSources: (_) {},
                language: 'en',
                entries: [
                  {
                    'key': 'sample',
                    'observed_at': '2026-01-01T09:00:00Z',
                    'evidence_ids': ['sample-source'],
                    'brief': {
                      'title': 'Sample brief',
                      'facts': [
                        {'text': 'Sample fact'},
                      ],
                      'next_steps': [
                        {
                          'title': 'Sample next step',
                          'detail': 'Sample step detail',
                        },
                      ],
                    },
                  },
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final text in [
        'Sample brief',
        'Sample fact',
        'Sample next step',
        'Sample step detail',
        'Sample task',
      ]) {
        expectReadable(tester, text);
      }
      expect(tester.takeException(), isNull);
    });
  }
}
