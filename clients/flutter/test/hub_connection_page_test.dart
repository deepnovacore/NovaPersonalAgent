import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/personal/hub_pairing.dart';
import 'package:nova_mobile/ui/hub_connection_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class CountingPairing extends HubPairingClient {
  int calls = 0;
  @override
  Future<HubPairingCredential> redeem(
    HubPairingInvitation invitation, {
    required String deviceName,
  }) async {
    calls++;
    throw const HubPairingException('invalid_pairing');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'scan only previews host; cancellation never redeems or changes local data',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final host = LifeHost(repository: LocalLife(MemoryLifePersistence()));
      await host.open();
      host.didChangeAppLifecycleState(AppLifecycleState.paused);
      final client = CountingPairing();
      final raw = jsonEncode({
        'type': 'nova.hub',
        'version': 1,
        'url': 'https://mac.example.ts.net:8443',
        'code': 'A' * 43,
        'expires_at': DateTime.now().millisecondsSinceEpoch + 300000,
        'hub_id': 'hub-1',
        'account_id': 'account-1',
      });
      await tester.pumpWidget(
        MaterialApp(
          home: HubConnectionPage(
            host: host,
            language: 'en',
            client: client,
            scanCode: (_) => Future.value(raw),
          ),
        ),
      );
      await tester.tap(find.text('Scan Mac QR code'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.text('https://mac.example.ts.net:8443'), findsOneWidget);
      expect(client.calls, 0);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(client.calls, 0);
      expect(host.hubConfigured, false);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );
}
