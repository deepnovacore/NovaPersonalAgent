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
    bool Function()? beforeWrite,
  }) async {
    if (_disposed) throw const RelayFailure('closed');
    if (authenticated) await login();
    final req = await http
        .openUrl(method, base.resolve(path))
        .timeout(const Duration(seconds: 15));
    req.followRedirects = false;
    if (authenticated) req.headers.set('authorization', 'Bearer $_token');
    // Last check after the awaits above, before any byte is written.
    if (beforeWrite != null && !beforeWrite()) {
      req.abort(const RelayFailure(sendAborted));
      unawaited(req.done.then((_) {}, onError: (Object _) {}));
      throw const RelayFailure(sendAborted);
    }
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
    // A legacy binding with an unproven epoch must be re-paired, not used.
    if (crypto.needsRepair) throw const RelayFailure('needs_repair');
    if (_token != null &&
        _expiresAt > DateTime.now().millisecondsSinceEpoch + 30000 &&
        (crypto.sessionEpoch ?? 0) >= crypto.epoch) {
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
    // The relay's epoch is untrusted: it is only echoed in the signed proof
    // (the relay checks it against the Space) and never persisted or used to
    // drop keys. Content keys advance only via Host-signed key delivery.
    final epoch = challenge['epoch'];
    if (epoch is! int || epoch < 1) {
      throw const RelayFailure('challenge_binding');
    }
    if (epoch < crypto.epoch) throw StateError('stale_epoch');
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
    crypto.sessionEpoch = epoch;
  }

  /// Bearer token of the current relay session, for the media socket.
  String? get sessionToken => _token;
  int get sessionExpiresAt => _expiresAt;

  /// Forces a fresh login even while the current token is still valid; the
  /// media socket renews in-band before its token expires.
  Future<void> renewSession() async {
    _token = null;
    _expiresAt = 0;
    await login();
  }

  /// The relay's media WebSocket endpoint (docs/design/space-voice.md §1).
  Uri get mediaUri => base
      .resolve('/v1/media')
      .replace(scheme: base.scheme == 'https' ? 'wss' : 'ws');

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

  /// Sent nothing: the envelope's epoch is no longer sealable.
  static const sendAborted = 'send_aborted_epoch_changed';

  /// Sends a sealed envelope. Rotation evidence can be verified while login
  /// or the request is pending, so sealability is re-checked right before
  /// the body is written; a stale envelope is never sent.
  Future<void> send(Map<String, dynamic> envelope) async {
    await request(
      'POST',
      envelope['chan'] == 'stream' ? '/v1/stream' : '/v1/mailbox',
      body: envelope,
      beforeWrite: () => envelope['epoch'] == crypto.epoch && crypto.canSeal,
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
  }) => catalog.pairOnce(
    () => _pair(name, catalog, allowLoopback: allowLoopback),
  );
  Future<SpaceRecord> _pair(
    String name,
    SpaceCatalog catalog, {
    required bool allowLoopback,
  }) async {
    final existing = catalog.spaces
        .where(
          (space) =>
              space.mode == SpaceMode.client &&
              space.remoteSpace == value['space'] &&
              space.hostDevice == value['host'] &&
              space.hostSigningKey != null &&
              ['kty', 'crv', 'x', 'y'].every(
                (key) =>
                    space.hostSigningKey![key] ==
                    (value['hostSigningPublicKey'] as Map)[key],
              ),
        )
        .toList();
    final previous =
        existing.where((space) => space.id == catalog.selectedId).firstOrNull ??
        existing.lastOrNull;
    if (previous != null) {
      final reused = await _reusePrevious(
        previous,
        name,
        catalog,
        allowLoopback: allowLoopback,
      );
      if (reused.admitted) return reused.record;
      if (reused.retryScan) {
        return _requestPairing(
          reused.record,
          reused.identity,
          catalog,
          allowLoopback: allowLoopback,
          replaces: null,
        );
      }
    }
    // A new binding, or a fresh device replacing one the relay no longer
    // admits (for example after revocation). The relay keeps revoked device
    // ids and signing keys forever, so they are never presented again.
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
    final identity = await SpaceIdentity.generate();
    await SpaceSecurePersistence(
      'nova.space.identity.${record.id}',
    ).write(jsonEncode(identity.toJson()));
    return _requestPairing(
      record,
      identity,
      catalog,
      allowLoopback: allowLoopback,
      replaces: previous,
    );
  }

  /// Try the saved device for this Host. It is reused only when it is still
  /// admitted, or when this is a retry of the same invitation whose pairing
  /// request was saved (a lost response must replay identical keys).
  Future<
    ({
      SpaceRecord record,
      SpaceIdentity identity,
      bool admitted,
      bool retryScan,
    })
  >
  _reusePrevious(
    SpaceRecord previous,
    String name,
    SpaceCatalog catalog, {
    required bool allowLoopback,
  }) async {
    final record = SpaceRecord(
      id: previous.id,
      name: name,
      mode: previous.mode,
      remoteSpace: previous.remoteSpace,
      hostDevice: previous.hostDevice,
      hostSigningKey: previous.hostSigningKey,
      relay: relay,
      device: previous.device,
    );
    final raw = await SpaceSecurePersistence(
      'nova.space.identity.${record.id}',
    ).read();
    if (raw == null) throw StateError('missing_client_identity');
    final identity = SpaceIdentity.fromJson(jsonMap(raw));
    final crypto = SpaceCrypto(
      record,
      identity,
      SpaceSecurePersistence('nova.space.keys.${record.id}'),
    );
    final transport = SpaceRelayTransport(crypto, allowLoopback: allowLoopback);
    try {
      await crypto.load();
      if (crypto.needsRepair) {
        // A legacy binding with an unproven epoch is never reused; pair a
        // fresh device, which receives a fresh Host key delivery.
        return (
          record: record,
          identity: identity,
          admitted: false,
          retryScan: false,
        );
      }
      await transport.login();
      await catalog.updateBinding(record);
      return (
        record: record,
        identity: identity,
        admitted: true,
        retryScan: false,
      );
    } on RelayFailure catch (error) {
      if (![
        'unknown_device',
        'inactive_device',
        'device_inactive',
      ].contains(error.code)) {
        rethrow;
      }
    } finally {
      await transport.dispose();
    }
    final saved = await SpaceSecurePersistence(
      'nova.space.pair-request.${record.id}',
    ).read();
    final retryScan =
        saved != null &&
        jsonMap(saved)['invitationId'] == value['id'] &&
        jsonMap(saved)['device'] == record.device;
    return (
      record: record,
      identity: identity,
      admitted: false,
      retryScan: retryScan,
    );
  }

  Future<SpaceRecord> _requestPairing(
    SpaceRecord record,
    SpaceIdentity identity,
    SpaceCatalog catalog, {
    required bool allowLoopback,
    required SpaceRecord? replaces,
  }) async {
    // Persist identity and Space before admission. A lost HTTP response can be
    // recovered by logging in with the same device after Host confirmation.
    final crypto = SpaceCrypto(
      record,
      identity,
      SpaceSecurePersistence('nova.space.keys.${record.id}'),
    );
    final transport = SpaceRelayTransport(crypto, allowLoopback: allowLoopback);
    try {
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
      if (replaces != null) {
        // The old binding and its secrets stay untouched: the relay's
        // inactive answer is unauthenticated and a superseded request may
        // still be confirmed. The owner removes it with the Host-confirmed
        // "Clean up old connections" flow.
        await catalog.addBinding(record);
      } else if (catalog.spaces.any((v) => v.id == record.id)) {
        await catalog.updateBinding(record);
      } else {
        await catalog.add(record);
      }
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
