import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'model_client.dart';

List<int> _decode(String value) => base64Url.decode(base64Url.normalize(value));
BigInt _integer(List<int> bytes) =>
    bytes.fold(BigInt.zero, (a, b) => (a << 8) | BigInt.from(b));

/// Strict RS256 verification using public-key modular exponentiation and the
/// complete EMSA-PKCS1-v1_5 encoding, never a substring/digest-only comparison.
Map<String, dynamic> verifyChatGptIdentity(
  String token,
  Map<String, dynamic> jwks, {
  required String clientId,
  String? nonce,
  String? subject,
  DateTime? now,
}) {
  try {
    if (token.length > 65536 || (jwks['keys'] as List).length > 128) {
      throw const FormatException();
    }
    final parts = token.split('.');
    if (parts.length != 3) throw const FormatException();
    final header = jsonDecode(utf8.decode(_decode(parts[0]))) as Map;
    if (header['alg'] != 'RS256' ||
        header['kid'] is! String ||
        header.containsKey('crit')) {
      throw const FormatException();
    }
    final key =
        (jwks['keys'] as List)
                .where(
                  (k) =>
                      k['kid'] == header['kid'] &&
                      k['kty'] == 'RSA' &&
                      (k['use'] == null || k['use'] == 'sig') &&
                      (k['alg'] == null || k['alg'] == 'RS256'),
                )
                .single
            as Map;
    final modulusBytes = _decode(key['n'] as String);
    final exponentBytes = _decode(key['e'] as String);
    if (modulusBytes.length < 256 ||
        modulusBytes.length > 1024 ||
        exponentBytes.isEmpty ||
        exponentBytes.length > 4) {
      throw const FormatException();
    }
    final modulus = _integer(modulusBytes);
    final exponent = _integer(exponentBytes);
    final signature = _decode(parts[2]);
    if (modulus.bitLength < 2048 ||
        modulus.bitLength > 8192 ||
        exponent < BigInt.from(3) ||
        signature.length != modulusBytes.length ||
        _integer(signature) >= modulus) {
      throw const FormatException();
    }
    final recovered = _integer(signature)
        .modPow(exponent, modulus)
        .toRadixString(16)
        .padLeft(modulusBytes.length * 2, '0');
    final digest = sha256
        .convert(ascii.encode('${parts[0]}.${parts[1]}'))
        .toString();
    const prefix = '3031300d060960864801650304020105000420';
    final padding = modulusBytes.length - 3 - prefix.length ~/ 2 - 32;
    if (padding < 8 || recovered != '0001${'ff' * padding}00$prefix$digest') {
      throw const FormatException();
    }
    final claims = Map<String, dynamic>.from(
      jsonDecode(utf8.decode(_decode(parts[1]))) as Map,
    );
    final audience = claims['aud'];
    final seconds = (now ?? DateTime.now()).millisecondsSinceEpoch ~/ 1000;
    if (claims['iss'] != 'https://auth.openai.com' ||
        !(audience == clientId ||
            audience is List && audience.contains(clientId)) ||
        (claims.containsKey('azp') && claims['azp'] != clientId) ||
        (audience is List &&
            audience.length > 1 &&
            claims['azp'] != clientId) ||
        claims['exp'] is! num ||
        !(claims['exp'] as num).isFinite ||
        (claims['exp'] as num) <= seconds ||
        claims['iat'] is! num ||
        !(claims['iat'] as num).isFinite ||
        (claims['iat'] as num) > seconds + 5 ||
        (claims['nbf'] is num && (claims['nbf'] as num) > seconds + 5) ||
        claims['sub'] is! String ||
        (claims['sub'] as String).isEmpty ||
        (nonce != null && claims['nonce'] != nonce) ||
        (subject != null && claims['sub'] != subject)) {
      throw const FormatException();
    }
    return claims;
  } catch (_) {
    throw const AgentFailure('chatgpt_identity_invalid');
  }
}
