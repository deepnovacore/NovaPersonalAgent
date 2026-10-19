import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/workspace_posix.dart';

void main() {
  test(
    'held directory descriptors survive path replacement without following links',
    () async {
      final base = await Directory.systemTemp.createTemp(
        'descriptor-workspace-',
      );
      addTearDown(() => base.delete(recursive: true));
      final root = await Directory('${base.path}/workspace').create();
      final outside = await Directory('${base.path}/private').create();
      await Directory('${root.path}/folder').create();
      await File('${root.path}/folder/value').writeAsString('original');
      await File('${outside.path}/value').writeAsString('private');
      final directory = WorkspaceDirectory.openRoot(root.path);
      addTearDown(directory.close);
      final held = directory.child('folder');
      addTearDown(held.close);
      await Directory('${root.path}/folder').rename('${root.path}/renamed');
      await Link('${root.path}/folder').create(outside.path);
      final file = held.file('value');
      try {
        expect(utf8.decode(file.readAll(100)), 'original');
      } finally {
        file.close();
      }
      held.atomicWrite('value', utf8.encode('updated'));
      expect(
        await File('${root.path}/renamed/value').readAsString(),
        'updated',
      );
      expect(await File('${outside.path}/value').readAsString(), 'private');
      expect(
        held.listing()['entries'],
        contains(containsPair('name', 'value')),
      );
      expect(
        () => directory.child('folder'),
        throwsA(isA<FileSystemException>()),
      );
    },
  );
  test(
    'atomic migration install never overwrites existing content and leaves no temporary files',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'descriptor-migration-',
      );
      addTearDown(() => root.delete(recursive: true));
      final directory = WorkspaceDirectory.openRoot(root.path);
      addTearDown(directory.close);
      directory.atomicWrite(
        'index.html',
        utf8.encode('first'),
        onlyIfMissing: true,
      );
      directory.atomicWrite(
        'index.html',
        utf8.encode('replacement'),
        onlyIfMissing: true,
      );
      final input = directory.file('index.html');
      try {
        expect(input.length, 5);
        expect(utf8.decode(input.readAll(10)), 'first');
      } finally {
        input.close();
      }
      expect((directory.listing()['entries'] as List).length, 1);
      final empty = directory.child('empty', create: true);
      try {
        expect(empty.listing()['entries'], isEmpty);
      } finally {
        empty.close();
      }
    },
  );
}
