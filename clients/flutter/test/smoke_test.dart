import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/main.dart' as app;

void main() {
  testWidgets('fresh install chooses a Space before any conversation runtime', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({'language': 'en'});
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('nova/space_scope'),
      (_) async => null,
    );
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('nova/space_push/events'),
      (_) async => null,
    );
    app.main();
    await tester.pumpAndSettle();
    expect(find.text('New Space'), findsOneWidget);
    expect(
      find.text(
        'Each Space keeps its own data and model settings. Run it on this device or connect to a computer.',
      ),
      findsOneWidget,
    );
    expect(find.byTooltip('Settings'), findsNothing);
  });
}
