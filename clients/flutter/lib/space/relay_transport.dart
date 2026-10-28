import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'space_crypto.dart';
import 'space_storage.dart';

class RelayFailure implements Exception {
  const RelayFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

Uri relayUri(String value, {bool allowLoopback = false}) {
  final uri = Uri.parse(value);
  final loopback = ['localhost', '127.0.0.1', '::1'].contains(uri.host);
  if (uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      (uri.scheme != 'https' &&
          !(allowLoopback && loopback && uri.scheme == 'http'))) {
    throw const FormatException('relay_requires_https');
  }
  return uri;
}

class SpaceRelayTransport {
  SpaceRelayTransport(
    this.crypto, {
    HttpClient? http,
    bool allowLoopback = false,
    this.responseBodyTimeout = const Duration(seconds: 20),
  }) : http = http ?? HttpClient(),
       base = relayUri(crypto.space.relay!, allowLoopback: allowLoopback);
  final SpaceCrypto crypto;
  final HttpClient http;
  final Uri base;
  final Duration responseBodyTimeout;
  String? _token;
  int _expiresAt = 0;
  WebSocket? _socket;
  Timer? _heartbeat;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _events.stream;
  bool _disposed = false;
  Future<dynamic> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) async {
    if (_disposed) throw const RelayFailure('closed');
    if (authenticated) await login();
    final req = await http
        .openUrl(method, base.resolve(path))
        .timeout(const Duration(seconds: 15));
    req.followRedirects = false;
    if (authenticated) req.headers.set('authorization', 'Bearer $_token');
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
    }
    final response = await req.close().timeout(const Duration(seconds: 20));
    final iterator = StreamIterator<List<int>>(response);
    late final List<int> chunks;
    try {
      chunks = await (() async {
        final collected = <int>[];
        while (await iterator.moveNext()) {
          collected.addAll(iterator.current);
          if (collected.length > 2 * 1024 * 1024) {
            throw const RelayFailure('response_too_large');
          }
        }
        return collected;
      })().timeout(responseBodyTimeout);
    } catch (error, stack) {
      req.abort(error, stack);
      rethrow;
    } finally {
      await iterator.cancel();
    }
    final result = jsonDecode(utf8.decode(chunks));
    if (response.statusCode != 200) {
      if (response.statusCode == 401) {
        _token = null;
        _expiresAt = 0;
        await _socket?.close();
        _socket = null;
      }
      throw RelayFailure(
        result is Map
            ? result['error'] as String? ?? 'relay_error'
            : 'relay_error',
      );
    }
    return result;
  }

  Future<void> login() async {
    if (_token != null &&
        _expiresAt > DateTime.now().millisecondsSinceEpoch + 30000) {
      return;
    }
    final challenge = Map<String, dynamic>.from(
      await request(
            'POST',
            '/v1/auth/challenge',
            authenticated: false,
            body: {
              'space': crypto.space.remoteSpace,
              'device': crypto.space.device,
            },
          )
          as Map,
    );
    if (challenge['space'] != crypto.space.remoteSpace ||
        challenge['device'] != crypto.space.device) {
      throw const RelayFailure('challenge_binding');
    }
    final epoch = challenge['epoch'] as int;
    await crypto.setEpoch(epoch);
    final proof = await crypto.signControl({
      'v': 1,
      'purpose': 'relay-login',
      'challengeId': challenge['id'],
      'nonce': challenge['nonce'],
      'space': challenge['space'],
      'device': challenge['device'],
      'epoch': epoch,
      'expiresAt': challenge['expiresAt'],
    });
    final session = Map<String, dynamic>.from(
      await request(
            'POST',
            '/v1/auth/session',
            authenticated: false,
            body: {'challengeId': challenge['id'], 'proof': proof},
          )
          as Map,
    );
    final principal = session['principal'] as Map;
    if (session['selected_version'] != 1) {
      throw const RelayFailure('incompatible_business_version');
    }
    if (principal['space'] != crypto.space.remoteSpace ||
        principal['device'] != crypto.space.device ||
        principal['epoch'] != epoch) {
      throw const RelayFailure('session_binding');
    }
    _token = session['token'] as String;
    _expiresAt = session['expiresAt'] as int;
  }

  Future<void> connectLive() async {
    await login();
    if (_socket != null) return;
    final uri = base
        .resolve('/v1/live')
        .replace(scheme: base.scheme == 'https' ? 'wss' : 'ws');
    final ws = await WebSocket.connect(
      uri.toString(),
      headers: {'authorization': 'Bearer $_token'},
    ).timeout(const Duration(seconds: 15));
    if (_disposed) {
      await ws.close();
      return;
    }
    _socket = ws;
    ws.listen(
      (raw) {
        try {
          final value = jsonMap(raw as String);
          if (value['type'] == 'stream') {
            _events.add(Map<String, dynamic>.from(value['envelope'] as Map));
          }
        } catch (error, stack) {
          if (!_disposed) _events.addError(error, stack);
        }
      },
      onError: (Object error) {
        if (!_disposed) _events.addError(error);
      },
      onDone: () {
        if (identical(_socket, ws)) _socket = null;
      },
    );
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
      if (ws.readyState == WebSocket.open) {
        ws.add(jsonEncode({'type': 'heartbeat'}));
      }
    });
  }

  Future<bool> hostOnline() async =>
      (await request(
            'GET',
            '/v1/presence?device=${Uri.encodeQueryComponent(crypto.space.hostDevice!)}',
          )
          as Map)['online'] ==
      true;
  Future<Map<String, dynamic>> pull(int cursor) async =>
      Map<String, dynamic>.from(
        await request('GET', '/v1/mailbox?after=$cursor&limit=2') as Map,
      );
  Future<void> ack(int cursor) async {
    await request('POST', '/v1/mailbox/ack', body: {'cursor': cursor});
  }

  Future<void> send(Map<String, dynamic> envelope) async {
    await request(
      'POST',
      envelope['chan'] == 'stream' ? '/v1/stream' : '/v1/mailbox',
      body: envelope,
    );
  }

  Future<void> dispose() async {
    _disposed = true;
    _heartbeat?.cancel();
    await _socket?.close();
    http.close(force: true);
    await _events.close();
  }
}

class SpaceInvitation {
  SpaceInvitation(this.value, this.relay);
  final Map<String, dynamic> value;
  final String relay;
  String get hostFingerprint => signingFingerprint(
    Map<String, dynamic>.from(value['hostSigningPublicKey'] as Map),
  );
  factory SpaceInvitation.parse(String code, {bool allowLoopback = false}) {
    final value = jsonMap(code.trim());
    final relay = value['relay'] as String;
    relayUri(relay, allowLoopback: allowLoopback);
    if (value['expiresAt'] is! int ||
        (value['expiresAt'] as int) <= DateTime.now().millisecondsSinceEpoch) {
      throw const FormatException('pairing_expired');
    }
    if ((value['business_versions'] as List? ?? []).contains(1) != true) {
      throw const FormatException('incompatible_business_version');
    }
    final invitation = SpaceInvitation(value, relay);
    if (invitation.hostFingerprint != value['space']) {
      throw const FormatException('host_fingerprint_mismatch');
    }
    for (final k in ['id', 'space', 'secret', 'host']) {
      if (value[k] is! String || (value[k] as String).isEmpty) {
        throw const FormatException('invalid_invitation');
      }
    }
    return invitation;
  }
  Future<SpaceRecord> pair(
    String name,
    SpaceCatalog catalog, {
    bool allowLoopback = false,
  }) async {
    final identity = await SpaceIdentity.generate();
    final record = SpaceRecord(
      id: newSpaceId(),
      name: name,
      mode: SpaceMode.client,
      remoteSpace: value['space'] as String,
      hostDevice: value['host'] as String,
      hostSigningKey: Map<String, dynamic>.from(
        value['hostSigningPublicKey'] as Map,
      ),
      relay: relay,
      device: newSpaceId(),
    );
    await SpaceSecurePersistence(
      'nova.space.identity.${record.id}',
    ).write(jsonEncode(identity.toJson()));
    // Persist identity and Space before admission. A lost HTTP response can be
    // recovered by logging in with the same device after Host confirmation.

    final crypto = SpaceCrypto(
      record,
      identity,
      SpaceSecurePersistence('nova.space.keys.${record.id}'),
    );
    final transport = SpaceRelayTransport(crypto, allowLoopback: allowLoopback);
    final proofPayload = {
      'v': 1,
      'purpose': 'pair-request',
      'invitationId': value['id'],
      'secret': value['secret'],
      'device': record.device,
      'signingPublicKey': identity.signingPublic,
      'encryptionPublicKey': identity.encryptionPublic,
      'business_versions': [1],
    };
    final request = {
      'invitationId': value['id'],
      'secret': value['secret'],
      'device': record.device,
      'signingPublicKey': identity.signingPublic,
      'encryptionPublicKey': identity.encryptionPublic,
      'proof': await crypto.signControl(proofPayload),
      'business_versions': [1],
    };
    await SpaceSecurePersistence(
      'nova.space.pair-request.${record.id}',
    ).write(jsonEncode(request));
    await catalog.add(record);
    try {
      await transport.request(
        'POST',
        '/v1/pairing/requests',
        authenticated: false,
        body: request,
      );
    } finally {
      await transport.dispose();
    }
    return record;
  }
}
