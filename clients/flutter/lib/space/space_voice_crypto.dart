// Space voice call crypto (docs/design/space-voice.md §2), the Dart half of
// runtime/src/space-host/voice-crypto.ts. Self-contained and volatile: call
// keys, counters and replay windows live only in memory and are never stored.
// tests/fixtures/space-voice/v1/vectors.json pins both implementations.
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart' as crypto;

const voiceProtocol = 'nova-voice/v1';
const voiceFrameAudio = 1, voiceFrameControl = 2, voiceFrameKeepalive = 3;
const voiceHeaderBytes = 12, voiceTagBytes = 16;
const voiceMinFrameBytes = voiceHeaderBytes + voiceTagBytes;
const voiceMaxFrameBytes = 4096;
const voiceAudioPrefixBytes = 10, voiceControlMaxBytes = 2048;
const voiceMaxSeq = (1 << 48) - 1;
const voiceReplayWindow = 128;

class VoiceCryptoError implements Exception {
  const VoiceCryptoError(this.code);
  final String code;
  @override
  String toString() => 'VoiceCryptoError($code)';
}

/// RFC 8785 subset: sorted object keys (UTF-16 order), arrays, strings,
/// booleans, null and integers.
String voiceCanonicalJson(Object? value) {
  if (value == null || value is bool || value is String) return jsonEncode(value);
  if (value is int) return value.toString();
  if (value is num) throw const VoiceCryptoError('canonical_number');
  if (value is List) return '[${value.map(voiceCanonicalJson).join(',')}]';
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((k) => '${jsonEncode(k)}:${voiceCanonicalJson(value[k])}').join(',')}}';
  }
  throw const VoiceCryptoError('canonical_type');
}

/// 4-byte big-endian length prefix, then the bytes.
Uint8List voiceLp(Object value) {
  final bytes = value is String ? utf8.encode(value) : value as List<int>;
  final out = Uint8List(4 + bytes.length);
  ByteData.sublistView(out).setUint32(0, bytes.length);
  out.setRange(4, out.length, bytes);
  return out;
}

Uint8List _concat(List<List<int>> parts) {
  final builder = BytesBuilder(copy: false);
  for (final part in parts) {
    builder.add(part);
  }
  return builder.toBytes();
}

/// Binds the exact voice.start payload to its Space, epoch and devices.
Future<Uint8List> voiceStartHash({
  required Map<String, dynamic> start,
  required String space,
  required int epoch,
  required String client,
  required String host,
}) async {
  if (epoch < 1) throw const VoiceCryptoError('invalid_epoch');
  final input = _concat([
    voiceLp(voiceCanonicalJson(start)),
    voiceLp(space),
    voiceLp('$epoch'),
    voiceLp(client),
    voiceLp(host),
  ]);
  return Uint8List.fromList((await crypto.Sha256().hash(input)).bytes);
}

String _b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
Uint8List _decodePublic(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value)) {
    throw const VoiceCryptoError('invalid_public_key');
  }
  final raw = base64Url.decode('$value=');
  if (raw.length != 32 || _b64url(raw) != value) {
    throw const VoiceCryptoError('invalid_public_key');
  }
  return raw;
}

class VoiceEphemeral {
  VoiceEphemeral._(this.keyPair, this.publicKey);
  final crypto.SimpleKeyPair keyPair;

  /// Raw X25519 public key, base64url without padding.
  final String publicKey;

  static Future<VoiceEphemeral> generate() async {
    final pair = await crypto.X25519().newKeyPair();
    return VoiceEphemeral._(pair, _b64url((await pair.extractPublicKey()).bytes));
  }

  /// Deterministic ephemeral for test vectors only.
  static Future<VoiceEphemeral> fromSeed(List<int> seed) async {
    if (seed.length != 32) throw const VoiceCryptoError('invalid_seed');
    final pair = await crypto.X25519().newKeyPairFromSeed(seed);
    return VoiceEphemeral._(pair, _b64url((await pair.extractPublicKey()).bytes));
  }
}

class VoiceCallKeys {
  const VoiceCallKeys(this.up, this.down);
  final Uint8List up, down;
}

/// X25519 then HKDF-SHA256 with the epoch content key as salt and every
/// negotiated value in `info`.
Future<VoiceCallKeys> voiceDeriveCallKeys({
  required VoiceEphemeral own,
  required String peer,
  required List<int> contentKey,
  required List<int> startHash,
  required String ephC,
  required String ephH,
  required String session,
  required String codec,
  required int frameMs,
}) async {
  if (contentKey.length != 32) throw const VoiceCryptoError('invalid_content_key');
  if (startHash.length != 32) throw const VoiceCryptoError('invalid_start_hash');
  if (frameMs < 1 || frameMs > 0xffff) throw const VoiceCryptoError('invalid_frame_ms');
  final peerKey = crypto.SimplePublicKey(_decodePublic(peer), type: crypto.KeyPairType.x25519);
  List<int> shared;
  try {
    shared = await (await crypto.X25519().sharedSecretKey(keyPair: own.keyPair, remotePublicKey: peerKey)).extractBytes();
  } catch (_) {
    throw const VoiceCryptoError('invalid_shared_secret');
  }
  var nonzero = 0;
  for (final byte in shared) {
    nonzero |= byte;
  }
  if (shared.length != 32 || nonzero == 0) throw const VoiceCryptoError('invalid_shared_secret');
  final frame = Uint8List(2);
  ByteData.sublistView(frame).setUint16(0, frameMs);
  Future<Uint8List> derive(String direction) async {
    final info = _concat([
      voiceLp(voiceProtocol),
      voiceLp(startHash),
      voiceLp(ephC),
      voiceLp(ephH),
      voiceLp(session),
      voiceLp(codec),
      voiceLp(frame),
      voiceLp(direction),
    ]);
    final key = await crypto.Hkdf(hmac: crypto.Hmac.sha256(), outputLength: 32)
        .deriveKey(secretKey: crypto.SecretKey(shared), nonce: contentKey, info: info);
    return Uint8List.fromList(await key.extractBytes());
  }

  return VoiceCallKeys(await derive('up'), await derive('down'));
}

Uint8List _header(int type, int seq) {
  if (seq < 0 || seq > voiceMaxSeq) throw const VoiceCryptoError('seq_exhausted');
  final value = Uint8List(voiceHeaderBytes);
  value[0] = 1;
  value[1] = type;
  ByteData.sublistView(value).setUint64(4, seq);
  return value;
}

Uint8List _nonce(int seq) {
  final value = Uint8List(12);
  ByteData.sublistView(value).setUint64(4, seq);
  return value;
}

bool _validPlaintext(int type, List<int> plaintext) {
  if (type == voiceFrameKeepalive) return plaintext.isEmpty;
  if (type == voiceFrameAudio) {
    return plaintext.length >= voiceAudioPrefixBytes + 2 && (plaintext.length - voiceAudioPrefixBytes).isEven;
  }
  if (type == voiceFrameControl) {
    return plaintext.length >= 2 && plaintext.length <= voiceControlMaxBytes;
  }
  return false;
}

final _aes = crypto.AesGcm.with256bits();

Future<Uint8List> voiceSealFrame(List<int> key, int type, int seq, List<int> plaintext) async {
  if (key.length != 32) throw const VoiceCryptoError('invalid_key');
  if (!_validPlaintext(type, plaintext)) throw const VoiceCryptoError('invalid_plaintext');
  final head = _header(type, seq);
  final box = await _aes.encrypt(plaintext, secretKey: crypto.SecretKey(key), nonce: _nonce(seq), aad: head);
  final frame = _concat([head, box.cipherText, box.mac.bytes]);
  if (frame.length > voiceMaxFrameBytes) throw const VoiceCryptoError('frame_too_large');
  return frame;
}

class VoiceOpenedFrame {
  const VoiceOpenedFrame(this.type, this.seq, this.plaintext);
  final int type, seq;
  final Uint8List plaintext;
}

({int type, int seq}) voiceParseHeader(List<int> frame) {
  if (frame.length < voiceMinFrameBytes || frame.length > voiceMaxFrameBytes) {
    throw const VoiceCryptoError('invalid_length');
  }
  if (frame[0] != 1) throw const VoiceCryptoError('invalid_version');
  if (frame[1] != voiceFrameAudio && frame[1] != voiceFrameControl && frame[1] != voiceFrameKeepalive) {
    throw const VoiceCryptoError('invalid_type');
  }
  if (frame[2] != 0 || frame[3] != 0) throw const VoiceCryptoError('invalid_flags');
  final seq = ByteData.sublistView(Uint8List.fromList(frame.sublist(4, 12))).getUint64(0);
  if (seq < 0 || seq > voiceMaxSeq) throw const VoiceCryptoError('seq_exhausted');
  return (type: frame[1], seq: seq);
}

Future<VoiceOpenedFrame> voiceOpenFrame(List<int> key, List<int> frame) async {
  final header = voiceParseHeader(frame);
  final box = crypto.SecretBox(
    frame.sublist(voiceHeaderBytes, frame.length - voiceTagBytes),
    nonce: _nonce(header.seq),
    mac: crypto.Mac(frame.sublist(frame.length - voiceTagBytes)),
  );
  List<int> plaintext;
  try {
    plaintext = await _aes.decrypt(box, secretKey: crypto.SecretKey(key), aad: frame.sublist(0, voiceHeaderBytes));
  } catch (_) {
    throw const VoiceCryptoError('auth_failed');
  }
  if (!_validPlaintext(header.type, plaintext)) throw const VoiceCryptoError('invalid_plaintext');
  return VoiceOpenedFrame(header.type, header.seq, Uint8List.fromList(plaintext));
}

/// One sender per direction: each sequence number is allocated exactly once,
/// including for sends that later fail.
class VoiceFrameSender {
  VoiceFrameSender(List<int> key) : _key = Uint8List.fromList(key);
  final Uint8List _key;
  int _next = 0;
  int get next => _next;
  Future<Uint8List> seal(int type, List<int> plaintext) {
    final seq = _next;
    if (seq > voiceMaxSeq) throw const VoiceCryptoError('seq_exhausted');
    _next = seq + 1;
    return voiceSealFrame(_key, type, seq, plaintext);
  }

  void destroy() => _key.fillRange(0, _key.length, 0);
}

/// Per-direction receive state; it advances only after a frame authenticates.
class VoiceFrameReceiver {
  VoiceFrameReceiver(List<int> key, {this.maxConsecutiveFailures = 8}) : _key = Uint8List.fromList(key);
  final Uint8List _key;
  final int maxConsecutiveFailures;
  int _highest = -1, _failures = 0;
  BigInt _bitmap = BigInt.zero;
  static final _mask = (BigInt.one << voiceReplayWindow) - BigInt.one;

  /// Null for a replayed or too-old frame; throws on structure or auth failure.
  Future<VoiceOpenedFrame?> open(List<int> frame) async {
    VoiceOpenedFrame opened;
    try {
      final seq = voiceParseHeader(frame).seq;
      if (_seen(seq)) return null;
      opened = await voiceOpenFrame(_key, frame);
    } catch (error) {
      if (++_failures > maxConsecutiveFailures) throw const VoiceCryptoError('voice_crypto_failed');
      rethrow;
    }
    // The window may have moved while decrypting; re-check before accepting.
    if (_seen(opened.seq)) return null;
    _failures = 0;
    _accept(opened.seq);
    return opened;
  }

  bool _seen(int seq) {
    if (seq > _highest) return false;
    final offset = _highest - seq;
    if (offset >= voiceReplayWindow) return true;
    return (_bitmap >> offset) & BigInt.one == BigInt.one;
  }

  void _accept(int seq) {
    if (seq > _highest) {
      final shift = seq - _highest;
      _bitmap = shift >= voiceReplayWindow ? BigInt.one : ((_bitmap << shift) | BigInt.one) & _mask;
      _highest = seq;
    } else {
      _bitmap |= BigInt.one << (_highest - seq);
    }
  }

  void destroy() => _key.fillRange(0, _key.length, 0);
}

class VoiceAudioPayload {
  const VoiceAudioPayload(this.gen, this.nativeSeq, this.sampleOffset, this.pcm);
  final int gen, nativeSeq, sampleOffset;
  final Uint8List pcm;
}

Uint8List voiceEncodeAudio(VoiceAudioPayload value) {
  if (value.gen < 0 || value.gen > 0xffff) throw const VoiceCryptoError('invalid_gen');
  final out = Uint8List(voiceAudioPrefixBytes + value.pcm.length);
  final view = ByteData.sublistView(out);
  view.setUint16(0, value.gen);
  view.setUint32(2, value.nativeSeq);
  view.setUint32(6, value.sampleOffset & 0xffffffff);
  out.setRange(voiceAudioPrefixBytes, out.length, value.pcm);
  return out;
}

VoiceAudioPayload voiceDecodeAudio(Uint8List plaintext) {
  if (plaintext.length < voiceAudioPrefixBytes + 2 || (plaintext.length - voiceAudioPrefixBytes).isOdd) {
    throw const VoiceCryptoError('invalid_plaintext');
  }
  final view = ByteData.sublistView(plaintext);
  return VoiceAudioPayload(
    view.getUint16(0),
    view.getUint32(2),
    view.getUint32(6),
    Uint8List.sublistView(plaintext, voiceAudioPrefixBytes),
  );
}
