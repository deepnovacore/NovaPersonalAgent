// Dart half of the shared vectors tests/fixtures/space-voice/v1/vectors.json;
// the TypeScript half is runtime/test/voice-crypto-vectors.test.ts.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_voice_crypto.dart';

Uint8List _hex(String value) => Uint8List.fromList([
      for (var i = 0; i < value.length; i += 2) int.parse(value.substring(i, i + 2), radix: 16),
    ]);
String _toHex(List<int> value) => value.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  final vectors = jsonDecode(File('../../tests/fixtures/space-voice/v1/vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final h = vectors['handshake'] as Map<String, dynamic>;
  Uint8List key(String direction) => _hex(h[direction == 'up' ? 'k_up' : 'k_down'] as String);

  test('canonical start hash matches the TypeScript implementation', () async {
    final start = h['start'] as Map<String, dynamic>;
    expect(voiceCanonicalJson(start), h['canonical']);
    final hash = await voiceStartHash(
      start: start,
      space: h['space'] as String,
      epoch: h['epoch'] as int,
      client: h['client'] as String,
      host: h['host'] as String,
    );
    expect(_toHex(hash), h['start_hash']);
  });

  test('call keys derive identically from both ephemerals', () async {
    final client = await VoiceEphemeral.fromSeed(_hex(h['client_seed'] as String));
    final host = await VoiceEphemeral.fromSeed(_hex(h['host_seed'] as String));
    expect(client.publicKey, h['client_public']);
    expect(host.publicKey, h['host_public']);
    Future<VoiceCallKeys> derive(VoiceEphemeral own, String peer, String contentKey) => voiceDeriveCallKeys(
          own: own,
          peer: peer,
          contentKey: _hex(contentKey),
          startHash: _hex(h['start_hash'] as String),
          ephC: h['client_public'] as String,
          ephH: h['host_public'] as String,
          session: h['session'] as String,
          codec: h['codec'] as String,
          frameMs: h['frame_ms'] as int,
        );
    final a = await derive(client, h['host_public'] as String, h['content_key'] as String);
    final b = await derive(host, h['client_public'] as String, h['content_key'] as String);
    expect(_toHex(a.up), h['k_up']);
    expect(_toHex(a.down), h['k_down']);
    expect(_toHex(b.up), h['k_up']);
    final former = await derive(client, h['host_public'] as String, h['former_content_key'] as String);
    expect(_toHex(former.up), h['former_k_up']);
    for (final bad in (vectors['invalid_public_keys'] as List).cast<Map<String, dynamic>>()) {
      await expectLater(
        derive(client, bad['value'] as String, h['content_key'] as String),
        throwsA(isA<VoiceCryptoError>().having((e) => e.code, 'code', 'invalid_shared_secret')),
        reason: bad['name'] as String,
      );
    }
  });

  test('frames seal and open byte-exactly; negatives fail with their codes', () async {
    for (final f in (vectors['frames'] as List).cast<Map<String, dynamic>>()) {
      final sealed = await voiceSealFrame(key(f['direction'] as String), f['type'] as int, int.parse(f['seq'] as String), _hex(f['plaintext'] as String));
      expect(_toHex(sealed), f['frame'], reason: f['name'] as String);
      final opened = await voiceOpenFrame(key(f['direction'] as String), _hex(f['frame'] as String));
      expect(opened.type, f['type']);
      expect(opened.seq, int.parse(f['seq'] as String));
      expect(_toHex(opened.plaintext), f['plaintext']);
    }
    for (final n in (vectors['negatives'] as List).cast<Map<String, dynamic>>()) {
      await expectLater(
        voiceOpenFrame(key(n['direction'] as String), _hex(n['frame'] as String)),
        throwsA(isA<VoiceCryptoError>().having((e) => e.code, 'code', n['error'])),
        reason: n['name'] as String,
      );
    }
  });

  test('replay window and failure counting match the shared vectors', () async {
    final replay = vectors['replay'] as Map<String, dynamic>;
    final receiver = VoiceFrameReceiver(key('up'));
    final accepted = <bool>[];
    for (final seq in (replay['sequence'] as List).cast<String>()) {
      final frame = await voiceSealFrame(key('up'), voiceFrameControl, int.parse(seq), utf8.encode('{"type":"x"}'));
      accepted.add(await receiver.open(frame) != null);
    }
    expect(accepted, replay['accepted']);
    final genuine = await voiceSealFrame(key('up'), voiceFrameControl, 500, utf8.encode('{"type":"y"}'));
    final forged = Uint8List.fromList(genuine)..[genuine.length - 1] ^= 1;
    await expectLater(receiver.open(forged), throwsA(isA<VoiceCryptoError>()));
    expect(await receiver.open(genuine), isNotNull);
    final sender = VoiceFrameSender(key('up'));
    await sender.seal(voiceFrameKeepalive, const []);
    await sender.seal(voiceFrameAudio, voiceEncodeAudio(VoiceAudioPayload(1, 0, 0, Uint8List(4))));
    expect(sender.next, 2);
  });
}
