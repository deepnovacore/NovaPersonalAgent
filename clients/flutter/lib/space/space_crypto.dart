import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart' as hashes;
import 'package:cryptography/cryptography.dart' as crypto;
import 'package:jose/jose.dart';
import 'package:pointycastle/export.dart' as pc;
import 'package:pointycastle/key_derivators/concat_kdf.dart' as pc;
import 'package:flutter/foundation.dart' show debugPrint;
import 'space_storage.dart';

String b64url(List<int> value) => base64UrlEncode(value).replaceAll('=', '');
List<int> unb64(String value) => base64Url.decode(base64Url.normalize(value));
List<int> randomBytes(int size) {
  final r = Random.secure();
  return List.generate(size, (_) => r.nextInt(256));
}

Map<String, dynamic> jsonMap(String value) =>
    Map<String, dynamic>.from(jsonDecode(value) as Map);
List<int> _bigBytes(BigInt n) => List.generate(
  32,
  (i) => ((n >> (8 * (31 - i))) & BigInt.from(255)).toInt(),
);
BigInt _big(List<int> bytes) =>
    bytes.fold(BigInt.zero, (v, b) => (v << 8) | BigInt.from(b));

/// The key file could not be read or written. Transient: callers retry.
class SpaceKeyStorageError implements Exception {
  const SpaceKeyStorageError(this.cause);
  final Object cause;
  @override
  String toString() => 'key_storage_unavailable: $cause';
}

/// A Host-signed key delivery whose wrapped key cannot be used. Permanent:
/// retrying never helps, so callers skip it.
class SpaceInvalidKeyDelivery implements Exception {
  const SpaceInvalidKeyDelivery(this.reason);
  final String reason;
  @override
  String toString() => 'invalid_key_delivery: $reason';
}

/// JOSE compact serialization with mature Ed25519/AES-GCM implementations,
/// PointyCastle P-256/ConcatKDF, and jose's AES key unwrap implementation.
/// Algorithms and protected headers are pinned; unauthenticated payloads never
/// update keys, projections, cursors or device actions.
class SpaceIdentity {
  SpaceIdentity({required this.signing, required this.encryption});
  final Map<String, dynamic> signing, encryption;
  Map<String, dynamic> get signingPublic => {
    'kty': 'OKP',
    'crv': 'Ed25519',
    'x': signing['x'],
  };
  Map<String, dynamic> get encryptionPublic => {
    'kty': 'EC',
    'crv': 'P-256',
    'x': encryption['x'],
    'y': encryption['y'],
  };
  static Future<SpaceIdentity> generate() async {
    final signing = await crypto.Ed25519().newKeyPair();
    final private = await signing.extractPrivateKeyBytes();
    final public = await signing.extractPublicKey();
    final random = pc.FortunaRandom()
      ..seed(pc.KeyParameter(Uint8List.fromList(randomBytes(32))));
    final gen = pc.ECKeyGenerator()
      ..init(
        pc.ParametersWithRandom(
          pc.ECKeyGeneratorParameters(pc.ECDomainParameters('prime256v1')),
          random,
        ),
      );
    final pair = gen.generateKeyPair();
    final secret = pair.privateKey;
    final point = pair.publicKey.Q!;
    return SpaceIdentity(
      signing: {
        'kty': 'OKP',
        'crv': 'Ed25519',
        'x': b64url(public.bytes),
        'd': b64url(private),
      },
      encryption: {
        'kty': 'EC',
        'crv': 'P-256',
        'x': b64url(_bigBytes(point.x!.toBigInteger()!)),
        'y': b64url(_bigBytes(point.y!.toBigInteger()!)),
        'd': b64url(_bigBytes(secret.d!)),
      },
    );
  }

  Map<String, dynamic> toJson() => {
    'signing': signing,
    'encryption': encryption,
  };
  factory SpaceIdentity.fromJson(Map<String, dynamic> value) => SpaceIdentity(
    signing: Map<String, dynamic>.from(value['signing'] as Map),
    encryption: Map<String, dynamic>.from(value['encryption'] as Map),
  );
}

String stableSpaceId(String value) =>
    b64url(hashes.sha256.convert(utf8.encode(value)).bytes);

String signingFingerprint(Map<String, dynamic> key) => b64url(
  hashes.sha256
      .convert(
        utf8.encode(
          jsonEncode({'crv': 'Ed25519', 'kty': 'OKP', 'x': key['x']}),
        ),
      )
      .bytes,
);

String deviceFingerprint(SpaceIdentity identity) => b64url(
  hashes.sha256
      .convert(
        utf8.encode(
          jsonEncode({
            'signing': {
              'crv': 'Ed25519',
              'kty': 'OKP',
              'x': identity.signing['x'],
            },
            'encryption': {
              'crv': 'P-256',
              'kty': 'EC',
              'x': identity.encryption['x'],
              'y': identity.encryption['y'],
            },
          }),
        ),
      )
      .bytes,
);

class SpaceCrypto {
  SpaceCrypto(this.space, this.identity, this.secrets);
  final SpaceRecord space;
  final SpaceIdentity identity;
  final SpacePersistence secrets;

  /// Persisted content-key epoch. Only a delivery signed by the pinned Host
  /// key advances it (see [openEnvelope]); relay responses never do.
  int epoch = 1;
  Map<int, List<int>> keys = {};

  /// Epoch of the current relay session. It is used only to sign the login
  /// proof and gate sealing; it is never persisted and never changes [keys].
  int? sessionEpoch;

  /// Highest epoch seen on any envelope whose Host signature verified. It is
  /// persisted with the keys, never lowered, and blocks sealing while the
  /// Host has rotated past our key: after a revocation the old key may be
  /// held by the revoked member, so nothing is encrypted under it.
  ///
  /// Limit (pre-existing, out of scope): a relay that withholds every piece
  /// of rotation evidence can keep this device on its old epoch. Closing that
  /// needs a Host-authenticated freshness check.
  int observedHostEpoch = 1;

  /// Fires synchronously (with [observedHostEpoch]) whenever the local epoch
  /// or the observed Host epoch changes, including key deliveries whose
  /// [openEnvelope] returns null. Space voice and capability expiry use it.
  Stream<int> get epochEvents => _epochEvents.stream;
  final _epochEvents = StreamController<int>.broadcast(sync: true);

  /// Whether intents can be sealed for the current relay session.
  bool get canSeal =>
      !needsRepair &&
      keys.containsKey(epoch) &&
      epoch >= observedHostEpoch &&
      (sessionEpoch == null || sessionEpoch == epoch);
  Future<void> load() async {
    final raw = await secrets.read();
    Map<String, dynamic>? value;
    if (raw != null) {
      value = jsonMap(raw);
      epoch = value['epoch'] as int? ?? 1;
      keys = (value['keys'] as Map? ?? {}).map(
        (k, v) => MapEntry(int.parse(k as String), unb64(v as String)),
      );
      observedHostEpoch = max(epoch, value['observed'] as int? ?? epoch);
      _durableObserved = observedHostEpoch;
    }
    // Older clients persisted relay-supplied epochs and cleared the keys. A
    // saved epoch without its key was never proven by the Host, and falling
    // back to an older epoch would let a replayed delivery roll it back, so
    // such a binding must be re-paired as a fresh device. Files written by
    // this version always carry `observed` and are never treated as legacy.
    needsRepair =
        value != null &&
        !value.containsKey('observed') &&
        !keys.containsKey(epoch);
  }

  /// Content keys kept for opening older envelopes. Sealing only ever uses
  /// the current epoch's key, and the Host stops using old keys after a
  /// rotation, so retaining a few only lets late content still decrypt.
  static const retainedEpochs = 4;

  /// Read-join-write under a lock shared by every instance in this isolate.
  /// The join is pure: keys are the union of stored and given keys (a stored
  /// key wins a same-epoch conflict), epoch and `observed` are maxima, so no
  /// write — even from a stale instance — removes a key or lowers state.
  /// Only the separate retention rule then drops keys older than the
  /// [retainedEpochs] newest. Memory adopts the result after the write;
  /// [_durableObserved] is what was actually written.
  Future<void> _commit(
    int nextEpoch,
    Map<int, List<int>> nextKeys,
    int seen,
  ) async {
    final String? raw;
    try {
      raw = await secrets.read();
    } catch (error) {
      throw SpaceKeyStorageError(error);
    }
    final joined = <int, List<int>>{...nextKeys};
    if (raw != null) {
      final stored = jsonMap(raw);
      final storedEpoch = stored['epoch'] as int? ?? 1;
      final storedKeys = (stored['keys'] as Map? ?? {}).map(
        (k, v) => MapEntry(int.parse(k as String), unb64(v as String)),
      );
      // A legacy record whose epoch has no key proves nothing; ignore it.
      if (stored.containsKey('observed') ||
          storedKeys.containsKey(storedEpoch)) {
        nextEpoch = max(nextEpoch, storedEpoch);
        seen = max(seen, stored['observed'] as int? ?? storedEpoch);
        storedKeys.forEach((epoch, key) {
          final mine = joined[epoch];
          if (mine != null && b64url(mine) != b64url(key)) {
            debugPrint('[Space] conflicting key for epoch $epoch; kept stored');
          }
          joined[epoch] = key;
        });
      }
    }
    seen = max(seen, nextEpoch);
    final kept = _retain(joined);
    try {
      await secrets.write(
        jsonEncode({
          'epoch': nextEpoch,
          'keys': kept.map((k, v) => MapEntry('$k', b64url(v))),
          'observed': seen,
        }),
      );
    } catch (error) {
      throw SpaceKeyStorageError(error);
    }
    final changed = epoch != nextEpoch || seen > observedHostEpoch;
    epoch = nextEpoch;
    keys = kept;
    observedHostEpoch = max(observedHostEpoch, seen);
    _durableObserved = seen;
    if (changed) _epochEvents.add(observedHostEpoch);
  }

  /// Retention: the [retainedEpochs] newest keys.
  static Map<int, List<int>> _retain(Map<int, List<int>> all) {
    final epochs = all.keys.toList()..sort();
    return {
      for (final epoch in epochs.skip(max(0, epochs.length - retainedEpochs)))
        epoch: all[epoch]!,
    };
  }

  static Future<void> _lock = Future.value();
  Future<T> _locked<T>(Future<T> Function() change) {
    final run = _lock.then((_) => change());
    _lock = run.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return run;
  }

  /// Raise [observedHostEpoch] for Host-verified evidence: synchronously in
  /// memory (so a concurrent seal already refuses, and memory is never
  /// lowered even if the write fails), then durably under the lock.
  Future<void> _observe(int seen) {
    if (needsRepair) return Future.value();
    if (seen > observedHostEpoch) {
      observedHostEpoch = seen;
      _epochEvents.add(seen);
    }
    return _flushObserved();
  }

  /// Persist the live observed epoch if it is ahead of what was written.
  Future<void> _flushObserved() => _locked(() async {
    if (observedHostEpoch > _durableObserved) {
      await _commit(epoch, keys, observedHostEpoch);
    }
  });

  /// The observed epoch actually written by the last commit (or loaded).
  int _durableObserved = 1;

  /// A legacy binding whose saved epoch cannot be trusted. It never seals or
  /// opens anything; re-scanning the Host's code pairs a fresh device.
  bool needsRepair = false;

  /// Serialized install: the epoch is re-checked under the lock, so
  /// concurrent deliveries can never move it backwards. The new state is
  /// persisted before it is published in memory, so a failed write changes
  /// nothing. Returns false when [nextEpoch] is already stale.
  Future<bool> _install(int nextEpoch, List<int> key) async {
    final installed = await _locked(() async {
      if (needsRepair || nextEpoch < epoch) return false;
      await _commit(nextEpoch, {...keys, nextEpoch: key}, observedHostEpoch);
      return true;
    });
    // Evidence raised while the write was in flight is persisted too.
    if (observedHostEpoch > _durableObserved) await _flushObserved();
    return installed;
  }

  /// Unauthenticated routing hint: whether [envelope] carries a wrapped key.
  /// Callers must still open it, which verifies the Host signature.
  static bool isKeyDelivery(Map<String, dynamic> envelope) {
    try {
      final compact = utf8.decode(base64Decode(envelope['body'] as String));
      return jsonMap(utf8.decode(unb64(compact.split('.').first)))['alg'] ==
          'ECDH-ES+A256KW';
    } catch (_) {
      return false;
    }
  }

  Future<String> signControl(
    Map<String, dynamic> payload, {
    String type = 'nova-control+jws',
  }) async {
    final header = b64url(
      utf8.encode(jsonEncode({'alg': 'EdDSA', 'typ': type})),
    );
    final body = b64url(utf8.encode(jsonEncode(payload)));
    final key = await crypto.Ed25519().newKeyPairFromSeed(
      unb64(identity.signing['d'] as String),
    );
    final sig = await crypto.Ed25519().sign(
      utf8.encode('$header.$body'),
      keyPair: key,
    );
    return '$header.$body.${b64url(sig.bytes)}';
  }

  static Future<Map<String, dynamic>> verifyJws(
    String compact,
    Map<String, dynamic> public, {
    required String type,
  }) async {
    final parts = compact.split('.');
    if (parts.length != 3) throw StateError('invalid_jws');
    final header = jsonMap(utf8.decode(unb64(parts[0])));
    if (header['alg'] != 'EdDSA' ||
        header['typ'] != type ||
        header.containsKey('crit') ||
        header['b64'] == false ||
        header.keys.any((k) => !['alg', 'typ'].contains(k))) {
      throw StateError('invalid_jws_header');
    }
    if (public['kty'] != 'OKP' || public['crv'] != 'Ed25519') {
      throw StateError('invalid_host_key');
    }
    final valid = await crypto.Ed25519().verify(
      utf8.encode('${parts[0]}.${parts[1]}'),
      signature: crypto.Signature(
        unb64(parts[2]),
        publicKey: crypto.SimplePublicKey(
          unb64(public['x'] as String),
          type: crypto.KeyPairType.ed25519,
        ),
      ),
    );
    if (!valid) throw StateError('invalid_signature');
    return jsonMap(utf8.decode(unb64(parts[1])));
  }

  Map<String, dynamic> unsigned(Map<String, dynamic> envelope) => {
    for (final key in [
      'v',
      'space',
      'id',
      'from',
      'to',
      'chan',
      'epoch',
      'expiresAt',
      'body',
    ])
      key: envelope[key],
  };
  Future<Map<String, dynamic>> seal(
    Map<String, dynamic> payload, {
    required String id,
    String channel = 'mailbox',
    int? expiresAt,
  }) async {
    if (needsRepair) throw StateError('needs_repair');
    for (var attempt = 0; attempt < 3; attempt++) {
      // Epoch and key are captured together; a rotation installed while this
      // seal awaits discards the result instead of mislabelling it.
      final sealedEpoch = epoch;
      final key = keys[sealedEpoch];
      if (key == null ||
          sealedEpoch < observedHostEpoch ||
          (sessionEpoch != null && sessionEpoch! > sealedEpoch)) {
        throw StateError('waiting_for_host_key');
      }
      if (sessionEpoch != null && sessionEpoch! < sealedEpoch) {
        throw StateError('stale_relay_epoch');
      }
      final body = await encryptBody(payload, key);
      final envelope = {
        'v': 1,
        'space': space.remoteSpace,
        'id': id,
        'from': space.device,
        'to': space.hostDevice,
        'chan': channel,
        'epoch': sealedEpoch,
        'expiresAt': expiresAt,
        'body': body,
      };
      envelope['sig'] = base64Encode(
        utf8.encode(await signControl(envelope, type: 'nova-envelope+jws')),
      );
      if (epoch == sealedEpoch && observedHostEpoch <= sealedEpoch) {
        return envelope;
      }
    }
    throw StateError('waiting_for_host_key');
  }

  static Future<String> encryptBody(
    Map<String, dynamic> payload,
    List<int> key,
  ) async {
    final header = b64url(
      utf8.encode(jsonEncode({'alg': 'dir', 'enc': 'A256GCM'})),
    );
    final box = await crypto.AesGcm.with256bits().encrypt(
      utf8.encode(jsonEncode(payload)),
      secretKey: crypto.SecretKey(key),
      aad: utf8.encode(header),
    );
    return base64Encode(
      utf8.encode(
        '$header..${b64url(box.nonce)}.${b64url(box.cipherText)}.${b64url(box.mac.bytes)}',
      ),
    );
  }

  /// Whether [envelope] is routed to this device and signed by the pinned
  /// Host key. Nothing is decrypted or installed.
  /// Verified envelopes for a newer epoch are recorded as rotation evidence
  /// (durably) before this returns; storage errors propagate.
  Future<bool> verifyAndObserve(Map<String, dynamic> envelope) async {
    try {
      await _verifyHost(envelope);
    } catch (_) {
      return false;
    }
    final seen = envelope['epoch'] as int;
    if (seen > epoch) await _observe(seen);
    return true;
  }

  Future<void> _verifyHost(Map<String, dynamic> envelope) async {
    if (envelope['v'] != 1 ||
        envelope['space'] != space.remoteSpace ||
        envelope['from'] != space.hostDevice ||
        envelope['to'] != space.device ||
        envelope['epoch'] is! int ||
        (envelope['epoch'] as int) < 1 ||
        envelope['sig'] is! String) {
      throw StateError('invalid_envelope_route');
    }
    if (envelope['expiresAt'] != null &&
        (envelope['expiresAt'] as int) <
            DateTime.now().millisecondsSinceEpoch) {
      throw StateError('expired_envelope');
    }
    final signed = await verifyJws(
      utf8.decode(base64Decode(envelope['sig'] as String)),
      space.hostSigningKey!,
      type: 'nova-envelope+jws',
    );
    if (jsonEncode(signed) != jsonEncode(unsigned(envelope))) {
      throw StateError('signed_envelope_mismatch');
    }
  }

  Future<Map<String, dynamic>?> openEnvelope(
    Map<String, dynamic> envelope,
  ) async {
    if (needsRepair) throw StateError('needs_repair');
    await _verifyHost(envelope);
    final envelopeEpoch = envelope['epoch'] as int;
    // Verified evidence of a Host rotation stops sealing with the old key.
    if (envelopeEpoch > epoch) await _observe(envelopeEpoch);
    // Older epochs are stale unless their key is still retained.
    if (envelopeEpoch < epoch && !keys.containsKey(envelopeEpoch)) {
      return null;
    }
    if (isKeyDelivery(envelope)) {
      if (envelope['chan'] != 'mailbox') {
        throw StateError('invalid_key_channel');
      }
      // A key we already hold (including a retained older one) is final.
      if (envelopeEpoch <= epoch && keys.containsKey(envelopeEpoch)) {
        return null;
      }
      // Host-signed and identifiable as a delivery: any format, header or
      // unwrap error is permanent. Only storage errors (in _install) retry.
      final List<int> key;
      try {
        key = await _unwrapDelivery(envelope, envelopeEpoch);
      } on Object catch (error) {
        throw SpaceInvalidKeyDelivery('$error');
      }
      // The only way to move to a newer epoch: an envelope signed by the
      // pinned Host key whose wrapped payload is bound to that epoch and to
      // this device. Older epochs were rejected above.
      await _install(envelopeEpoch, key);
      return null;
    }
    final (parts, header) = _parseJwe(envelope);
    if (header['alg'] != 'dir' || parts[1].isNotEmpty) {
      throw StateError('invalid_jwe_algorithm');
    }
    // Content for a newer epoch, or for an epoch whose key has not arrived,
    // waits for the Host's key delivery; nothing local changes, so the
    // envelope can be retried once the key is installed.
    final cek = envelopeEpoch > epoch
        ? throw StateError('waiting_for_host_key')
        : keys[envelopeEpoch] ?? (throw StateError('waiting_for_host_key'));
    final plain = await crypto.AesGcm.with256bits().decrypt(
      crypto.SecretBox(
        unb64(parts[3]),
        nonce: unb64(parts[2]),
        mac: crypto.Mac(unb64(parts[4])),
      ),
      secretKey: crypto.SecretKey(cek),
      aad: utf8.encode(parts[0]),
    );
    return jsonMap(utf8.decode(plain));
  }

  static (List<String>, Map<String, dynamic>) _parseJwe(
    Map<String, dynamic> envelope,
  ) {
    final compact = utf8.decode(base64Decode(envelope['body'] as String));
    final parts = compact.split('.');
    if (parts.length != 5) throw StateError('invalid_jwe');
    final header = jsonMap(utf8.decode(unb64(parts[0])));
    if (header['enc'] != 'A256GCM' ||
        header.containsKey('crit') ||
        header.containsKey('zip')) {
      throw StateError('invalid_jwe_header');
    }
    return (parts, header);
  }

  /// Unwrap and check a delivery's content key; any failure is permanent.
  Future<List<int>> _unwrapDelivery(
    Map<String, dynamic> envelope,
    int envelopeEpoch,
  ) async {
    final (parts, header) = _parseJwe(envelope);
    final plain = await crypto.AesGcm.with256bits().decrypt(
      crypto.SecretBox(
        unb64(parts[3]),
        nonce: unb64(parts[2]),
        mac: crypto.Mac(unb64(parts[4])),
      ),
      secretKey: crypto.SecretKey(_unwrap(parts, header)),
      aad: utf8.encode(parts[0]),
    );
    final payload = jsonMap(utf8.decode(plain));
    if (payload['v'] != 1 ||
        payload['space'] != space.remoteSpace ||
        payload['epoch'] != envelopeEpoch ||
        payload['recipient'] != space.device) {
      throw StateError('invalid_key_binding');
    }
    final key = unb64(payload['key'] as String);
    if (key.length != 32) throw StateError('invalid_content_key');
    return key;
  }

  List<int> _unwrap(List<String> parts, Map<String, dynamic> header) {
    final epk = Map<String, dynamic>.from(header['epk'] as Map);
    if (epk['kty'] != 'EC' || epk['crv'] != 'P-256' || epk.containsKey('d')) {
      throw StateError('invalid_ephemeral_key');
    }
    final domain = pc.ECDomainParameters('prime256v1');
    final point = domain.curve.decodePoint(
      Uint8List.fromList([
        4,
        ...unb64(epk['x'] as String),
        ...unb64(epk['y'] as String),
      ]),
    );
    if (point == null || point.isInfinity) {
      throw StateError('invalid_ephemeral_point');
    }
    final agreement = pc.ECDHBasicAgreement()
      ..init(
        pc.ECPrivateKey(
          _big(unb64(identity.encryption['d'] as String)),
          domain,
        ),
      );
    final z = _bigBytes(
      agreement.calculateAgreement(pc.ECPublicKey(point, domain)),
    );
    List<int> lengthPrefixed(List<int> v) => [..._uint32(v.length), ...v];
    final other = [
      ...lengthPrefixed(utf8.encode('ECDH-ES+A256KW')),
      ...lengthPrefixed(
        header['apu'] == null ? [] : unb64(header['apu'] as String),
      ),
      ...lengthPrefixed(
        header['apv'] == null ? [] : unb64(header['apv'] as String),
      ),
      ..._uint32(256),
    ];
    final kdf = pc.ConcatKDFDerivator(pc.SHA256Digest())
      ..init(
        pc.HkdfParameters(
          Uint8List.fromList(z),
          256,
          Uint8List.fromList(other),
        ),
      );
    final kek = Uint8List(32);
    kdf.deriveKey(Uint8List(0), 0, kek, 0);
    final wrapping = JsonWebKey.fromJson({
      'kty': 'oct',
      'k': b64url(kek),
      'alg': 'A256KW',
      'use': 'key',
    });
    final key = wrapping.unwrapKey(unb64(parts[1]), algorithm: 'A256KW');
    return unb64(key['k'] as String);
  }

  List<int> _uint32(int value) => [
    (value >> 24) & 255,
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
  ];
}
