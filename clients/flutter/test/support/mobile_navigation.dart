import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';

Future<void> openSettingsItem(WidgetTester tester, String item) async {
  await tester.tap(find.byTooltip('Settings').first);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
  await tester.ensureVisible(find.text(item));
  await tester.pump();
  await tester.tap(find.text(item));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> openLibrary(WidgetTester tester, String page) async {
  await openSettingsItem(tester, 'My library');
  await tester.tap(find.widgetWithText(ListTile, page));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}
