import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/main.dart' as app;

void main() {
  testWidgets('fresh install chooses a Space before any conversation runtime', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
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
    expect(find.text('新建 Space'), findsOneWidget);
    expect(find.text('每个 Space 的数据与密钥相互独立。'), findsOneWidget);
    expect(find.byTooltip('Settings'), findsNothing);
  });
}
