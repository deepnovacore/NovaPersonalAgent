import 'dart:io';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  test(
    'Client state encrypts credentials, survives restart and fails closed',
    () async {
      final directory = await Directory.systemTemp.createTemp('space-storage-');
      try {
        final file = File('${directory.path}/client.json');
        final keys = MemorySpacePersistence();
        final state = SpaceClientState(SpaceFilePersistence(file, keys));
        await state.open();
        await state.enqueue('push.register', {
          'handle': 'h',
          'credential': 'private-push-secret',
        });
        final encrypted = await file.readAsBytes();
        expect(
          utf8.decode(encrypted, allowMalformed: true),
          isNot(contains('private-push-secret')),
        );
        final recovered = SpaceClientState(SpaceFilePersistence(file, keys));
        await recovered.open();
        expect(
          recovered.pending.single['input']['credential'],
          'private-push-secret',
        );
        expect(
          recovered.pending.single['op_id'],
          state.pending.single['op_id'],
        );
        final missing = SpaceFilePersistence(file, MemorySpacePersistence());
        await expectLater(missing.read(), throwsStateError);
        await expectLater(missing.write('{}'), throwsStateError);
        final wrong = MemorySpacePersistence()
          ..value = base64Encode(List.filled(32, 0));
        await expectLater(
          SpaceFilePersistence(file, wrong).read(),
          throwsA(isA<Exception>()),
        );
        final beforeTamper = await file.readAsBytes();
        beforeTamper[beforeTamper.length - 1] ^= 1;
        await file.writeAsBytes(beforeTamper);
        await expectLater(
          SpaceFilePersistence(file, keys).read(),
          throwsA(isA<Exception>()),
        );
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );
}
