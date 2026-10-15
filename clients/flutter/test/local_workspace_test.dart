import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/local_workspace.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  testWidgets(
    'local workspace shows editable todos without connecting a host',
    (tester) async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Read locally',
      });
      await tester.pumpWidget(
        MaterialApp(home: LocalWorkspace(repository: repo)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Read locally'), findsOneWidget);
      expect(find.text('本机空间'), findsOneWidget);
      expect(find.textContaining('1 项待同步'), findsOneWidget);
      await tester.tap(find.text('Goals'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('New goal'), findsOneWidget);
    },
  );
}
