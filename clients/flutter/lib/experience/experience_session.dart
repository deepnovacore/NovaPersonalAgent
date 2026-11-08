// Experience credentials never enter a personal provider configuration.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../agent_core/model_client.dart';
import '../protocol/wire.dart';
import '../space/space_storage.dart';

typedef ExperienceRequest =
    Future<Uint8List> Function(
      Uri uri,
      Map<String, Object>? body,
      String? bearer,
    );

final class ExperienceFailure implements Exception {
  const ExperienceFailure(this.code);
  final String code;

  @override
  String toString() => 'ExperienceFailure($code)';
}

final class ExperienceSession {
  ExperienceSession({FlutterSecureStorage? storage, ExperienceRequest? request})
    : _storage = storage ?? _defaultStorage,
      _request = request; // ignore: prefer_initializing_formals

  static const _defaultStorage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  static const _installationKey = 'novacore.experience.installation.v1';
  static const _authorConversationKey =
      'novacore.experience.author-conversation.v1';
  static const _testerKey = 'novacore.experience.tester.v1';
  static final _credential = RegExp(r'^[A-Za-z0-9_-]{43}$');
  static final _tester = RegExp(r'^[A-Za-z0-9_-]{8,64}$');
  static const profileRequestTimeout = Duration(seconds: 245);
  static final origin = Uri.parse('https://api.deepnovacore.com');

  final FlutterSecureStorage _storage;
  final ExperienceRequest? _request;
  final _http = HttpClient()..connectionTimeout = const Duration(seconds: 8);
  bool _closed = false;
  Future<String>? _redeeming;
  final _tokens = <(String, String), ({String token, int expiresAt})>{};
  final _renewals = <(String, String), Future<String>>{};

  Future<Uint8List> _send(
    Uri uri,
    Map<String, Object>? body,
    String? bearer, {
    int limit = 2048,
    Duration timeout = const Duration(seconds: 8),
  }) async {
    if (_closed) throw const ExperienceFailure('cancelled');
    if (_request case final request?) return request(uri, body, bearer);
    return (() async {
      final request = await _http.postUrl(uri);
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      if (bearer != null) {
        request.headers.set('Authorization', 'Bearer $bearer');
      }
      request.write(jsonEncode(body));
      final response = await request.close();
      if (response.statusCode != 200) {
        await response.drain<void>();
        throw ExperienceFailure(switch (response.statusCode) {
          400 => 'invalid_request',
          401 || 403 => 'enrollment_inactive',
          409 => 'installation_enrolled',
          410 => 'invite_expired',
          429 => 'rate_limited',
          _ => 'unavailable',
        });
      }
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in response) {
        if (bytes.length + chunk.length > limit) {
          throw const ExperienceFailure('invalid_response');
        }
        bytes.add(chunk);
      }
      if (_closed) throw const ExperienceFailure('cancelled');
      return bytes.takeBytes();
    })().timeout(timeout);
  }

  Future<Map<String, dynamic>> _json(
    String path, {
    Map<String, Object>? body,
    String? bearer,
    Map<String, String>? query,
  }) async {
    try {
      return Wire.json(
        await _send(
          origin.replace(path: '/novacore/beta/$path', queryParameters: query),
          body,
          bearer,
        ),
        limit: 2048,
      );
    } on ExperienceFailure {
      rethrow;
    } catch (_) {
      throw const ExperienceFailure('unavailable');
    }
  }

  Future<String> redeem(String code) {
    if (_redeeming != null) {
      return Future.error(const ExperienceFailure('redeem_in_progress'));
    }
    return _redeeming = _redeem(code).whenComplete(() => _redeeming = null);
  }

  Future<String> _redeem(String code) async {
    var secret = await _storage.read(key: _installationKey);
    if (secret == null) {
      secret = base64UrlEncode(
        List<int>.generate(32, (_) => Random.secure().nextInt(256)),
      ).replaceAll('=', '');
      await _storage.write(key: _installationKey, value: secret);
    }
    if (!_credential.hasMatch(secret)) {
      throw const ExperienceFailure('invalid_installation');
    }
    final data = await _json(
      'redeem',
      body: {'code': code.trim(), 'installation_secret': secret},
    );
    final testerId = data['tester_id'];
    if (testerId is! String || !_tester.hasMatch(testerId) || !_isLive(data)) {
      throw const ExperienceFailure('invalid_response');
    }
    await _storage.write(key: _testerKey, value: testerId);
    _tokens.clear();
    return testerId;
  }

  static bool _isLive(Map<String, dynamic> data) =>
      data['expires_at'] is int &&
      (data['expires_at'] as int) > DateTime.now().millisecondsSinceEpoch;

  Future<String> token(String testerId, String scope) async {
    if (await _storage.read(key: _testerKey) != testerId) {
      throw const ExperienceFailure('enrollment_inactive');
    }
    final id = (testerId, scope);
    final cached = _tokens[id];
    final margin = scope == 'profile'
        ? profileRequestTimeout.inMilliseconds
        : 15_000;
    if (cached != null &&
        cached.expiresAt > DateTime.now().millisecondsSinceEpoch + margin) {
      return cached.token;
    }
    return _renewals[id] ??= _renew(testerId, scope).whenComplete(() {
      _renewals.remove(id);
    });
  }

  Future<String> _renew(String testerId, String scope) async {
    final secret = await _storage.read(key: _installationKey);
    if (secret == null || !_credential.hasMatch(secret)) {
      throw const ExperienceFailure('invalid_installation');
    }
    final data = await _json(
      'token',
      body: {'installation_secret': secret, 'scope': scope},
    );
    final token = data['token'];
    if (token is! String ||
        !_credential.hasMatch(token) ||
        !_isLive(data) ||
        data['tester_id'] != testerId ||
        await _storage.read(key: _testerKey) != testerId) {
      throw const ExperienceFailure('invalid_response');
    }
    _tokens[(testerId, scope)] = (
      token: token,
      expiresAt: data['expires_at'] as int,
    );
    return token;
  }

  Future<String> enrolledTester() async {
    final tester = await _storage.read(key: _testerKey);
    if (tester == null || !_tester.hasMatch(tester)) {
      throw const ExperienceFailure('enrollment_required');
    }
    return tester;
  }

  Future<String?> resumeInvite({String scope = 'text'}) async {
    final testerId = await _storage.read(key: _testerKey);
    if (testerId == null || !_tester.hasMatch(testerId)) return null;
    try {
      await token(testerId, scope);
      return testerId;
    } on ExperienceFailure catch (error) {
      if (error.code == 'enrollment_inactive' ||
          error.code == 'invalid_installation') {
        return null;
      }
      rethrow;
    }
  }

  String _authorKey(SpaceRecord space) {
    if (space.mode != SpaceMode.standalone || space.personaId != null) {
      throw StateError('author_model_requires_local_space');
    }
    return SpaceStorage.runScoped(
      space,
      () => SpaceStorage.secureKey(_authorConversationKey),
    );
  }

  Future<String?> authorEnrollment(SpaceRecord space) async {
    final id = await _storage.read(key: _authorKey(space));
    return id != null && _tester.hasMatch(id) ? id : null;
  }

  Future<void> setAuthorEnrollment(SpaceRecord space, String? testerId) async {
    final key = _authorKey(space);
    if (testerId == null) {
      await _storage.delete(key: key);
    } else {
      await token(testerId, 'text');
      await _storage.write(key: key, value: testerId);
    }
  }

  Future<Map<String, dynamic>> refreshPersona(
    String personaId,
    String version,
  ) async {
    final grant = await token(await enrolledTester(), 'profile');
    const limit = 1024 * 1024;
    return Wire.json(
      await _send(
        origin.replace(path: '/novacore/beta/persona-profile'),
        {'persona_id': personaId, 'source_version': version},
        grant,
        timeout: profileRequestTimeout,
        limit: limit,
      ),
      limit: limit,
    );
  }

  Future<ModelConfiguration> model([String? testerId]) async {
    try {
      return ModelConfiguration(
        endpoint: origin.replace(path: '/novacore/beta/v1').toString(),
        model: 'deepseek-flash',
        key: await token(testerId ?? await enrolledTester(), 'text'),
      );
    } on ExperienceFailure catch (error) {
      throw AgentFailure('experience_${error.code}');
    }
  }

  void dispose() {
    _closed = true;
    _http.close(force: true);
    _tokens.clear();
  }
}
