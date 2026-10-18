import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../../personal/local_life.dart';
import '../../personal/life_reducer.dart';
import 'api.dart';

part 'app_registration.dart';

const feishuReadScopes = [
  'offline_access',
  'im:chat:read',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
];

class FeishuAuthorizationSession {
  FeishuAuthorizationSession(
    this.verificationUri,
    this.userCode,
    this.expiresAt,
  );
  final Uri verificationUri;
  final String userCode;
  final DateTime expiresAt;
}

/// One device owns this token family. Other devices authorize independently.
class FeishuAuth extends ChangeNotifier {
  FeishuAuth(this.persistence, this.api, {DateTime Function()? now})
    : now = now ?? DateTime.now;
  final LifePersistence persistence;
  final FeishuApi api;
  final DateTime Function() now;
  Map<String, dynamic> _data = {'version': 1, 'generation': 0};
  int _generation = 0;
  Future<void> _writes = Future.value();
  Future<String>? _refresh;
  bool _disposed = false, _polling = false;
  Map<String, dynamic>? _pending;
  Map<String, dynamic>? _registration;
  bool get configured => _data['app'] is Map;
  bool get authorized =>
      _data['generation'] == _generation &&
      _data['credential'] is Map &&
      _data['identity'] is Map;
  int get generation => _generation;
  String get brand => _data['app']['brand'] as String;
  String? get appId => configured ? _data['app']['app_id'] as String : null;
  Map<String, dynamic>? get identity =>
      authorized ? copyJson(_data['identity']) : null;
  String? get identityKey => authorized
      ? '$brand:$appId:${identity!['tenant_key'] ?? ''}:${identity!['open_id']}'
      : null;
  bool get revocationPending => _data['revocation'] != null;
  void _check(int generation) {
    if (_disposed || generation != _generation) {
      throw const FeishuFailure('authorization_changed');
    }
  }

  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final parsed = jsonDecode(raw) as Map<String, dynamic>;
      if (parsed['version'] != 1 || parsed['generation'] is! int) {
        throw const FeishuFailure('invalid_credential_store');
      }
      _data = parsed;
      _generation = parsed['generation'] as int;
      if (_data['refreshing'] == true) {
        await _save({
          ..._data,
          'credential': null,
          'identity': null,
          'refreshing': false,
        }, _generation);
      }
    }
  }

  Future<void> _save(Map<String, dynamic> next, int generation) {
    final result = _writes.then((_) async {
      _check(generation);
      await persistence.write(jsonEncode(next));
      _check(generation);
      _data = next;
      notifyListeners();
    });
    _writes = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> bindApp({
    required String brand,
    required String appId,
    required String secret,
  }) async {
    api.accounts(brand);
    if (!RegExp(r'^cli_[A-Za-z0-9_-]+$').hasMatch(appId) ||
        secret.isEmpty ||
        secret.length > 4096 ||
        appId.length > 200) {
      throw const FeishuFailure('invalid_app');
    }
    if (revocationPending) throw const FeishuFailure('revocation_pending');
    final generation = ++_generation;
    _pending = null;
    await _save({
      'version': 1,
      'generation': generation,
      'app': {'brand': brand, 'app_id': appId, 'secret': secret},
    }, generation);
  }

  Future<FeishuAuthorizationSession> beginAuthorization() async {
    if (!configured || revocationPending) {
      throw const FeishuFailure('app_required');
    }
    final generation = ++_generation;
    _pending = null;
    final app = Map<String, dynamic>.from(_data['app'] as Map);
    await _save({
      'version': 1,
      'generation': generation,
      'app': app,
    }, generation);
    final result = await api.oauth(
      app['brand'],
      '/oauth/v1/device_authorization',
      {'client_id': app['app_id'], 'scope': feishuReadScopes.join(' ')},
      basic: base64Encode(utf8.encode('${app['app_id']}:${app['secret']}')),
    );
    _check(generation);
    final data = result.data;
    if (result.status != 200 || data['error'] != null) {
      throw const FeishuFailure('authorization_unavailable');
    }
    final code = data['device_code'],
        user = data['user_code'],
        expiry = data['expires_in'],
        interval = data['interval'];
    final uri = api.verificationUri(
      app['brand'],
      (data['verification_uri_complete'] ?? data['verification_uri'])
              as String? ??
          '',
    );
    if (code is! String ||
        code.isEmpty ||
        user is! String ||
        expiry is! int ||
        expiry <= 0 ||
        interval is! int ||
        interval <= 0) {
      throw const FeishuFailure('invalid_authorization_response');
    }
    final expires = now().add(Duration(seconds: expiry));
    _pending = {
      'device_code': code,
      'generation': generation,
      'expires': expires,
      'interval': interval,
      'next': now().add(Duration(seconds: interval)),
    };
    return FeishuAuthorizationSession(uri, user, expires);
  }

  Future<bool> pollAuthorization() async {
    final pending = _pending;
    if (pending == null) throw const FeishuFailure('authorization_required');
    final generation = pending['generation'] as int;
    _check(generation);
    if (!now().isBefore(pending['expires'] as DateTime)) {
      _pending = null;
      throw const FeishuFailure('authorization_expired');
    }
    if (_polling || now().isBefore(pending['next'] as DateTime)) return false;
    _polling = true;
    try {
      final app = Map<String, dynamic>.from(_data['app'] as Map);
      pending['next'] = now().add(
        Duration(seconds: pending['interval'] as int),
      );
      final result = await api.oauth(app['brand'], '/oauth/v3/token', {
        'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
        'device_code': pending['device_code'],
        'client_id': app['app_id'],
        'client_secret': app['secret'],
      });
      _check(generation);
      if (result.data['error'] == 'authorization_pending') return false;
      if (result.data['error'] == 'slow_down') {
        pending['interval'] = (pending['interval'] as int) + 5;
        pending['next'] = now().add(
          Duration(seconds: pending['interval'] as int),
        );
        return false;
      }
      if (result.status != 200 || result.data['error'] != null) {
        _pending = null;
        throw const FeishuFailure('authorization_denied_or_expired');
      }
      final credential = _credential(result.data);
      final identity = await api.get(
        app['brand'],
        '/open-apis/authen/v1/user_info',
        credential['access_token'],
      );
      _check(generation);
      if (identity['open_id'] is! String ||
          (identity['open_id'] as String).isEmpty) {
        throw const FeishuFailure('identity_missing');
      }
      await _save({
        ..._data,
        'credential': credential,
        'identity': {
          'open_id': identity['open_id'],
          'tenant_key': identity['tenant_key'],
          'name': identity['name'] ?? '',
        },
      }, generation);
      _pending = null;
      return true;
    } finally {
      _polling = false;
    }
  }

  Map<String, dynamic> _credential(Map<String, dynamic> data) {
    final scopes = (data['scope'] as String? ?? '')
        .split(RegExp(r'\s+'))
        .toSet();
    if (!feishuReadScopes.every(scopes.contains)) {
      throw const FeishuFailure('missing_scopes');
    }
    if (data['token_type'] != null &&
        data['token_type'].toString().toLowerCase() != 'bearer') {
      throw const FeishuFailure('unsupported_token_binding');
    }
    for (final key in ['access_token', 'refresh_token']) {
      if (data[key] is! String || (data[key] as String).isEmpty) {
        throw const FeishuFailure('invalid_token_response');
      }
    }
    for (final key in ['expires_in', 'refresh_token_expires_in']) {
      if (data[key] is! int || data[key] <= 0) {
        throw const FeishuFailure('invalid_token_expiry');
      }
    }
    return {
      'access_token': data['access_token'],
      'refresh_token': data['refresh_token'],
      'scope': scopes.toList(),
      'expires_at': now()
          .add(Duration(seconds: data['expires_in'] as int))
          .millisecondsSinceEpoch,
      'refresh_expires_at': now()
          .add(Duration(seconds: data['refresh_token_expires_in'] as int))
          .millisecondsSinceEpoch,
    };
  }

  Future<String> accessToken() async {
    if (!authorized) throw const FeishuFailure('authorization_required');
    final credential = _data['credential'] as Map;
    if ((credential['expires_at'] as int) >
        now().millisecondsSinceEpoch + 60000) {
      return credential['access_token'] as String;
    }
    if (_refresh != null) return _refresh!;
    final future = _refreshCredential();
    _refresh = future;
    try {
      return await future;
    } finally {
      if (identical(_refresh, future)) _refresh = null;
    }
  }

  Future<String> _refreshCredential() async {
    final generation = _generation,
        app = copyJson(_data['app']),
        credential = copyJson(_data['credential']);
    if ((credential['refresh_expires_at'] as int) <=
        now().millisecondsSinceEpoch) {
      throw const FeishuFailure('reauthorization_required');
    }
    await _save({..._data, 'refreshing': true}, generation);
    try {
      final response = await api.oauth(app['brand'], '/oauth/v3/token', {
        'grant_type': 'refresh_token',
        'refresh_token': credential['refresh_token'],
        'client_id': app['app_id'],
        'client_secret': app['secret'],
      });
      _check(generation);
      if (response.status != 200 || response.data['error'] != null) {
        throw const FeishuFailure('reauthorization_required');
      }
      final next = _credential(response.data);
      await _save({
        ..._data,
        'credential': next,
        'refreshing': false,
      }, generation);
      return next['access_token'] as String;
    } catch (_) {
      if (generation == _generation) {
        await _save({
          ..._data,
          'credential': null,
          'identity': null,
          'refreshing': false,
        }, generation);
      }
      throw const FeishuFailure('reauthorization_required');
    }
  }

  Future<void> disconnect({bool revoke = false}) async {
    final previous = copyJson(_data), generation = ++_generation;
    _pending = null;
    final token = previous['credential']?['refresh_token'];
    await _save({
      'version': 1,
      'generation': generation,
      'app': previous['app'],
      if (revoke && token != null)
        'revocation': {'app': previous['app'], 'token': token},
      if (previous['revocation'] != null) 'revocation': previous['revocation'],
    }, generation);
    if (revoke && revocationPending) await retryRevocation();
  }

  Future<void> forgetApp() async {
    if (revocationPending) throw const FeishuFailure('revocation_pending');
    final generation = ++_generation;
    _pending = null;
    await _save({'version': 1, 'generation': generation}, generation);
  }

  Future<void> retryRevocation() async {
    final pending = _data['revocation'];
    if (pending == null) return;
    final generation = _generation, app = pending['app'] as Map;
    final response = await api.oauth(app['brand'], '/oauth/v1/revoke', {
      'client_id': app['app_id'],
      'client_secret': app['secret'],
      'token': pending['token'],
      'token_type_hint': 'refresh_token',
    });
    _check(generation);
    if (response.status != 200 ||
        response.data['error'] != null ||
        (response.data['code'] != null && response.data['code'] != 0)) {
      throw const FeishuFailure('revocation_pending');
    }
    await _save({..._data, 'revocation': null}, generation);
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _pending = null;
    super.dispose();
  }
}
