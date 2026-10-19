import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/components.dart';

Future<void> openSettingsItem(WidgetTester tester, String item) async {
  await tester.tap(find.byTooltip('Settings'));
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
  await tester.tap(find.widgetWithText(NovaTile, page));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}
