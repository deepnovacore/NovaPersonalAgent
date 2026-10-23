import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart' as hashes;
import 'package:cryptography/cryptography.dart' as crypto;
import 'package:jose/jose.dart';
import 'package:pointycastle/export.dart' as pc;
import 'package:pointycastle/key_derivators/concat_kdf.dart' as pc;
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
  int epoch = 1;
  Map<int, List<int>> keys = {};
  Future<void> load() async {
    final raw = await secrets.read();
    if (raw != null) {
      final value = jsonMap(raw);
      epoch = value['epoch'] as int? ?? 1;
      keys = (value['keys'] as Map? ?? {}).map(
        (k, v) => MapEntry(int.parse(k as String), unb64(v as String)),
      );
    }
  }

  Future<void> _persist() => secrets.write(
    jsonEncode({
      'epoch': epoch,
      'keys': keys.map((k, v) => MapEntry('$k', b64url(v))),
    }),
  );
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
    final key = keys[epoch];
    if (key == null) throw StateError('waiting_for_host_key');
    final body = await encryptBody(payload, key);
    final envelope = {
      'v': 1,
      'space': space.remoteSpace,
      'id': id,
      'from': space.device,
      'to': space.hostDevice,
      'chan': channel,
      'epoch': epoch,
      'expiresAt': expiresAt,
      'body': body,
    };
    envelope['sig'] = base64Encode(
      utf8.encode(await signControl(envelope, type: 'nova-envelope+jws')),
    );
    return envelope;
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

  Future<Map<String, dynamic>?> openEnvelope(
    Map<String, dynamic> envelope,
  ) async {
    if (envelope['v'] != 1 ||
        envelope['space'] != space.remoteSpace ||
        envelope['from'] != space.hostDevice ||
        envelope['to'] != space.device ||
        envelope['epoch'] is! int ||
        (envelope['epoch'] as int) > epoch) {
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
    if ((envelope['epoch'] as int) < epoch) return null;
    final compact = utf8.decode(base64Decode(envelope['body'] as String));
    final parts = compact.split('.');
    if (parts.length != 5) throw StateError('invalid_jwe');
    final header = jsonMap(utf8.decode(unb64(parts[0])));
    if (header['enc'] != 'A256GCM' ||
        header.containsKey('crit') ||
        header.containsKey('zip')) {
      throw StateError('invalid_jwe_header');
    }
    List<int> cek;
    if (header['alg'] == 'ECDH-ES+A256KW') {
      cek = _unwrap(parts, header);
    } else if (header['alg'] == 'dir' && parts[1].isEmpty) {
      cek = keys[epoch] ?? (throw StateError('missing_content_key'));
    } else {
      throw StateError('invalid_jwe_algorithm');
    }
    final plain = await crypto.AesGcm.with256bits().decrypt(
      crypto.SecretBox(
        unb64(parts[3]),
        nonce: unb64(parts[2]),
        mac: crypto.Mac(unb64(parts[4])),
      ),
      secretKey: crypto.SecretKey(cek),
      aad: utf8.encode(parts[0]),
    );
    final payload = jsonMap(utf8.decode(plain));
    if (header['alg'] == 'ECDH-ES+A256KW') {
      if (payload['v'] != 1 ||
          payload['space'] != space.remoteSpace ||
          payload['epoch'] != epoch ||
          payload['recipient'] != space.device) {
        throw StateError('invalid_key_binding');
      }
      final key = unb64(payload['key'] as String);
      if (key.length != 32) throw StateError('invalid_content_key');
      keys = {epoch: key};
      await _persist();
      return null;
    }
    return payload;
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
  Future<void> setEpoch(int value) async {
    if (value < epoch) throw StateError('stale_epoch');
    if (value != epoch) {
      epoch = value;
      keys = {};
      await _persist();
    }
  }
}
