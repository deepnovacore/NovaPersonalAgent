import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/my_overview.dart';
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;

Future<void> openSettingsItem(WidgetTester tester, String item) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pump();
  await tester.tap(
    find.descendant(
      of: find.byType(BottomAppBarTabs),
      matching: find.text('Me'),
    ),
  );
  await tester.pump();
  await tester.tap(find.text('Settings'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
  await tester.ensureVisible(find.text(item));
  await tester.pump();
  await tester.tap(find.text(item));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> openLibrary(WidgetTester tester, String page) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pump();
  await tester.tap(
    find.descendant(
      of: find.byType(BottomAppBarTabs),
      matching: find.text('Me'),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
  final entry = find.descendant(
    of: find.byType(MyOverview),
    matching: find.text(page == 'Todos' ? 'To-dos' : page),
  );
  await tester.ensureVisible(entry);
  await tester.tap(entry);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}
