import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root, sources;
  late AgentWorkspace workspace;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('document-workspace-');
    sources = await Directory.systemTemp.createTemp('document-sources-');
    workspace = AgentWorkspace(root);
    await workspace.initialize();
  });
  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(AgentWorkspace.channel, null);
    await root.delete(recursive: true);
    await sources.delete(recursive: true);
  });

  test('importDocument copies binary files to unique inbox paths', () async {
    final source = File('${sources.path}/table.xlsx');
    final bytes = [80, 75, 0, 255, 1];
    await source.writeAsBytes(bytes);
    final first = await workspace.importDocument(source, '表格.xlsx');
    final second = await workspace.importDocument(source, '表格.xlsx');
    expect(first['path'], startsWith('/workspace/inbox/'));
    expect(first['path'], isNot(second['path']));
    expect(await workspace.documentSnapshot(first['url'] as String), bytes);
    await source.writeAsString('changed');
    expect(await workspace.documentSnapshot(first['path'] as String), bytes);
  });

  test(
    'importDocument rejects unsupported, path-like and oversized files',
    () async {
      final source = File('${sources.path}/input.pdf')
        ..writeAsStringSync('PDF');
      for (final name in [
        '../input.pdf',
        'dir/input.pdf',
        r'dir\input.pdf',
        'input.exe',
        'input\n.pdf',
      ]) {
        await expectLater(
          workspace.importDocument(source, name),
          throwsA(anything),
        );
      }
      final handle = await source.open(mode: FileMode.write);
      await handle.truncate(AgentWorkspace.documentBytes + 1);
      await handle.close();
      await expectLater(
        workspace.importDocument(source, 'input.pdf'),
        throwsA(anything),
      );
      expect(await Directory('${root.path}/inbox').exists(), false);
    },
  );

  test(
    'importDocument rejects source leaf, ancestor and inbox symlinks',
    () async {
      final source = File('${sources.path}/input.pdf')
        ..writeAsStringSync('secret');
      final leaf = Link('${sources.path}/link.pdf');
      await leaf.create(source.path);
      await expectLater(
        workspace.importDocument(File(leaf.path), 'input.pdf'),
        throwsA(anything),
      );
      final alias = Link('${root.path}/source');
      await alias.create(sources.path);
      await expectLater(
        workspace.importDocument(File('${alias.path}/input.pdf'), 'input.pdf'),
        throwsA(anything),
      );
      await Link('${root.path}/inbox').create(sources.path);
      await expectLater(
        workspace.importDocument(source, 'input.pdf'),
        throwsA(anything),
      );
      expect(await source.readAsString(), 'secret');
    },
  );

  test(
    'openFile shares a bounded binary snapshot, not a live host path',
    () async {
      await Directory('${root.path}/outputs').create();
      await File(
        '${root.path}/outputs/report.pdf',
      ).writeAsBytes([37, 80, 68, 70]);
      MethodCall? call;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(AgentWorkspace.channel, (value) async {
            call = value;
            return null;
          });
      await workspace.openFile('nova-file:///workspace/outputs/report.pdf');
      expect(call!.method, 'shareFile');
      expect(call!.arguments, {
        'name': 'report.pdf',
        'bytes': [37, 80, 68, 70],
      });
    },
  );

  test(
    'documentSnapshot refuses traversal, remote URLs, links and directories',
    () async {
      await workspace.write('outputs/ok.txt', 'safe');
      await workspace.write('.nova/private.txt', 'private');
      await Link(
        '${root.path}/outputs/link.txt',
      ).create('${root.path}/outputs/ok.txt');
      await Link('${root.path}/inbox').create(sources.path);
      await File('${sources.path}/outside.pdf').writeAsString('outside');
      for (final path in [
        '/outside/ok.txt',
        '/workspace/../outside',
        'nova-file://remote/workspace/ok.txt',
        'nova-file:///workspace/%2e%2e/outside',
        'nova-file:///workspace/ok.txt?x=1',
        'nova-file:///workspace/a/../ok.txt',
        'nova-file:///workspace/a%2F..%2Fok.txt',
        '/workspace/outputs/link.txt',
        '/workspace/inbox/outside.pdf',
        '/workspace/.nova/private.txt',
        '/workspace/outputs/%252e%252e/private.txt',
        'nova-file:///workspace/outputs/%252e%252e/private.txt',
        'nova-file:///workspace/outputs/子目录/../ok.txt',
        'nova-file:///workspace/outputs/子目录%2F..%2Fok.txt',
        '/workspace',
      ]) {
        await expectLater(
          workspace.documentSnapshot(path),
          throwsA(anything),
          reason: path,
        );
      }
    },
  );

  test('documentSnapshot decodes URL names exactly once', () async {
    for (final name in ['摘要 100%.txt', '%2e%2e.txt']) {
      final saved = await workspace.write('outputs/$name', 'safe');
      expect(await workspace.documentSnapshot(saved['url'] as String), [
        115,
        97,
        102,
        101,
      ]);
    }
  });

  test('documentSnapshot accepts a raw Chinese DOCX URL', () async {
    await workspace.write('outputs/工作文档.docx', 'safe');
    expect(
      await workspace.documentSnapshot(
        'nova-file:///workspace/outputs/工作文档.docx',
      ),
      [115, 97, 102, 101],
    );
  });

  test(
    'document byte limit is inclusive on import and enforced on export',
    () async {
      final source = File('${sources.path}/limit.pdf');
      final input = await source.open(mode: FileMode.write);
      await input.truncate(AgentWorkspace.documentBytes);
      await input.close();
      final saved = await workspace.importDocument(source, 'limit.pdf');
      expect(saved['bytes'], AgentWorkspace.documentBytes);
      await Directory('${root.path}/outputs').create();
      final output = await File(
        '${root.path}/outputs/too-large.pdf',
      ).open(mode: FileMode.write);
      await output.truncate(AgentWorkspace.documentBytes + 1);
      await output.close();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(AgentWorkspace.channel, (_) async {
            fail('oversized output reached system viewer');
          });
      await expectLater(
        workspace.openFile('/workspace/outputs/too-large.pdf'),
        throwsA(anything),
      );
    },
  );

  test(
    'openFile preserves HTML preview without a platform share call',
    () async {
      String? html;
      final preview = AgentWorkspace(
        root,
        present: (_, value) async {
          html = value;
        },
      );
      await preview.write('page.html', '<p>hello</p>');
      await preview.openFile('nova-file:///workspace/page.html');
      expect(html, '<p>hello</p>');
    },
  );
}
