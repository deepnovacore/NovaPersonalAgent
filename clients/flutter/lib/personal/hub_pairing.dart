import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'hub_errors.dart';
export 'hub_errors.dart' show HubPairingException;

final _identifier = RegExp(r'^[a-zA-Z0-9_-]{1,200}$');
final _credential = RegExp(r'^[a-zA-Z0-9_-]{43}$');

class HubPairingInvitation {
  HubPairingInvitation._(
    this.url,
    this.code,
    this.expiresAt,
    this.hubId,
    this.accountId,
  );
  final Uri url;
  final String code, hubId, accountId;
  final DateTime expiresAt;

  factory HubPairingInvitation.parse(String raw, {DateTime? now}) {
    if (utf8.encode(raw).length > 4096) {
      throw const HubPairingException('invalid_qr');
    }
    dynamic value;
    try {
      value = jsonDecode(raw);
    } catch (_) {
      throw const HubPairingException('invalid_qr');
    }
    if (value is! Map) throw const HubPairingException('invalid_qr');
    if (value['type'] != 'nova.hub' || value['version'] != 1) {
      throw const HubPairingException('unsupported_qr');
    }
    if (value['url'] is! String ||
        value['code'] is! String ||
        !_credential.hasMatch(value['code']) ||
        value['expires_at'] is! int ||
        value['hub_id'] is! String ||
        !_identifier.hasMatch(value['hub_id']) ||
        value['account_id'] is! String ||
        !_identifier.hasMatch(value['account_id'])) {
      throw const HubPairingException('invalid_qr');
    }
    final rawUrl = value['url'] as String;
    final url = Uri.tryParse(rawUrl);
    if (rawUrl.contains('@') ||
        url == null ||
        url.scheme != 'https' ||
        !RegExp(
          r'^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$',
          caseSensitive: false,
        ).hasMatch(url.host) ||
        url.userInfo.isNotEmpty ||
        url.hasQuery ||
        url.hasFragment ||
        (url.path.isNotEmpty && url.path != '/') ||
        url.port < 1 ||
        url.port > 65535) {
      throw const HubPairingException('tailscale_required');
    }
    DateTime expiry;
    try {
      expiry = DateTime.fromMillisecondsSinceEpoch(
        value['expires_at'],
        isUtc: true,
      );
    } catch (_) {
      throw const HubPairingException('invalid_qr');
    }
    if (!expiry.isAfter(now ?? DateTime.now())) {
      throw const HubPairingException('expired');
    }
    return HubPairingInvitation._(
      url,
      value['code'],
      expiry,
      value['hub_id'],
      value['account_id'],
    );
  }

  void checkIdentity({required String? accountId, required String? hubId}) {
    if (accountId != null && accountId != this.accountId) {
      throw const HubPairingException('account_mismatch');
    }
    if (hubId != null && hubId != this.hubId) {
      throw const HubPairingException('hub_identity_changed');
    }
  }
}

class HubPairingCredential {
  HubPairingCredential._(this.token);
  final String token;
  factory HubPairingCredential.parse(
    dynamic value,
    HubPairingInvitation invitation,
  ) {
    if (value is! Map ||
        value['hub_id'] != invitation.hubId ||
        value['account_id'] != invitation.accountId ||
        value['device_id'] is! String ||
        !_identifier.hasMatch(value['device_id']) ||
        value['token'] is! String ||
        !_credential.hasMatch(value['token'])) {
      throw const HubPairingException('invalid_response');
    }
    return HubPairingCredential._(value['token']);
  }
}

class HubPairingClient {
  HubPairingClient({HttpClient Function()? clientFactory})
    : _clientFactory = clientFactory ?? HttpClient.new;
  final HttpClient Function() _clientFactory;
  Future<HubPairingCredential> redeem(
    HubPairingInvitation invitation, {
    required String deviceName,
  }) async {
    if (!invitation.expiresAt.isAfter(DateTime.now())) {
      throw const HubPairingException('expired');
    }
    final client = _clientFactory()
      ..connectionTimeout = const Duration(seconds: 10);
    try {
      return await _redeem(
        client,
        invitation,
        deviceName,
      ).timeout(const Duration(seconds: 15));
    } finally {
      client.close(force: true);
    }
  }

  Future<HubPairingCredential> _redeem(
    HttpClient client,
    HubPairingInvitation invitation,
    String deviceName,
  ) async {
    final name = deviceName.trim();
    if (name.isEmpty || name.length > 100) {
      throw const HubPairingException('invalid_request');
    }
    final request = await client.postUrl(
      invitation.url.replace(path: '/hub/v1/pairing/redeem'),
    );
    request.followRedirects = false;
    request.headers.contentType = ContentType.json;
    request.write(
      jsonEncode({
        'code': invitation.code,
        'device_name': name,
        'hub_id': invitation.hubId,
        'account_id': invitation.accountId,
      }),
    );
    final response = await request.close();
    final bytes = <int>[];
    await for (final chunk in response) {
      bytes.addAll(chunk);
      if (bytes.length > 16384) {
        throw const HubPairingException('invalid_response');
      }
    }
    dynamic value;
    try {
      value = jsonDecode(utf8.decode(bytes));
    } catch (_) {
      throw const HubPairingException('invalid_response');
    }
    if (response.statusCode != 200) {
      final code = value is Map ? value['error'] : null;
      throw HubPairingException(
        const [
              'invalid_pairing',
              'pairing_identity_mismatch',
              'device_capacity',
              'rate_limited',
            ].contains(code)
            ? code as String
            : 'invalid_response',
      );
    }
    return HubPairingCredential.parse(value, invitation);
  }
}
