import 'dart:convert';
import 'dart:typed_data';
import 'package:jose/jose.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:pointycastle/export.dart' as pc;
import 'package:pointycastle/key_derivators/concat_kdf.dart' as pc;
import 'space_client_test.dart' show MemorySpacePersistence;

/// Test-only Host that signs envelopes and wraps content keys exactly like the
/// TypeScript Host (EdDSA `nova-envelope+jws`, ECDH-ES+A256KW, A256GCM).
class TestHost {
  TestHost(this.identity, {this.device = 'host'});
  final SpaceIdentity identity;
  final String device;
  String get space => signingFingerprint(identity.signingPublic);

  static Future<TestHost> create() async =>
      TestHost(await SpaceIdentity.generate());

  SpaceRecord clientRecord(String device, {String id = 'local'}) => SpaceRecord(
    id: id,
    name: 'Remote',
    mode: SpaceMode.client,
    remoteSpace: space,
    hostDevice: this.device,
    hostSigningKey: identity.signingPublic,
    relay: 'https://relay.example',
    device: device,
  );

  Future<Map<String, dynamic>> _sign(
    Map<String, dynamic> unsigned, {
    SpaceIdentity? signer,
  }) async {
    final crypto = SpaceCrypto(
      clientRecord('signer'),
      signer ?? identity,
      MemorySpacePersistence(),
    );
    return {
      ...unsigned,
      'sig': base64Encode(
        utf8.encode(
          await crypto.signControl(unsigned, type: 'nova-envelope+jws'),
        ),
      ),
    };
  }

  Map<String, dynamic> _unsigned(
    String to,
    String id,
    int epoch,
    String body, {
    String chan = 'mailbox',
  }) => {
    'v': 1,
    'space': space,
    'id': id,
    'from': device,
    'to': to,
    'chan': chan,
    'epoch': epoch,
    'expiresAt': null,
    'body': body,
  };

  /// Host-signed content encrypted with the epoch content key.
  Future<Map<String, dynamic>> content(
    String to,
    Map<String, dynamic> payload, {
    required int epoch,
    required List<int> key,
    String id = 'content',
    String chan = 'mailbox',
  }) async => _sign(
    _unsigned(
      to,
      id,
      epoch,
      await SpaceCrypto.encryptBody(payload, key),
      chan: chan,
    ),
  );

  /// Host-signed key delivery for [epoch] wrapped to the recipient's P-256 key.
  /// [signer] forges the signature with another key; [payloadEpoch] forges the
  /// inner binding.
  Future<Map<String, dynamic>> keyDelivery(
    String to,
    SpaceIdentity recipient, {
    required int epoch,
    required List<int> key,
    SpaceIdentity? signer,
    int? payloadEpoch,
    String chan = 'mailbox',
    String? enc,
  }) async {
    var body = await wrapContentKey({
      'v': 1,
      'space': space,
      'epoch': payloadEpoch ?? epoch,
      'recipient': to,
      'key': b64url(key),
    }, recipient);
    if (enc != null) {
      // Rewrite the protected header's content encryption algorithm.
      final parts = utf8.decode(base64Decode(body)).split('.');
      final header = jsonMap(utf8.decode(unb64(parts[0])))..['enc'] = enc;
      parts[0] = b64url(utf8.encode(jsonEncode(header)));
      body = base64Encode(utf8.encode(parts.join('.')));
    }
    return _sign(
      _unsigned(to, 'key-$epoch-$to', epoch, body, chan: chan),
      signer: signer,
    );
  }
}

List<int> _uint32(int value) => [
  (value >> 24) & 255,
  (value >> 16) & 255,
  (value >> 8) & 255,
  value & 255,
];
BigInt _big(List<int> bytes) =>
    bytes.fold(BigInt.zero, (v, b) => (v << 8) | BigInt.from(b));
List<int> _bytes32(BigInt n) => List.generate(
  32,
  (i) => ((n >> (8 * (31 - i))) & BigInt.from(255)).toInt(),
);

/// JWE compact (ECDH-ES+A256KW / A256GCM), base64-wrapped like the Host body.
Future<String> wrapContentKey(
  Map<String, dynamic> payload,
  SpaceIdentity recipient,
) async {
  final ephemeral = (await SpaceIdentity.generate()).encryption;
  final domain = pc.ECDomainParameters('prime256v1');
  final point = domain.curve.decodePoint(
    Uint8List.fromList([
      4,
      ...unb64(recipient.encryption['x'] as String),
      ...unb64(recipient.encryption['y'] as String),
    ]),
  )!;
  final agreement = pc.ECDHBasicAgreement()
    ..init(pc.ECPrivateKey(_big(unb64(ephemeral['d'] as String)), domain));
  final z = _bytes32(
    agreement.calculateAgreement(pc.ECPublicKey(point, domain)),
  );
  List<int> prefixed(List<int> v) => [..._uint32(v.length), ...v];
  final other = [
    ...prefixed(utf8.encode('ECDH-ES+A256KW')),
    ...prefixed([]),
    ...prefixed([]),
    ..._uint32(256),
  ];
  final kdf = pc.ConcatKDFDerivator(pc.SHA256Digest())
    ..init(
      pc.HkdfParameters(Uint8List.fromList(z), 256, Uint8List.fromList(other)),
    );
  final kek = Uint8List(32);
  kdf.deriveKey(Uint8List(0), 0, kek, 0);
  final cek = randomBytes(32);
  final wrapped =
      JsonWebKey.fromJson({
        'kty': 'oct',
        'k': b64url(kek),
        'alg': 'A256KW',
        'use': 'key',
      }).wrapKey(
        JsonWebKey.fromJson({'kty': 'oct', 'k': b64url(cek)}),
        algorithm: 'A256KW',
      );
  final header = b64url(
    utf8.encode(
      jsonEncode({
        'alg': 'ECDH-ES+A256KW',
        'enc': 'A256GCM',
        'epk': {
          'kty': 'EC',
          'crv': 'P-256',
          'x': ephemeral['x'],
          'y': ephemeral['y'],
        },
      }),
    ),
  );
  final cipher = pc.GCMBlockCipher(pc.AESEngine());
  final nonce = Uint8List.fromList(randomBytes(12));
  cipher.init(
    true,
    pc.AEADParameters(
      pc.KeyParameter(Uint8List.fromList(cek)),
      128,
      nonce,
      Uint8List.fromList(utf8.encode(header)),
    ),
  );
  final sealed = cipher.process(
    Uint8List.fromList(utf8.encode(jsonEncode(payload))),
  );
  final text = sealed.sublist(0, sealed.length - 16);
  final tag = sealed.sublist(sealed.length - 16);
  return base64Encode(
    utf8.encode(
      '$header.${b64url(wrapped)}.${b64url(nonce)}.${b64url(text)}.${b64url(tag)}',
    ),
  );
}

/// Host-side decryption of a client `dir` body with [key].
Future<Map<String, dynamic>> decryptBody(String body, List<int> key) async {
  final parts = utf8.decode(base64Decode(body)).split('.');
  final cipher = pc.GCMBlockCipher(pc.AESEngine())
    ..init(
      false,
      pc.AEADParameters(
        pc.KeyParameter(Uint8List.fromList(key)),
        128,
        Uint8List.fromList(unb64(parts[2])),
        Uint8List.fromList(utf8.encode(parts[0])),
      ),
    );
  final plain = cipher.process(
    Uint8List.fromList([...unb64(parts[3]), ...unb64(parts[4])]),
  );
  return jsonMap(utf8.decode(plain));
}
