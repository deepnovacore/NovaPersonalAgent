import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/hub_pairing.dart';
import 'package:nova_mobile/personal/hub_errors.dart';

void main() {
  final now = DateTime.utc(2026, 10, 19);
  Map<String, dynamic> qr() => {
    'type': 'nova.hub',
    'version': 1,
    'url': 'https://mac.example.ts.net:8443',
    'code': 'A' * 43,
    'expires_at': now.millisecondsSinceEpoch + 300000,
    'hub_id': 'hub-1',
    'account_id': 'account-1',
  };
  test(
    'only bounded current Hub invitations over Tailscale HTTPS are accepted',
    () {
      final invite = HubPairingInvitation.parse(jsonEncode(qr()), now: now);
      expect(invite.url.host, 'mac.example.ts.net');
      for (final url in [
        'https://@mac.example.ts.net',
        'http://mac.example.ts.net',
        'https://ts.net.evil.example',
        'https://mac.example.ts.net@evil.example',
        'https://mac.example.ts.net/?code=secret',
        'https://mac.example.ts.net/#fragment',
        'https://mac.example.ts.net/path',
      ]) {
        expect(
          () => HubPairingInvitation.parse(
            jsonEncode({...qr(), 'url': url}),
            now: now,
          ),
          throwsA(isA<HubPairingException>()),
        );
      }
      for (final change in [
        {'type': 'nova.pair'},
        {'version': 2},
        {'code': 'bad'},
        {'expires_at': now.millisecondsSinceEpoch},
      ]) {
        expect(
          () => HubPairingInvitation.parse(
            jsonEncode({...qr(), ...change}),
            now: now,
          ),
          throwsA(isA<HubPairingException>()),
        );
      }
      expect(
        () => HubPairingInvitation.parse('x' * 4097, now: now),
        throwsA(isA<HubPairingException>()),
      );
    },
  );
  test('existing account and Hub binding are checked before redemption', () {
    final invite = HubPairingInvitation.parse(jsonEncode(qr()), now: now);
    invite.checkIdentity(accountId: null, hubId: null);
    invite.checkIdentity(accountId: 'account-1', hubId: 'hub-1');
    expect(
      () => invite.checkIdentity(accountId: 'other', hubId: 'hub-1'),
      throwsA(isA<HubPairingException>()),
    );
    expect(
      () => invite.checkIdentity(accountId: 'account-1', hubId: 'other'),
      throwsA(isA<HubPairingException>()),
    );
  });
  test('credentials must match the scanned identity and token shape', () {
    final invite = HubPairingInvitation.parse(jsonEncode(qr()), now: now);
    final response = {
      'account_id': 'account-1',
      'hub_id': 'hub-1',
      'device_id': 'device-1',
      'token': 'B' * 43,
    };
    expect(HubPairingCredential.parse(response, invite).token, 'B' * 43);
    expect(
      () =>
          HubPairingCredential.parse({...response, 'hub_id': 'other'}, invite),
      throwsA(isA<HubPairingException>()),
    );
    expect(
      () => HubPairingCredential.parse({...response, 'token': 'short'}, invite),
      throwsA(isA<HubPairingException>()),
    );
  });
  test(
    'safe error copy distinguishes actionable failures without echoing secrets',
    () {
      expect(
        hubErrorMessage(const FormatException('Hub requires HTTPS')),
        contains('HTTPS'),
      );
      expect(hubErrorMessage(StateError('account_mismatch')), contains('账号'));
      expect(
        hubErrorMessage(Exception('Bearer super-secret')),
        isNot(contains('super-secret')),
      );
    },
  );
}
