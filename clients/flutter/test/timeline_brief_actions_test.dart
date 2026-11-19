import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/timeline_briefs.dart';

Map entryWith(List actions) => {
  'key': 'card',
  'kind': 'timeline',
  'text': '迁移安排',
  'observed_at': DateTime.utc(2026, 1, 2).toIso8601String(),
  'evidence_ids': <String>[],
  'brief': {
    'title': '迁移安排',
    'status_label': '待确认',
    'facts': <Map>[],
    'why_now': '临近截止。',
    'next_steps': <Map>[],
    'actions': actions,
    'uncertainty': '',
  },
};

void main() {
  testWidgets('brief actions fill the composer draft and never send', (
    tester,
  ) async {
    final drafts = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TimelineBriefs(
              entries: [
                entryWith([
                  {'label': '讨论一下', 'kind': 'discuss'},
                  {'label': '起草询问', 'kind': 'draft'},
                  {'label': '第三个', 'kind': 'discuss'},
                ]),
              ],
              onAction: drafts.add,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('讨论一下'), findsOneWidget);
    expect(find.text('起草询问'), findsOneWidget);
    expect(find.text('第三个'), findsNothing, reason: 'at most two actions');
    await tester.tap(find.text('起草询问'));
    expect(drafts.single, contains('迁移安排'));
    expect(drafts.single, contains('草稿'));
  });

  testWidgets('cards without actions or a handler show no buttons', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TimelineBriefs(entries: [entryWith([])], onAction: (_) {}),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(OutlinedButton), findsNothing);
  });
}
