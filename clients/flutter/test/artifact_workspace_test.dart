import 'package:flutter/foundation.dart' show TargetPlatform;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/artifact_workspace.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  test('local artifact tools support both mobile hosts only', () {
    expect(ArtifactWorkspace.supportsPlatform(TargetPlatform.iOS), isTrue);
    expect(ArtifactWorkspace.supportsPlatform(TargetPlatform.android), isTrue);
    expect(ArtifactWorkspace.supportsPlatform(TargetPlatform.macOS), isFalse);
    expect(ArtifactWorkspace.supportsPlatform(TargetPlatform.linux), isFalse);
  });
  test(
    'saved HTML can reopen and the same operation does not create twice',
    () async {
      final disk = MemoryPersistence();
      final workspace = ArtifactWorkspace(disk);
      await workspace.load();
      const input = {
        'title': 'Synthetic blocks',
        'html': '<!doctype html><html><body>Play</body></html>',
      };
      final created = await workspace.write(input, 'one-operation');
      expect(await workspace.write(input, 'one-operation'), created);
      final reopened = ArtifactWorkspace(disk);
      await reopened.load();
      expect(reopened.list(), hasLength(1));
      expect(reopened.read(created['artifact']['id'])['html'], input['html']);
      expect(reopened.list().single['url'], startsWith('nova-artifact://'));
    },
  );
  test(
    'version conflict and reused operation preserve the original work',
    () async {
      final workspace = ArtifactWorkspace(MemoryPersistence());
      await workspace.load();
      final first = await workspace.write({
        'title': 'A',
        'html': '<html>A</html>',
      }, 'create');
      final id = first['artifact']['id'];
      await workspace.write({
        'id': id,
        'expected_version': 1,
        'title': 'B',
        'html': '<html>B</html>',
      }, 'edit');
      await expectLater(
        workspace.write({
          'id': id,
          'expected_version': 1,
          'title': 'C',
          'html': '<html>C</html>',
        }, 'stale'),
        throwsA(anything),
      );
      await expectLater(
        workspace.write({
          'title': 'Other',
          'html': '<html>Other</html>',
        }, 'create'),
        throwsA(anything),
      );
      expect(workspace.read(id)['html'], '<html>B</html>');
      expect(workspace.list(), hasLength(1));
      expect(
        () => workspace.read('../local-conversations-v1.json'),
        throwsA(anything),
      );
    },
  );
  test(
    'test uses the saved source and persists failure then repair evidence',
    () async {
      var calls = 0;
      final disk = MemoryPersistence();
      final workspace = ArtifactWorkspace(
        disk,
        inspect: (html, script) async {
          calls++;
          expect(script, 'return document.title;');
          return {
            'loaded': true,
            'errors': calls == 1 ? ['ReferenceError'] : [],
            'result': 'Blocks',
          };
        },
      );
      await workspace.load();
      final written = await workspace.write({
        'title': 'Blocks',
        'html': '<html>broken</html>',
      }, 'one');
      final id = written['artifact']['id'];
      final broken = await workspace.test(id, 'return document.title;');
      expect(broken['errors'], isNotEmpty);
      await workspace.write({
        'id': id,
        'expected_version': 1,
        'title': 'Blocks',
        'html': '<html>fixed</html>',
      }, 'two');
      expect(workspace.read(id)['test'], isNull);
      expect(
        (await workspace.test(id, 'return document.title;'))['errors'],
        isEmpty,
      );
      final reopened = ArtifactWorkspace(disk);
      await reopened.load();
      expect(reopened.read(id)['test']['version'], 2);
    },
  );
  test(
    'registry routes artifact tools without mutating personal items or asking approval',
    () async {
      final life = LocalLife(MemoryPersistence());
      await life.open();
      final workspace = ArtifactWorkspace(MemoryPersistence());
      await workspace.load();
      final registry = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) async => {},
        artifacts: workspace,
        automaticExecution: true,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final result = await ToolRunner(registry: registry, journal: journal).run(
        turnId: 't',
        callId: 'c',
        name: 'artifact_write',
        arguments: {'title': 'Game', 'html': '<html>Play</html>'},
        approve: (_) async => throw StateError('No dialog'),
      );
      expect(result['status'], 'completed');
      expect(workspace.list(), hasLength(1));
      expect(life.life['todos'], isEmpty);
      expect(life.life['ideas'], isEmpty);
      expect(life.life['goals'], isEmpty);
      expect(
        () => registry.resolve('artifact_write', {
          'title': 'bad',
          'html': 'x' * 300000,
        }),
        throwsA(anything),
      );
      life.dispose();
    },
  );
}
