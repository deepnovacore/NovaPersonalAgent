import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/components.dart';
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
  await tester.tap(
    find.widgetWithText(NovaTile, page == 'Todos' ? 'To-dos' : page),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}
