import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  test('failed removal leaves the selected Space and disk untouched', () async {
    final disk = _FailingPersistence();
    const space = SpaceRecord(
      id: 'keep',
      name: 'Keep',
      mode: SpaceMode.standalone,
    );
    disk.value = jsonEncode({
      'selected': space.id,
      'spaces': [space.toJson()],
    });
    final catalog = SpaceCatalog(persistence: disk);
    await catalog.open();
    await expectLater(catalog.removeSpace(space.id), throwsStateError);
    expect(catalog.selectedId, space.id);
    expect(catalog.spaces.single.id, space.id);
    expect(catalog.retired, isEmpty);
    expect(jsonDecode(disk.value!)['selected'], space.id);
    catalog.dispose();
  });
  test('removal waits for an in-flight add to persist', () async {
    final disk = _BlockingPersistence();
    final catalog = SpaceCatalog(persistence: disk);
    await catalog.open();
    const space = SpaceRecord(
      id: 'queued',
      name: 'Queued',
      mode: SpaceMode.standalone,
    );
    final adding = catalog.add(space);
    await disk.started.future;
    final removing = catalog.removeSpace(space.id);
    expect(catalog.spaces, isEmpty);
    disk.release.complete();
    await adding;
    expect((await removing).single.id, space.id);
    final reopened = SpaceCatalog(persistence: disk);
    await reopened.open();
    expect(reopened.spaces, isEmpty);
    expect(reopened.retired.single.id, space.id);
    catalog.dispose();
    reopened.dispose();
  });
  test('removing a client Space retires all its local bindings', () async {
    final disk = MemorySpacePersistence();
    SpaceRecord binding(String id, String remote) => SpaceRecord(
      id: id,
      name: id,
      mode: SpaceMode.client,
      remoteSpace: remote,
      hostDevice: 'host',
      hostSigningKey: {'x': 'x', 'y': 'y'},
    );
    disk.value = jsonEncode({
      'selected': 'duplicate',
      'spaces': [
        binding('first', 's').toJson(),
        binding('duplicate', 's').toJson(),
        binding('other', 'other').toJson(),
      ],
    });
    final catalog = SpaceCatalog(persistence: disk);
    await catalog.open();
    await catalog.removeSpace('first');
    expect(catalog.selectedId, isNull);
    expect(catalog.visibleSpaces.single.id, 'other');
    expect(catalog.retired.map((v) => v.id), ['first', 'duplicate']);
    expect(await catalog.removeSpace('first'), isEmpty);
    await catalog.select('duplicate', ignoreMissing: true);
    expect(catalog.selectedId, isNull);
  });
  test(
    'one Host/phone binding is listed and new duplicates are refused; old records retire recoverably',
    () async {
      final disk = MemorySpacePersistence();
      SpaceRecord record(String id, {String remote = 'host-space'}) =>
          SpaceRecord(
            id: id,
            name: 'client',
            mode: SpaceMode.client,
            remoteSpace: remote,
            hostDevice: 'host',
            hostSigningKey: {'kty': 'EC', 'crv': 'P-256', 'x': 'x', 'y': 'y'},
            device: id,
          );
      disk.value = jsonEncode({
        'v': 1,
        'selected': 'second',
        'spaces': [
          record('first').toJson(),
          record('second').toJson(),
          record('other', remote: 'different').toJson(),
        ],
      });
      final catalog = SpaceCatalog(persistence: disk);
      await catalog.open();
      expect(catalog.visibleSpaces.map((v) => v.id), ['second', 'other']);
      await expectLater(catalog.add(record('third')), throwsStateError);
      await catalog.retireBindings(record('second'));
      final reopened = SpaceCatalog(persistence: disk);
      await reopened.open();
      expect(reopened.spaces.map((v) => v.id), ['second', 'other']);
      expect(reopened.retired.single.id, 'first');
    },
  );
  test('parallel pairing does not create competing identities', () async {
    final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
    final first = catalog.pairOnce(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
      return const SpaceRecord(id: 'one', name: 'one', mode: SpaceMode.client);
    });
    await expectLater(
      catalog.pairOnce(
        () async =>
            const SpaceRecord(id: 'two', name: 'two', mode: SpaceMode.client),
      ),
      throwsStateError,
    );
    expect((await first).id, 'one');
  });
  test('failed catalog persistence preserves all active bindings', () async {
    final disk = _FailingPersistence();
    const a = SpaceRecord(
      id: 'a',
      name: 'client',
      mode: SpaceMode.client,
      remoteSpace: 's',
      hostDevice: 'h',
      hostSigningKey: {'x': 'x', 'y': 'y'},
    );
    const b = SpaceRecord(
      id: 'b',
      name: 'client',
      mode: SpaceMode.client,
      remoteSpace: 's',
      hostDevice: 'h',
      hostSigningKey: {'x': 'x', 'y': 'y'},
    );
    disk.value = jsonEncode({
      'v': 1,
      'spaces': [a.toJson(), b.toJson()],
    });
    final catalog = SpaceCatalog(persistence: disk);
    await catalog.open();
    await expectLater(catalog.retireBindings(a), throwsStateError);
    expect(catalog.spaces.map((v) => v.id), ['a', 'b']);
    expect(catalog.retired, isEmpty);
  });
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

class _FailingPersistence extends MemorySpacePersistence {
  @override
  Future<void> write(String value) async =>
      throw StateError('disk unavailable');
}

class _BlockingPersistence extends MemorySpacePersistence {
  final started = Completer<void>(), release = Completer<void>();
  @override
  Future<void> write(String value) async {
    if (!started.isCompleted) {
      started.complete();
      await release.future;
    }
    await super.write(value);
  }
}
