import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/my_overview.dart';

void main() {
  testWidgets(
    'overview shows saved content, filters completed goals and routes previews',
    (tester) async {
      var opened = -1;
      final life = <String, dynamic>{
        'profile': {'about': 'I build useful tools.', 'version': 1},
        'goals': [
          {'title': 'Done goal', 'status': 'done'},
          {
            'title': 'Ship a useful prototype',
            'status': 'active',
            'note': 'Start with the core experience',
          },
        ],
        'ideas': [
          {
            'title': 'Older thought',
            'status': 'active',
            'updated_at': '2026-01-01',
          },
          {
            'title': 'Latest thought',
            'status': 'active',
            'updated_at': '2026-02-01',
          },
          {'title': 'Archived thought', 'status': 'archived'},
        ],
      };
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MyOverview(
              life: life,
              draft: const {'about': 'Stale draft'},
              language: 'en',
              onOpen: (id) => opened = id,
              onSettings: () {},
            ),
          ),
        ),
      );
      expect(find.text('I build useful tools.'), findsOneWidget);
      expect(find.text('Stale draft'), findsNothing);
      expect(find.text('Done goal'), findsNothing);
      await tester.tap(find.text('Ship a useful prototype'));
      expect(opened, 4);
      await tester.scrollUntilVisible(find.text('Latest thought'), 150);
      expect(find.text('Archived thought'), findsNothing);
      await tester.tap(find.text('Latest thought'));
      expect(opened, 3);
      expect(
        tester.getTopLeft(find.text('Latest thought')).dy,
        lessThan(tester.getTopLeft(find.text('Older thought')).dy),
      );
    },
  );
  testWidgets('cleared profile stays cleared and compact large text fits', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MyOverview(
            life: const {
              'profile': {'about': '', 'version': 2},
            },
            draft: const {'about': 'Stale draft'},
            generatedProfile: const Text('Generated profile'),
            onOpen: (_) {},
            onSettings: () {},
          ),
        ),
      ),
    );
    expect(find.text('Stale draft'), findsNothing);
    expect(find.text('Generated profile'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(ListView), const Offset(0, -800));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
