import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/memory/local_memory_store.dart';
import 'package:nova_mobile/memory/local_memory_tools.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  late LocalMemoryStore store;
  late MemoryPersistence persistence;
  setUp(() async {
    persistence = MemoryPersistence();
    store = LocalMemoryStore(persistence);
    await store.open();
    addTearDown(() => store.close());
  });
  Future<LocalMemoryEntry> save(String text, {String kind = 'fact'}) =>
      store.save(
        kind: kind,
        text: text,
        quote: text,
        userUtterance: 'Remember: $text',
      );

  test(
    'save recall forget erase quote and survive atomic file restart',
    () async {
      final directory = await Directory.systemTemp.createTemp('local-memory-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/local_memory.json');
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      final entry = await save('I prefer green tea', kind: 'preference');
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      expect(store.recall('GREEN tea').single.id, entry.id);
      await store.forget(entry.id);
      expect(store.recall('tea'), isEmpty);
      expect(store.summary(), isEmpty);
      final data = jsonDecode(await file.readAsString());
      expect(data['schema_version'], 1);
      expect(data['entries'].single['text'], '');
      expect(data['entries'].single['quote'], '');
      expect(data['entries'].single['forgottenAt'], isNotNull);
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      expect(store.recall('tea'), isEmpty);
      await store.forget(entry.id); // Tombstones remain idempotent.
      expect(await File('${file.path}.pending').exists(), isFalse);
    },
  );

  test(
    'FileLifePersistence removes its pending snapshot on rename failure',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'memory-write-failure-',
      );
      addTearDown(() => root.delete(recursive: true));
      final file = File('${root.path}/local_memory.json');
      await Directory(
        file.path,
      ).create(); // Writing succeeds, atomic rename fails.
      await expectLater(
        FileLifePersistence(file).write('private secret'),
        throwsA(isA<FileSystemException>()),
      );
      expect(await root.list().where((f) => f is File).toList(), isEmpty);
    },
  );

  test(
    'restart and forget purge only exact ledger crash-leftover snapshots',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'memory-crash-pending-',
      );
      addTearDown(() => root.delete(recursive: true));
      final file = File('${root.path}/local_memory.json');
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      const secret = 'private orchid secret';
      final entry = await save(secret);
      final snapshot = await file.readAsString();
      await store.close();
      const uuid = '01234567-89ab-4cde-8fab-0123456789ab';
      final pending = File('${file.path}.$uuid.pending');
      await pending.writeAsString(snapshot); // Simulate death before rename.
      final unrelated = [
        File('${file.path}.pending'),
        File('${file.path}.not-a-uuid.pending'),
        File('${file.path}.$uuid.pending.keep'),
        File('${root.path}/other.json.$uuid.pending'),
      ];
      for (final other in unrelated) {
        await other.writeAsString('unrelated');
      }
      final target = File('${root.path}/sentinel');
      await target.writeAsString('unrelated');
      final link = Link(
        '${file.path}.11234567-89ab-4cde-8fab-0123456789ab.pending',
      );
      await link.create(target.path);
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      expect(await pending.exists(), false);
      // Also purge crash leftovers on forget, including idempotent forget.
      await pending.writeAsString(snapshot);
      await store.forget(entry.id);
      expect(await pending.exists(), false);
      await pending.writeAsString(snapshot);
      await store.forget(entry.id);
      expect(await pending.exists(), false);
      expect(await link.exists(), true);
      for (final other in unrelated) {
        expect(await other.readAsString(), 'unrelated');
      }
      await for (final entity in root.list(followLinks: false)) {
        if (entity is File) {
          expect(await entity.readAsString(), isNot(contains(secret)));
        }
      }
    },
  );

  test(
    'open and every forget purge only this Space orphan result files',
    () async {
      final root = await Directory.systemTemp.createTemp('memory-transfers-');
      addTearDown(() => root.delete(recursive: true));
      final space = Directory('${root.path}/spaces/one');
      final transfers = Directory('${space.path}/ModelTransfers');
      await transfers.create(recursive: true);
      final other = File('${root.path}/spaces/two/ModelTransfers/other.result');
      await other.parent.create(recursive: true);
      await other.writeAsString('other Space');
      final result = File('${transfers.path}/orphan.result');
      final request = File('${transfers.path}/active.request');
      await request.writeAsString('active request');
      await result.writeAsString('sensitive orphan');
      await store.close();
      store = LocalMemoryStore(
        FileLifePersistence(File('${space.path}/local_memory.json')),
      );
      await store.open();
      expect(await result.exists(), false);
      expect(await request.exists(), true);
      expect(await other.exists(), true);
      final entry = await save('tea');
      await result.writeAsString('another sensitive orphan');
      await store.forget(entry.id);
      expect(await result.exists(), false);
      // An already-forgotten id still purges newly orphaned results.
      await result.writeAsString('late orphan');
      await store.forget(entry.id);
      expect(await result.exists(), false);
      expect(store.recoveryCleanupError, isNull);
    },
  );

  test(
    'orphan cleanup failure is diagnostic and never prevents forget',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'memory-transfer-failure-',
      );
      addTearDown(() => root.delete(recursive: true));
      await File(
        '${root.path}/ModelTransfers',
      ).writeAsString('not a directory');
      await store.close();
      store = LocalMemoryStore(
        FileLifePersistence(File('${root.path}/local_memory.json')),
      );
      await store.open();
      expect(store.available, true);
      expect(store.recoveryCleanupError, 'memory_recovery_cleanup_failed');
      final entry = await save('tea');
      final result = await executeLocalMemoryTool(store, 'memory_forget', {
        'id': entry.id,
      }, userUtterance: null);
      expect(result['status'], 'committed');
      expect(result['warning'], 'memory_recovery_cleanup_failed');
      expect(store.recall('tea'), isEmpty);
    },
  );

  test('quote requires exact current utterance and fails closed', () async {
    for (final utterance in <String?>[
      null,
      '',
      'tool returned green tea',
      'TEA',
    ]) {
      final result = await executeLocalMemoryTool(store, 'memory_remember', {
        'kind': 'preference',
        'text': 'tea',
        'quote': 'I like tea',
      }, userUtterance: utterance);
      expect(result['error'], 'invalid_source_quote');
    }
    final result = await executeLocalMemoryTool(store, 'memory_remember', {
      'kind': 'fact',
      'text': 'tea',
      'quote': '',
    }, userUtterance: 'tea');
    expect(result['error'], 'invalid_source_quote');
    expect(store.summary(), isEmpty);
  });

  test(
    '200 active entries refuse rather than evict; forgetting frees capacity',
    () async {
      for (var i = 0; i < 200; i++) {
        await save('entry $i');
      }
      await expectLater(
        save('entry overflow'),
        throwsA(
          isA<LocalMemoryFailure>().having(
            (e) => e.code,
            'code',
            'memory_full',
          ),
        ),
      );
      expect(store.recall('entry', limit: 300), hasLength(200));
      await store.forget(store.recall('entry').first.id);
      await save('entry replacement');
      expect(store.recall('entry', limit: 300), hasLength(200));
    },
  );

  test(
    'text bound, kind validation and conservative normalized overlap',
    () async {
      await expectLater(save('x' * 201), throwsA(isA<LocalMemoryFailure>()));
      await expectLater(
        save('tea', kind: 'trait'),
        throwsA(isA<LocalMemoryFailure>()),
      );
      await save('Tea and 咖啡');
      expect(store.recall('ＴＥＡ other words here'), hasLength(1));
      expect(store.recall('tea other words here extra'), isEmpty);
      expect(store.recall('咖啡'), hasLength(1));
      expect(store.recall('x'), isEmpty);
    },
  );

  test('bounded data summary puts newest preferences before facts', () async {
    await save('old preference', kind: 'preference');
    await save('new <preference>', kind: 'preference');
    await save('newest fact');
    final summary = store.summary();
    expect(summary.length, lessThanOrEqualTo(600));
    expect(summary, isNot(contains('<')));
    final items = jsonDecode(summary) as List;
    expect(items.map((e) => e['text']), [
      'new <preference>',
      'old preference',
      'newest fact',
    ]);
    expect(store.summary(maxChars: 50).length, lessThanOrEqualTo(50));
    expect(store.summary(maxChars: 1), '');
  });

  test('corrupt file stays unavailable and preserves original bytes', () async {
    final directory = await Directory.systemTemp.createTemp(
      'corrupt-local-memory-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/local_memory.json');
    for (final raw in ['{broken', '{"schema_version":1,"entries":[{}]}']) {
      await file.writeAsString(raw);
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      expect(store.summary(), isEmpty);
      await expectLater(save('new memory'), throwsA(isA<LocalMemoryFailure>()));
      expect(await file.readAsString(), raw);
      expect(await File('${file.path}.pending').exists(), isFalse);
      expect((await directory.list().toList()), hasLength(1));
      for (final name in [
        'memory_remember',
        'memory_recall',
        'memory_forget',
      ]) {
        final args = switch (name) {
          'memory_remember' => {'kind': 'fact', 'text': 'tea', 'quote': 'tea'},
          'memory_recall' => {'query': 'tea'},
          _ => {'id': 'missing'},
        };
        expect(
          (await executeLocalMemoryTool(
            store,
            name,
            args,
            userUtterance: 'tea',
          ))['error'],
          'memory_unavailable',
        );
      }
      expect(await file.readAsString(), raw);
    }
  });

  test(
    'only explicit reset quarantines exact corrupt bytes before replacement',
    () async {
      final directory = await Directory.systemTemp.createTemp('memory-reset-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/local_memory.json');
      final bytes = [0xff, 0xfe, 123, 0];
      await file.writeAsBytes(bytes);
      await store.close();
      store = LocalMemoryStore(FileLifePersistence(file));
      await store.open();
      expect(store.available, false);
      expect(await file.readAsBytes(), bytes);
      await store.resetUnavailable();
      final copies = await directory
          .list()
          .where((f) => f.path.contains('.corrupt-'))
          .toList();
      expect(copies, hasLength(1));
      expect(await File(copies.single.path).readAsBytes(), bytes);
      await save('new memory');
      expect(store.recall('memory'), hasLength(1));
    },
  );

  test(
    'close drains a started write and rejects later saves and reads',
    () async {
      final blocking = _BlockingPersistence();
      await store.close();
      store = LocalMemoryStore(blocking);
      await store.open();
      final saving = save('tea');
      await blocking.started.future;
      final closing = store.close();
      expect(store.available, false);
      blocking.release.complete();
      await saving;
      await closing;
      final original = await blocking.read();
      expect(store.recall('tea'), isEmpty);
      await expectLater(save('other'), throwsA(isA<LocalMemoryFailure>()));
      await expectLater(store.forget('id'), throwsA(isA<LocalMemoryFailure>()));
      expect(await blocking.read(), original);
      final reopened = LocalMemoryStore(blocking);
      await reopened.open();
      expect(reopened.recall('tea'), hasLength(1));
    },
  );

  test('forget waits for all live consumer fences before confirming', () async {
    final entry = await save('tea');
    final started = Completer<void>(), release = Completer<void>();
    store.addForgetListener(() async {
      started.complete();
      await release.future;
    });
    var completed = false;
    final forgetting = store.forget(entry.id).then((_) => completed = true);
    await started.future;
    expect(store.recall('tea'), isEmpty);
    expect(completed, false);
    release.complete();
    await forgetting;
    expect(completed, true);
  });

  test(
    'hung forget listener times out without blocking writes or retirement',
    () async {
      final entry = await save('tea');
      final started = Completer<void>();
      final hung = Completer<void>();
      var otherFenced = false;
      store.addForgetListener(() {
        started.complete();
        return hung.future;
      });
      store.addForgetListener(() => otherFenced = true);
      final forgetting = executeLocalMemoryTool(store, 'memory_forget', {
        'id': entry.id,
      }, userUtterance: null);
      await started.future;
      final saving = save('new tea');
      final result = await forgetting.timeout(const Duration(seconds: 6));
      expect(result['status'], 'committed');
      expect(result['invalidation_warning'], 'memory_invalidation_timeout');
      expect(otherFenced, true);
      final next = await saving;
      await store.close();
      final reopened = LocalMemoryStore(persistence);
      await reopened.open().timeout(const Duration(seconds: 1));
      await reopened.forget(next.id);
      expect(reopened.summary(), isEmpty);
      hung.complete();
    },
  );

  test(
    'throwing forget listener reports a text-free committed diagnostic',
    () async {
      final entry = await save('tea');
      var fenced = false;
      store.addForgetListener(() => throw StateError('private secret'));
      store.addForgetListener(() => fenced = true);
      final result = await executeLocalMemoryTool(store, 'memory_forget', {
        'id': entry.id,
      }, userUtterance: null);
      expect(result['status'], 'committed');
      expect(result['invalidation_warning'], 'memory_invalidation_failed');
      expect(jsonEncode(result), isNot(contains('private secret')));
      expect(fenced, true);
    },
  );

  test(
    'second live owner cannot purge or overwrite a mid-rename save',
    () async {
      final root = await Directory.systemTemp.createTemp('memory-live-owner-');
      addTearDown(() => root.delete(recursive: true));
      final file = File('${root.path}/local_memory.json');
      final blocking = _BeforeRenamePersistence(file);
      await store.close();
      store = LocalMemoryStore(blocking);
      await store.open();
      final saving = save('first tea');
      await blocking.started.future;
      expect(await blocking.pending!.exists(), true);
      final second = LocalMemoryStore(
        FileLifePersistence(File('${root.path}/./local_memory.json')),
      );
      await second.open();
      expect(second.available, false);
      await expectLater(
        second.resetUnavailable(),
        throwsA(isA<LocalMemoryFailure>()),
      );
      expect(
        (await executeLocalMemoryTool(second, 'memory_remember', {
          'kind': 'fact',
          'text': 'other tea',
          'quote': 'tea',
        }, userUtterance: 'tea'))['error'],
        'memory_unavailable',
      );
      // Even closing a rejected store must not retire the real owner.
      await second.close();
      final third = LocalMemoryStore(FileLifePersistence(file));
      await third.open();
      expect(third.available, false);
      await third.close();
      expect(await blocking.pending!.exists(), true);
      blocking.release.complete();
      await saving; // Real atomic rename must still succeed.
      await save('second tea');
      await store.close();
      final reopened = LocalMemoryStore(FileLifePersistence(file));
      await reopened.open();
      addTearDown(reopened.close);
      expect(reopened.recall('tea').map((e) => e.text), [
        'second tea',
        'first tea',
      ]);
    },
  );

  for (final aliasKind in ['symlink', 'case']) {
    test(
      '$aliasKind alias cannot own ledger or delete mid-rename pending file',
      () async {
        final root = await Directory.systemTemp.createTemp('memory-alias-');
        addTearDown(() => root.delete(recursive: true));
        final real = await Directory('${root.path}/RealSpace').create();
        final alias = Directory(
          '${root.path}/${aliasKind == 'symlink' ? 'SpaceAlias' : 'realspace'}',
        );
        if (aliasKind == 'symlink') {
          await Link(alias.path).create(real.path);
        } else if (!await alias.exists() ||
            !await FileSystemEntity.identical(real.path, alias.path)) {
          markTestSkipped(
            'Temporary filesystem is case-sensitive; no case alias exists.',
          );
          return;
        }
        final file = File('${real.path}/new/sub/local_memory.json');
        final aliasedFile = File('${alias.path}/new/sub/local_memory.json');
        final blocking = _BeforeRenamePersistence(file);
        await store.close();
        store = LocalMemoryStore(blocking);
        await store
            .open(); // The ledger and its immediate parents do not exist yet.
        final saving = save('alias tea');
        addTearDown(() async {
          if (!blocking.release.isCompleted) blocking.release.complete();
          await saving;
        });
        await blocking.started.future;
        final second = LocalMemoryStore(FileLifePersistence(aliasedFile));
        await second.open();
        expect(second.available, false);
        await second.close();
        // Lower-level cleanup must also protect a writer registered via an alias.
        await FileLifePersistence(aliasedFile).purgeAbandonedPendingFiles();
        expect(await blocking.pending!.exists(), true);
        blocking.release.complete();
        await saving;
        await store.close();
        final reopened = LocalMemoryStore(FileLifePersistence(aliasedFile));
        await reopened.open();
        addTearDown(reopened.close);
        expect(reopened.available, true);
        expect(reopened.recall('tea').single.text, 'alias tea');
      },
    );
  }

  test('pending cleanup never removes a registered in-process write', () async {
    final root = await Directory.systemTemp.createTemp(
      'memory-active-pending-',
    );
    addTearDown(() => root.delete(recursive: true));
    final file = File('${root.path}/local_memory.json');
    final blocking = _BeforeRenamePersistence(file);
    final writing = blocking.write('snapshot');
    await blocking.started.future;
    // Defensive lower-level protection, even for a different persistence object.
    await FileLifePersistence(file).purgeAbandonedPendingFiles();
    expect(await blocking.pending!.exists(), true);
    blocking.release.complete();
    await writing;
    expect(await file.readAsString(), 'snapshot');
  });

  test('reopen same path waits for retired writer before reading', () async {
    final directory = await Directory.systemTemp.createTemp(
      'memory-retirement-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/local_memory.json');
    final blocking = _BlockingFilePersistence(file);
    store = LocalMemoryStore(blocking);
    await store.open();
    final saving = save('first tea');
    await blocking.started.future;
    final closing = store.close(); // UI disposal does not await this future.
    final reopened = LocalMemoryStore(FileLifePersistence(File(file.path)));
    var opened = false;
    final opening = reopened.open().then((_) => opened = true);
    await Future<void>.delayed(Duration.zero);
    expect(opened, false);
    blocking.release.complete();
    await Future.wait([saving, closing, opening]);
    await reopened.save(
      kind: 'fact',
      text: 'second tea',
      quote: 'tea',
      userUtterance: 'tea',
    );
    await reopened.close();
    final finalStore = LocalMemoryStore(FileLifePersistence(file));
    await finalStore.open();
    expect(finalStore.recall('tea').map((e) => e.text), [
      'second tea',
      'first tea',
    ]);
    expect(
      await directory.list().where((f) => f.path.endsWith('.pending')).toList(),
      isEmpty,
    );
  });

  test(
    'recall JSON budget drops oldest whole entries, omitting quotes',
    () async {
      for (var i = 0; i < 5; i++) {
        await store.save(
          kind: 'fact',
          text: 'tea $i${'\u0001' * 195}',
          quote: 'q' * 1000,
          userUtterance: 'q' * 1000,
        );
      }
      final result = await executeLocalMemoryTool(store, 'memory_recall', {
        'query': 'tea',
      }, userUtterance: null);
      expect(jsonEncode(result).length, lessThanOrEqualTo(2800));
      expect(result['truncated'], true);
      final entries = result['entries'] as List;
      expect(entries, isNotEmpty);
      expect(entries.first['text'], startsWith('tea 4'));
      expect(entries.every((e) => !(e as Map).containsKey('quote')), true);
    },
  );

  test('unknown schema and unreadable file fail closed', () async {
    await persistence.write('{"schema_version":2,"entries":[]}');
    await store.close();
    store = LocalMemoryStore(persistence);
    await store.open();
    await expectLater(save('tea'), throwsA(isA<LocalMemoryFailure>()));
    final unavailable = LocalMemoryStore(_FailingPersistence());
    await unavailable.open();
    expect(unavailable.recall('tea'), isEmpty);
    expect(
      (await executeLocalMemoryTool(unavailable, 'memory_remember', {
        'kind': 'fact',
        'text': 'tea',
        'quote': 'tea',
      }, userUtterance: 'tea'))['error'],
      'memory_unavailable',
    );
  });

  test('failed write never reports committed or publishes memory', () async {
    final unavailable = LocalMemoryStore(_FailingPersistence(readable: true));
    await unavailable.open();
    expect(
      (await executeLocalMemoryTool(unavailable, 'memory_remember', {
        'kind': 'fact',
        'text': 'tea',
        'quote': 'tea',
      }, userUtterance: 'tea'))['status'],
      'rejected',
    );
    expect(unavailable.recall('tea'), isEmpty);
  });

  test('concurrent saves serialize without losing entries', () async {
    await Future.wait(List.generate(20, (i) => save('entry $i')));
    await store.close();
    final reopened = LocalMemoryStore(persistence);
    await reopened.open();
    addTearDown(reopened.close);
    expect(reopened.recall('entry', limit: 50), hasLength(20));
  });
}

class _FailingPersistence implements LifePersistence {
  _FailingPersistence({this.readable = false});
  final bool readable;
  @override
  Future<String?> read() async {
    if (readable) return null;
    throw const FileSystemException('unreadable');
  }

  @override
  Future<void> write(String value) async =>
      throw const FileSystemException('unwritable');
}

class _BlockingPersistence extends MemoryPersistence {
  final started = Completer<void>(), release = Completer<void>();
  @override
  Future<void> write(String value) async {
    started.complete();
    await release.future;
    await super.write(value);
  }
}

class _BlockingFilePersistence extends FileLifePersistence {
  _BlockingFilePersistence(super.file);
  final started = Completer<void>(), release = Completer<void>();
  @override
  Future<void> write(String value) async {
    started.complete();
    await release.future;
    await super.write(value);
  }
}

class _BeforeRenamePersistence extends FileLifePersistence {
  _BeforeRenamePersistence(super.file);
  final started = Completer<void>(), release = Completer<void>();
  File? pending;
  @override
  Future<void> replacePending(File temporary) async {
    pending = temporary;
    if (!started.isCompleted) {
      started.complete();
      await release.future;
    }
    await super.replacePending(temporary);
  }
}
