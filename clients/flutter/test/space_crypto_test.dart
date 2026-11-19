import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  test(
    'decrypt real TypeScript JOSE dir and ECDH-ES+A256KW fixtures',
    () async {
      final fixture = jsonMap(
        await File('../../relay/test/fixtures/jose-v1.json').readAsString(),
      );
      final host = Map<String, dynamic>.from(fixture['host'] as Map);
      final client = Map<String, dynamic>.from(fixture['client'] as Map);
      final identity = SpaceIdentity(
        signing: Map<String, dynamic>.from(client['signingPrivateKey'] as Map),
        encryption: Map<String, dynamic>.from(
          client['encryptionPrivateKey'] as Map,
        ),
      );
      final envelope = Map<String, dynamic>.from(fixture['envelope'] as Map);
      final record = SpaceRecord(
        id: 'local',
        name: 'Fixture',
        mode: SpaceMode.client,
        remoteSpace: envelope['space'] as String,
        device: client['device'] as String,
        hostDevice: host['device'] as String,
        hostSigningKey: Map<String, dynamic>.from(
          host['signingPublicKey'] as Map,
        ),
      );
      final crypto = SpaceCrypto(record, identity, MemorySpacePersistence());
      await crypto.load();
      await crypto.openEnvelope(
        Map<String, dynamic>.from(fixture['keyEnvelope'] as Map),
      );
      expect(crypto.keys[1], List.generate(32, (i) => i));
      expect(await crypto.openEnvelope(envelope), fixture['plaintext']);
      final corrupt = {...envelope, 'to': 'attacker'};
      await expectLater(crypto.openEnvelope(corrupt), throwsStateError);
      final jws = await crypto.signControl({'v': 1, 'purpose': 'test'});
      expect(
        await SpaceCrypto.verifyJws(
          jws,
          identity.signingPublic,
          type: 'nova-control+jws',
        ),
        {'v': 1, 'purpose': 'test'},
      );
      final encoded = await SpaceCrypto.encryptBody({
        'text': 'Dart 中文🙂',
      }, crypto.keys[1]!);
      expect(utf8.decode(base64Decode(encoded)).split('.').length, 5);
    },
  );
}
