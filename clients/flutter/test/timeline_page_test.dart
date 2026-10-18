import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/timeline_page.dart';

void main() {
  test(
    'Timeline preserves every dated and completed item, including old history',
    () {
      final rows = <Map<String, dynamic>>[
        for (var i = 0; i < 12; i++)
          {
            'id': 'old-$i',
            'title': 'old',
            'due': '2020-01-01',
            'status': 'done',
          },
        {
          'id': 'overdue',
          'title': 'past',
          'due': '2026-10-01',
          'status': 'open',
        },
        {
          'id': 'today',
          'title': 'today',
          'due': '2026-10-17',
          'status': 'open',
        },
        {'id': 'waiting', 'title': 'wait', 'status': 'waiting'},
        {'id': 'cancelled', 'title': 'ignore', 'status': 'cancelled'},
      ];
      final groups = timelineGroups({
        'todos': rows,
      }, now: DateTime(2026, 10, 17));
      expect(
        (groups.firstWhere((g) => g['id'] == 'completed')['items'] as List),
        hasLength(12),
      );
      expect(groups.expand((g) => g['items'] as List).length, 15);
      expect(
        groups.firstWhere((g) => g['id'] == 'current')['items'][0]['id'],
        'today',
      );
    },
  );
}
