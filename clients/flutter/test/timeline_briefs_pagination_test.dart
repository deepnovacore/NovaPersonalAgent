import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/timeline_briefs.dart';

Map<String, dynamic> entry(int i) => {
  'key': '$i',
  'kind': 'timeline',
  'text': '近况 $i',
  'observed_at': DateTime.utc(2026, 1, i).toIso8601String(),
  'evidence_ids': <String>[],
};
void main() {
  testWidgets(
    'effective anchors sort before paging, not just within the visible page',
    (tester) async {
      final rows = [
        {
          ...entry(1),
          'text': 'future activity',
          'time': {
            'anchor_date': '2026-12-11',
            'anchor_basis': 'scheduled',
            'scheduled_on': '2026-12-11',
            'as_of': '2026-11-02',
            'last_reported_on': '2026-01-01',
          },
        },
        for (var i = 2; i <= 9; i++) entry(i),
      ];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: TimelineBriefs(entries: rows)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('future activity'), findsNothing);
      expect(find.text('近况 2'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('继续查看进展'),
        500,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('继续查看进展'));
      await tester.pumpAndSettle();
      expect(find.text('future activity'), findsOneWidget);
      expect(
        find.byKey(
          const ValueKey('brief-timeline-date-2026-01-01T00:00:00.000'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const ValueKey('brief-timeline-date-2026-12-11T00:00:00.000'),
        ),
        findsNothing,
      );
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('timeline-card-1'))).dy,
        greaterThan(
          tester.getTopLeft(find.byKey(const ValueKey('timeline-card-2'))).dy,
        ),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'shared brief list pages by eight and preserves progress across equivalent snapshots',
    (tester) async {
      final rows = [for (var i = 1; i <= 20; i++) entry(i)];
      Future<void> pump(List<Map> entries) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: TimelineBriefs(entries: entries),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await pump(rows);
      expect(find.text('近况 20'), findsOneWidget);
      expect(find.text('近况 12'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('继续查看进展'),
        500,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('继续查看进展'));
      await tester.pumpAndSettle();
      expect(find.text('近况 5'), findsOneWidget);
      expect(find.text('近况 4'), findsNothing);
      await pump([for (final row in rows) Map.of(row)]);
      expect(find.text('近况 5'), findsOneWidget);
      await pump([...rows, entry(21)]);
      expect(find.text('近况 21'), findsOneWidget);
      expect(find.text('近况 5'), findsNothing);
      expect(find.textContaining('条原文 ›'), findsNothing);
      expect(find.textContaining('原始来源已不可用'), findsNothing);
      expect(find.text('原文请在电脑上查看'), findsNWidgets(8));
    },
  );
}
