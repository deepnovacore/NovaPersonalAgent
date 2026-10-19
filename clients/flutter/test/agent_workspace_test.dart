import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';

class SwappingWorkspace extends AgentWorkspace {
  SwappingWorkspace(super.root, this.outside);
  final Directory outside;
  bool swapped = false;
  @override
  Future<File> resolve(String path) async {
    final checked = await super.resolve(path);
    if (!swapped && path.contains('folder/')) {
      swapped = true;
      await Directory('${root.path}/folder').rename('${root.path}/original');
      await Link('${root.path}/folder').create(outside.path);
    }
    return checked;
  }
}

class YieldingWorkspace extends AgentWorkspace {
  YieldingWorkspace(super.root, this.onRead);
  final void Function() onRead;
  @override
  Future<File> resolve(String path) async {
    final checked = await super.resolve(path);
    Timer.run(onRead);
    return checked;
  }
}

void main() {
  late Directory root;
  late AgentWorkspace workspace;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('workspace-test-');
    workspace = AgentWorkspace(root);
    await workspace.initialize();
  });
  tearDown(() async => root.delete(recursive: true));

  for (final action in ['read', 'write', 'edit']) {
    test(
      'concurrent symlink replacement cannot escape during $action',
      () async {
        final outside = await Directory.systemTemp.createTemp(
          'private-workspace-test-',
        );
        addTearDown(() => outside.delete(recursive: true));
        await Directory('${root.path}/folder').create();
        await File(
          '${root.path}/folder/secret',
        ).writeAsString('workspace-value');
        await File('${outside.path}/secret').writeAsString('private-value');
        final racing = SwappingWorkspace(root, outside);
        await expectLater(switch (action) {
          'read' => racing.read('folder/secret'),
          'write' => racing.write('folder/secret', 'overwritten'),
          _ => racing.edit('folder/secret', 'private-value', 'overwritten'),
        }, throwsA(anything));
        expect(
          await File('${outside.path}/secret').readAsString(),
          'private-value',
        );
      },
    );
  }
  test('workspace root itself must not be a symbolic link', () async {
    final real = Directory('${root.path}-real');
    await root.rename(real.path);
    await Link(root.path).create(real.path);
    addTearDown(() => real.delete(recursive: true));
    await expectLater(workspace.write('secret', 'bad'), throwsA(anything));
    expect(await File('${real.path}/secret').exists(), false);
  });
  test(
    'large offset scans yield without reopening a replaced file path',
    () async {
      final original = File('${root.path}/large.txt');
      await original.writeAsString('${'x\n' * 200000}safe\n');
      var yielded = false;
      final reader = YieldingWorkspace(root, () {
        yielded = true;
        original.renameSync('${root.path}/old.txt');
        original.writeAsStringSync('replacement');
      });
      final result = await reader.read('large.txt', offset: 200001, limit: 1);
      expect(yielded, true);
      expect(result['content'], 'safe\n');
    },
  );
  test(
    'real files survive reopening and are directly visible to native tools',
    () async {
      final result = await workspace.write(
        '/workspace/项目 🎧/hello.py',
        'print("hello")\n',
      );
      expect(
        await File('${root.path}/项目 🎧/hello.py').readAsString(),
        'print("hello")\n',
      );
      expect(
        result['url'],
        'nova-file:///workspace/%E9%A1%B9%E7%9B%AE%20%F0%9F%8E%A7/hello.py',
      );
      final other = AgentWorkspace(root);
      await other.initialize();
      expect(
        (await other.read('项目 🎧/hello.py'))['content'],
        'print("hello")\n',
      );
    },
  );
  test(
    'exact edits fail without changes on missing or ambiguous text',
    () async {
      await workspace.write('a.txt', 'one\none\n');
      await expectLater(
        workspace.edit('a.txt', 'one', 'two'),
        throwsA(anything),
      );
      await expectLater(
        workspace.edit('a.txt', 'absent', 'two'),
        throwsA(anything),
      );
      expect((await workspace.read('a.txt'))['content'], 'one\none\n');
      expect(
        (await workspace.edit(
          'a.txt',
          'one',
          'two',
          replaceAll: true,
        ))['replacements'],
        2,
      );
      expect((await workspace.read('a.txt'))['content'], 'two\ntwo\n');
    },
  );
  test(
    'empty writes, directory listings and line pagination are supported',
    () async {
      await workspace.write('empty.txt', '');
      await workspace.write('lines.txt', 'alpha\nbeta\ngamma\n');
      final page = await workspace.read('lines.txt', offset: 2, limit: 1);
      expect(page['content'], 'beta\n');
      expect(page['truncated'], true);
      expect(
        (await workspace.read('/workspace'))['entries'],
        contains(containsPair('name', 'empty.txt')),
      );
      expect((await workspace.read('empty.txt'))['content'], '');
    },
  );
  test('binary files are identified and large reads are bounded', () async {
    await File('${root.path}/binary').writeAsBytes([0, 255, 1]);
    expect((await workspace.read('binary'))['binary'], true);
    await File('${root.path}/large.txt').writeAsString('x' * 100000);
    final result = await workspace.read('large.txt');
    expect(
      utf8.encode(result['content'] as String).length,
      lessThanOrEqualTo(65536),
    );
    expect(result['truncated'], true);
  });
  test(
    'host paths, traversal and links outside workspace are rejected',
    () async {
      for (final path in [
        '/etc/passwd',
        '../outside',
        '/workspace/../../outside',
        'bad\u0000name',
      ]) {
        await expectLater(workspace.write(path, 'bad'), throwsA(anything));
      }
      final outside = await Directory.systemTemp.createTemp(
        'outside-workspace-',
      );
      try {
        await File('${outside.path}/secret').writeAsString('private');
        await Link('${root.path}/escape').create(outside.path);
        await expectLater(workspace.read('escape/secret'), throwsA(anything));
        await expectLater(
          workspace.write('escape/new', 'bad'),
          throwsA(anything),
        );
        expect(await File('${outside.path}/new').exists(), false);
      } finally {
        await outside.delete(recursive: true);
      }
    },
  );
  test(
    'legacy migration is idempotent, preserves edited files and old links',
    () async {
      final legacy = File('${root.path}/legacy.json');
      await legacy.writeAsString(
        jsonEncode({
          'schema_version': 1,
          'items': {
            'fixture': {
              'id': 'fixture',
              'title': 'Old',
              'html': '<html>original</html>',
              'version': 1,
            },
          },
          'receipts': {},
        }),
      );
      await workspace.migrateLegacy(legacy);
      expect(
        (await workspace.read(
          '/workspace/artifacts/fixture/index.html',
        ))['content'],
        '<html>original</html>',
      );
      await workspace.write(
        '/workspace/artifacts/fixture/index.html',
        '<html>edited</html>',
      );
      await workspace.migrateLegacy(legacy);
      expect(
        (await workspace.read(
          '/workspace/artifacts/fixture/index.html',
        ))['content'],
        '<html>edited</html>',
      );
      expect(
        workspace.previewPath('nova-artifact://fixture'),
        '/workspace/artifacts/fixture/index.html',
      );
      expect(
        workspace.previewPath('nova-file:///workspace/a.html'),
        '/workspace/a.html',
      );
      expect(await legacy.exists(), true);
    },
  );
  test(
    'successful migration stays complete after users delete or move files',
    () async {
      final legacy = File(
        '${root.parent.path}/${root.uri.pathSegments.where((s) => s.isNotEmpty).last}-legacy.json',
      );
      final checkpoint = File('${legacy.path}.migration-v1.json');
      addTearDown(() async {
        if (await legacy.exists()) await legacy.delete();
        if (await checkpoint.exists()) await checkpoint.delete();
      });
      await legacy.writeAsString(
        jsonEncode({
          'schema_version': 1,
          'items': {
            'deleted': {'html': '<html>delete me</html>'},
            'moved': {'html': '<html>move me</html>'},
          },
        }),
      );
      await workspace.migrateLegacy(legacy);
      await File('${root.path}/artifacts/deleted/index.html').delete();
      await File(
        '${root.path}/artifacts/moved/index.html',
      ).rename('${root.path}/moved.html');
      await AgentWorkspace(root).migrateLegacy(legacy);
      expect(
        await File('${root.path}/artifacts/deleted/index.html').exists(),
        false,
      );
      expect(
        await File('${root.path}/artifacts/moved/index.html').exists(),
        false,
      );
      expect(
        await File('${root.path}/moved.html').readAsString(),
        '<html>move me</html>',
      );
      expect(await checkpoint.exists(), true);
      expect(await legacy.exists(), true);
    },
  );
  test(
    'preview and browser checks load the saved file, including subsequent edits',
    () async {
      String? seen;
      final browser = AgentWorkspace(
        root,
        inspect: (html, script) async {
          seen = html;
          return {'loaded': true, 'result': script};
        },
        present: (_, html) async {
          seen = html;
        },
      );
      await browser.write('index.html', '<html>A</html>');
      await browser.write('check.js', 'return document.title;');
      expect(
        (await browser.inspectFiles(
          '/workspace/index.html',
          '/workspace/check.js',
        ))['result'],
        'return document.title;',
      );
      expect(seen, '<html>A</html>');
      await browser.write('index.html', '<html>B</html>');
      await browser.openPreview('nova-file:///workspace/index.html');
      expect(seen, '<html>B</html>');
    },
  );
}
