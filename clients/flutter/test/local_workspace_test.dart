import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/local_workspace.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  testWidgets('dismissing focused Hub settings keeps the workspace usable', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    final repo = LocalLife(MemoryLifePersistence());
    await repo.open();
    await tester.pumpWidget(
      MaterialApp(home: LocalWorkspace(repository: repo)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'https://hub.example');
    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pumpAndSettle();
    expect(find.text('连接同步 Hub'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
  });
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
