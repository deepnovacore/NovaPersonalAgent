import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/memory/local_memory_store.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:xml/xml.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('nova/space_scope');
  const space = SpaceRecord(
    id: 'private-space',
    name: 'Private',
    mode: SpaceMode.standalone,
  );
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late Directory root;
  late Directory directory;
  late List<MethodCall> calls;
  late List<LocalMemoryStore> stores;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('mobile-memory-privacy-');
    directory = Directory('${root.path}/spaces/${space.id}');
    calls = [];
    stores = [];
    SpaceStorage.active = space;
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'prepareSpaceDirectory') {
        await directory.create(recursive: true);
        return directory.path;
      }
      if (call.method == 'invalidateModelTransfers') {
        final transfers = Directory('${directory.path}/ModelTransfers');
        if (await transfers.exists()) await transfers.delete(recursive: true);
        return null;
      }
      throw MissingPluginException();
    });
  });
  tearDown(() async {
    for (final store in stores) {
      await store.close();
    }
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    SpaceStorage.active = null;
    debugDefaultTargetPlatformOverride = null;
    await root.delete(recursive: true);
  });
  Future<LocalMemoryStore> open() async {
    final selected = await SpaceStorage.directory();
    final store = LocalMemoryStore(
      FileLifePersistence(File('${selected.path}/local_memory.json')),
    );
    stores.add(store);
    await store.open();
    return store;
  }

  Future<String> save(LocalMemoryStore store) async => (await store.save(
    kind: 'fact',
    text: 'tea',
    quote: 'tea',
    userUtterance: 'tea',
  )).id;

  test(
    'iOS selects native-protected directory before first write and on reopen',
    () async {
      var store = await open();
      expect(calls.single.method, 'prepareSpaceDirectory');
      expect(calls.single.arguments, {'spaceId': space.id});
      await save(store);
      expect(
        await File('${directory.path}/local_memory.json').exists(),
        isTrue,
      );
      expect(await File('${root.path}/local_memory.json').exists(), isFalse);
      await store.close();
      store = await open();
      expect(store.recall('tea').single.text, 'tea');
      expect(calls.map((c) => c.method), [
        'prepareSpaceDirectory',
        'prepareSpaceDirectory',
      ]);
    },
  );

  test(
    'iOS directory protection failure never falls back to backup-eligible storage',
    () async {
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => throw PlatformException(code: 'space_privacy_unavailable'),
      );
      await expectLater(
        SpaceStorage.directory(),
        throwsA(isA<PlatformException>()),
      );
      expect(await directory.exists(), isFalse);
    },
  );

  test(
    'forget commits tombstone then awaits native revocation before listeners',
    () async {
      final store = await open();
      final id = await save(store);
      final request = File('${directory.path}/ModelTransfers/active.request');
      await request.parent.create();
      await request.writeAsString('private request');
      store.addForgetListener(() async {
        expect(calls.last.method, 'invalidateModelTransfers');
        expect(await request.exists(), isFalse);
        expect(store.recall('tea'), isEmpty);
      });
      await store.forget(id);
      expect(calls.last.arguments, {'spaceId': space.id});
      await store.forget(id); // idempotent forget must revoke again
      expect(
        calls.where((c) => c.method == 'invalidateModelTransfers').length,
        2,
      );
    },
  );

  test(
    'native revocation failure remains a fixed diagnostic after committed forget',
    () async {
      final store = await open();
      final id = await save(store);
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => throw PlatformException(code: 'private exception detail'),
      );
      await store.forget(id);
      expect(store.recoveryCleanupError, 'memory_recovery_cleanup_failed');
      expect(store.recall('tea'), isEmpty);
    },
  );

  test(
    'reset fences native transfers before recovery copy and fails closed on error',
    () async {
      await directory.create(recursive: true);
      final file = File('${directory.path}/local_memory.json');
      await file.writeAsString('corrupt private text');
      final store = await open();
      expect(store.available, isFalse);
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => throw PlatformException(code: 'unavailable'),
      );
      await expectLater(
        store.resetUnavailable(),
        throwsA(isA<PlatformException>()),
      );
      expect(await file.readAsString(), 'corrupt private text');
      expect(await directory.list().length, 1);
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'invalidateModelTransfers');
        expect(
          await directory.list().length,
          1,
        ); // no recovery copy before fence
        return null;
      });
      await store.resetUnavailable();
      expect(store.available, isTrue);
      final copy = (await directory.list().toList())
          .whereType<File>()
          .singleWhere((f) => f.path.contains('.corrupt-'));
      expect(await copy.readAsString(), 'corrupt private text');
    },
  );

  test(
    'Android directory matches targeted cloud and device-transfer backup rules',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      messenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async {
          expect(call.method, 'getApplicationSupportDirectory');
          return root.path;
        },
      );
      expect((await SpaceStorage.directory()).path, directory.path);
      expect(calls, isEmpty); // Android uses filesDir; no iOS API fallback.
      final manifest = XmlDocument.parse(
        await File('android/app/src/main/AndroidManifest.xml').readAsString(),
      );
      final app = manifest.findAllElements('application').single;
      expect(
        app.getAttribute('android:fullBackupContent'),
        '@xml/backup_rules',
      );
      expect(
        app.getAttribute('android:dataExtractionRules'),
        '@xml/data_extraction_rules',
      );
      for (final name in ['backup_rules', 'data_extraction_rules']) {
        final policy = XmlDocument.parse(
          await File('android/app/src/main/res/xml/$name.xml').readAsString(),
        );
        final exclusions = policy.findAllElements('exclude').toList();
        expect(exclusions.length, name == 'backup_rules' ? 1 : 2);
        for (final exclusion in exclusions) {
          expect(exclusion.getAttribute('domain'), 'file');
          expect(exclusion.getAttribute('path'), 'spaces/');
        }
        if (name == 'data_extraction_rules') {
          for (final section in ['cloud-backup', 'device-transfer']) {
            expect(
              policy
                  .findAllElements(section)
                  .single
                  .findElements('exclude')
                  .length,
              1,
            );
          }
        }
      }
    },
  );
}
