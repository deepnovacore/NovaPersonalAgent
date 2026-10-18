import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';
import '../protocol/request_id.dart';
import 'chatgpt_identity.dart';
import 'model_client.dart';

const chatGptResource = 'https://api.openai.com/v1';
const _issuer = 'https://auth.openai.com';
typedef ChatGptRequest =
    Future<Map<String, dynamic>> Function(
      Uri uri, {
      Map<String, String>? form,
      String? bearer,
    });

class ChatGptAccounts {
  ChatGptAccounts({
    this.storage = const FlutterSecureStorage(),
    ChatGptRequest? request,
    Future<bool> Function(Uri)? openBrowser,
  }) : request = request ?? _request,
       openBrowser = openBrowser ?? _openBrowser;
  final FlutterSecureStorage storage;
  final ChatGptRequest request;
  final Future<bool> Function(Uri) openBrowser;
  static const storageKey = 'nova.chatgpt.accounts.v1';
  static const _iosStorage = IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
  );
  static Future<void>? _busy;
  static bool _signingIn = false;
  Completer<Uri>? _pendingCallback;
  void cancelSignIn() {
    final pending = _pendingCallback;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(const AgentFailure('chatgpt_sign_in_cancelled'));
    }
  }

  static final changes = StreamController<void>.broadcast(sync: true);

  // One isolate-wide queue protects rotating tokens across service instances.
  Future<T> _exclusive<T>(Future<T> Function() body) async {
    while (_busy != null) {
      await _busy;
    }
    final release = Completer<void>();
    _busy = release.future;
    try {
      return await body();
    } finally {
      _busy = null;
      release.complete();
    }
  }

  Future<Map<String, dynamic>> read() async {
    final raw = await storage.read(key: storageKey, iOptions: _iosStorage);
    return raw == null
        ? {'accounts': <dynamic>[]}
        : Map<String, dynamic>.from(jsonDecode(raw) as Map);
  }

  Future<void> _save(Map<String, dynamic> data) => storage.write(
    key: storageKey,
    value: jsonEncode(data),
    iOptions: _iosStorage,
  );
  Future<Map<String, dynamic>> metadata() async {
    final data = await read();
    return {
      'active': data['active'],
      'accounts': [
        for (final a in data['accounts'] as List)
          {
            'client_id': a['client_id'],
            'email': a['email'],
            'model': a['model'],
            'signed_in': a['access_token'] != null,
          },
      ],
    };
  }

  Future<Map<String, dynamic>?> active() async {
    final data = await read();
    for (final account in data['accounts'] as List) {
      if (account['client_id'] == data['active']) {
        return Map<String, dynamic>.from(account as Map);
      }
    }
    return null;
  }

  Future<void> signIn({String? clientId, bool enablePlan = false}) async {
    if (_signingIn) throw const AgentFailure('chatgpt_sign_in_pending');
    _signingIn = true;
    HttpServer? server;
    StreamSubscription<HttpRequest>? listener;
    try {
      final prepared = await _exclusive(() async {
        final data = await read();
        data['host_id'] ??= 'urn:uuid:${requestId()}';
        await _save(data);
        final existing = (data['accounts'] as List)
            .where((a) => a['client_id'] == clientId)
            .toList();
        if (clientId != null && existing.length != 1) {
          throw const AgentFailure('chatgpt_account_missing');
        }
        return (
          host: data['host_id'] as String,
          account: existing.isEmpty
              ? null
              : Map<String, dynamic>.from(existing.single as Map),
        );
      });
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final redirect = 'http://127.0.0.1:${server.port}/auth/callback';
      final state = _random(), nonce = _random(), verifier = _random(64);
      final callback = _pendingCallback = Completer<Uri>();
      if (Platform.isIOS) {
        const MethodChannel('nova/chatgpt_browser/v1').setMethodCallHandler((
          call,
        ) async {
          if (call.method == 'closed') cancelSignIn();
        });
      }
      listener = server.listen((incoming) async {
        final uri = incoming.uri;
        if (incoming.method != 'GET' || uri.path != '/auth/callback') {
          incoming.response.statusCode = 404;
        } else if (uri.queryParametersAll['state']?.length != 1 ||
            uri.queryParameters['state'] != state) {
          incoming.response.statusCode = 400;
        } else if (!callback.isCompleted) {
          callback.complete(uri);
          incoming.response.headers.contentType = ContentType.html;
          incoming.response.headers.set('Cache-Control', 'no-store');
          incoming.response.write(
            '<!doctype html><meta name="viewport" content="width=device-width"><p>Return to Nova Personal Agent to finish signing in.</p>',
          );
        }
        await incoming.response.close();
      });
      final account = prepared.account;
      final uri = Uri.parse('$_issuer/api/accounts/authorize').replace(
        queryParameters: {
          'client_id': clientId ?? 'dynamic_agent_client',
          if (clientId == null) 'agent_name_hint': 'Nova Personal Agent',
          'ext_agent_host_id': prepared.host,
          if (account?['id_token'] is String)
            'id_token_hint': account!['id_token'] as String,
          if (account?['email'] is String)
            'login_hint': account!['email'] as String,
          'response_type': 'code',
          'redirect_uri': redirect,
          'scope':
              'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          'resource': chatGptResource,
          'state': state,
          'nonce': nonce,
          'code_challenge_method': 'S256',
          'code_challenge': base64Url
              .encode(sha256.convert(ascii.encode(verifier)).bytes)
              .replaceAll('=', ''),
          if (enablePlan) 'prompt': 'consent',
        },
      );
      if (!await openBrowser(uri)) {
        throw const AgentFailure('chatgpt_browser_unavailable');
      }
      final returned = await callback.future.timeout(
        const Duration(minutes: 5),
      );
      final issued = validateChatGptCallback(returned, state, clientId);
      if (clientId == null) {
        await _exclusive(() async {
          final data = await read();
          final list = data['accounts'] as List;
          if (!list.any((a) => a['client_id'] == issued)) {
            list.add({'client_id': issued});
          }
          await _save(data);
        });
      }
      final tokens = await request(
        Uri.parse('$_issuer/api/accounts/oauth/token'),
        form: {
          'grant_type': 'authorization_code',
          'client_id': issued,
          'code': returned.queryParameters['code']!,
          'code_verifier': verifier,
          'redirect_uri': redirect,
          'resource': chatGptResource,
        },
      );
      final claims = await _identity(
        tokens['id_token'],
        issued,
        nonce: nonce,
        subject: account?['subject'] as String?,
      );
      final registration = _tokens(tokens, {
        'client_id': issued,
        'subject': claims['sub'],
        'email': claims['email'],
        'issuer': _issuer,
        'model': account?['model'],
      });
      await _exclusive(() async {
        final data = await read();
        final list = data['accounts'] as List;
        final index = list.indexWhere((a) => a['client_id'] == issued);
        if (index >= 0 &&
            list[index]['subject'] != null &&
            list[index]['subject'] != claims['sub']) {
          throw const AgentFailure('chatgpt_identity_invalid');
        }
        if (index >= 0) {
          list[index] = registration;
        } else {
          list.add(registration);
        }
        data['active'] = issued;
        await _save(data);
      });
      changes.add(null);
    } on TimeoutException {
      throw const AgentFailure('chatgpt_sign_in_timeout');
    } finally {
      await listener?.cancel();
      await server?.close(force: true);
      if (Platform.isIOS) {
        try {
          await const MethodChannel(
            'nova/chatgpt_browser/v1',
          ).invokeMethod<void>('close');
        } catch (_) {}
      }
      _pendingCallback = null;
      if (Platform.isIOS) {
        const MethodChannel(
          'nova/chatgpt_browser/v1',
        ).setMethodCallHandler(null);
      }
      _signingIn = false;
    }
  }

  Future<Map<String, dynamic>> _identity(
    dynamic token,
    String clientId, {
    String? nonce,
    String? subject,
  }) async {
    if (token is! String) throw const AgentFailure('chatgpt_identity_invalid');
    final jwks = await request(Uri.parse('$_issuer/.well-known/jwks.json'));
    return verifyChatGptIdentity(
      token,
      jwks,
      clientId: clientId,
      nonce: nonce,
      subject: subject,
    );
  }

  Map<String, dynamic> _tokens(
    Map<String, dynamic> tokens,
    Map<String, dynamic> old,
  ) {
    if (tokens['access_token'] is! String ||
        (tokens['access_token'] as String).isEmpty ||
        (tokens['token_type'] as String?)?.toLowerCase() != 'bearer' ||
        tokens['expires_in'] is! num ||
        (tokens['expires_in'] as num) <= 0 ||
        (tokens['scope'] == null && old['scopes'] == null)) {
      throw const AgentFailure('chatgpt_token_invalid');
    }
    return {
      ...old,
      'access_token': tokens['access_token'],
      'refresh_token': tokens['refresh_token'] ?? old['refresh_token'],
      'id_token': tokens['id_token'] ?? old['id_token'],
      'scopes': tokens['scope'] is String
          ? (tokens['scope'] as String).split(' ')
          : old['scopes'],
      'expires_at':
          DateTime.now().millisecondsSinceEpoch +
          ((tokens['expires_in'] as num) * 1000).toInt(),
    };
  }

  Future<Map<String, dynamic>> credentials({
    bool allowRefresh = true,
  }) => _exclusive(() async {
    final data = await read();
    final accounts = data['accounts'] as List;
    final index = accounts.indexWhere((a) => a['client_id'] == data['active']);
    if (index < 0) throw const AgentFailure('chatgpt_sign_in_required');
    var account = Map<String, dynamic>.from(accounts[index] as Map);
    if (account['access_token'] == null) {
      throw const AgentFailure('chatgpt_sign_in_required');
    }
    if ((account['expires_at'] as num) <
        DateTime.now().millisecondsSinceEpoch + 60000) {
      if (!allowRefresh) {
        throw const AgentFailure('chatgpt_foreground_refresh_required');
      }
      if (account['refresh_token'] is! String) {
        throw const AgentFailure('chatgpt_sign_in_required');
      }
      try {
        final tokens = await request(
          Uri.parse('$_issuer/api/accounts/oauth/token'),
          form: {
            'grant_type': 'refresh_token',
            'client_id': account['client_id'] as String,
            'refresh_token': account['refresh_token'] as String,
            'resource': chatGptResource,
          },
        );
        if (tokens['id_token'] != null) {
          await _identity(
            tokens['id_token'],
            account['client_id'] as String,
            subject: account['subject'] as String,
          );
        }
        account = _tokens(tokens, account);
        accounts[index] = account;
        await _save(data);
      } on AgentFailure catch (failure) {
        if (const [
          'invalid_grant',
          'invalid_refresh_token',
          'token_expired',
          'refresh_token_expired',
          'refresh_token_invalidated',
          'refresh_token_reused',
        ].contains(failure.code)) {
          _clearTokens(account);
          accounts[index] = account;
          await _save(data);
          changes.add(null);
        }
        rethrow;
      }
    }
    if (!(account['scopes'] as List).contains('chatgpt.tokens.use.direct')) {
      throw const AgentFailure('chatgpt_plan_disabled');
    }
    return account;
  });

  Future<List<Map<String, String>>> models() async {
    final account = await credentials();
    final catalog = await request(
      Uri.parse('$chatGptResource/models'),
      bearer: account['access_token'] as String,
    );
    if (catalog['models'] is! List) {
      throw const AgentFailure('chatgpt_models_invalid');
    }
    return [
      for (final model in catalog['models'] as List)
        if (model['visibility'] == 'list' &&
            model['slug'] is String &&
            model['display_name'] is String)
          {
            'slug': model['slug'] as String,
            'display_name': model['display_name'] as String,
          },
    ];
  }

  Future<void> select(String clientId, {String? model}) => _exclusive(() async {
    final data = await read();
    final account =
        (data['accounts'] as List).singleWhere(
              (a) => a['client_id'] == clientId,
            )
            as Map;
    if (account['access_token'] == null) {
      throw const AgentFailure('chatgpt_sign_in_required');
    }
    if (model != null) account['model'] = model;
    data['active'] = clientId;
    await _save(data);
    changes.add(null);
  });

  Future<void> useApiKey() => _exclusive(() async {
    final data = await read();
    data.remove('active');
    await _save(data);
    changes.add(null);
  });

  /// Returns false if remote revocation could not be confirmed; tokens are still
  /// removed locally, while the issued registration and host identity survive.
  Future<bool> signOut(String clientId) => _exclusive(() async {
    final data = await read();
    final account =
        (data['accounts'] as List).singleWhere(
              (a) => a['client_id'] == clientId,
            )
            as Map;
    var revoked = account['refresh_token'] == null;
    try {
      if (!revoked) {
        final discovery = await request(
          Uri.parse('$_issuer/.well-known/openid-configuration'),
        );
        final endpoint = Uri.parse(discovery['revocation_endpoint'] as String);
        if (discovery['issuer'] != _issuer ||
            endpoint.scheme != 'https' ||
            endpoint.host != 'auth.openai.com') {
          throw const AgentFailure('chatgpt_discovery_invalid');
        }
        await request(
          endpoint,
          form: {
            'token': account['refresh_token'] as String,
            'token_type_hint': 'refresh_token',
            'client_id': clientId,
          },
        );
        revoked = true;
      }
    } catch (_) {
      revoked = false;
    } finally {
      _clearTokens(account);
      await _save(data);
      changes.add(null);
    }
    return revoked;
  });

  static void _clearTokens(Map account) {
    for (final key in [
      'access_token',
      'refresh_token',
      'id_token',
      'expires_at',
      'scopes',
    ]) {
      account.remove(key);
    }
  }

  static Future<bool> _openBrowser(Uri uri) async {
    // Safari View Controller keeps Nova in the foreground while the loopback
    // listener runs. Custom URI callbacks are not supported by this OAuth flow.
    if (Platform.isIOS) {
      return await const MethodChannel(
            'nova/chatgpt_browser/v1',
          ).invokeMethod<bool>('open', {'url': uri.toString()}) ??
          false;
    }
    return launchUrl(uri, mode: LaunchMode.inAppBrowserView);
  }

  static String _random([int count = 32]) {
    final random = Random.secure();
    return base64Url
        .encode(List.generate(count, (_) => random.nextInt(256)))
        .replaceAll('=', '');
  }

  static Future<Map<String, dynamic>> _request(
    Uri uri, {
    Map<String, String>? form,
    String? bearer,
  }) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 20);
    try {
      return await (() async {
        final request = await client.openUrl(
          form == null ? 'GET' : 'POST',
          uri,
        );
        request.followRedirects = false;
        request.headers.set('Accept', 'application/json');
        if (bearer != null) {
          request.headers.set('Authorization', 'Bearer $bearer');
        }
        if (form != null) {
          request.headers.set(
            'Content-Type',
            'application/x-www-form-urlencoded',
          );
          request.write(Uri(queryParameters: form).query);
        }
        final response = await request.close();
        var size = 0;
        final body = await utf8.decoder
            .bind(
              response.map((chunk) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) {
                  throw const AgentFailure('chatgpt_response_too_large');
                }
                return chunk;
              }),
            )
            .join();
        Map<String, dynamic> value = {};
        if (body.isNotEmpty) {
          try {
            value = Map<String, dynamic>.from(jsonDecode(body) as Map);
          } catch (_) {}
        }
        if (response.statusCode != 200) {
          final error = value['error'];
          final code = error is String
              ? error
              : error is Map
              ? error['code']
              : null;
          throw AgentFailure(
            code is String ? code : 'chatgpt_http_${response.statusCode}',
          );
        }
        return value;
      })().timeout(const Duration(seconds: 30));
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw const AgentFailure('chatgpt_network_unavailable');
    } finally {
      client.close(force: true);
    }
  }
}

String validateChatGptCallback(Uri uri, String state, String? clientId) {
  final values = uri.queryParameters;
  if (uri.path != '/auth/callback' ||
      values['state'] != state ||
      uri.queryParametersAll.values.any((v) => v.length != 1)) {
    throw const AgentFailure('chatgpt_state_invalid');
  }
  if (values.containsKey('error')) {
    throw const AgentFailure('chatgpt_authorization_declined');
  }
  final issued = values['client_id'] ?? clientId;
  if (issued == null ||
      issued.isEmpty ||
      issued == 'dynamic_agent_client' ||
      (clientId != null && issued != clientId) ||
      (values['code'] ?? '').isEmpty) {
    throw const AgentFailure('chatgpt_registration_invalid');
  }
  return issued;
}
