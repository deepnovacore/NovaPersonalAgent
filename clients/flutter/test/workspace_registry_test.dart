import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/workspace_shell.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/life_reducer.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  late Directory root;
  late AgentWorkspace workspace;
  late ToolRegistry registry;
  late ToolRunner runner;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('workspace-registry-');
    workspace = AgentWorkspace(root);
    await workspace.initialize();
    registry = ToolRegistry(
      snapshot: emptyLife,
      mutate: (_, {required operationId}) async => {},
      hasConflict: () => false,
      fetch: (_) async => {},
      workspace: workspace,
      shell: WorkspaceShell(
        workspace,
        native: (method, args) async => method == 'initialize'
            ? {'ready': true}
            : {
                'status': 'completed',
                'stdout': 'native result',
                'stderr': 'failure detail',
                'exit_code': 1,
                'truncated': false,
              },
      ),
    );
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    runner = ToolRunner(registry: registry, journal: journal);
  });
  tearDown(() async => root.delete(recursive: true));
  Future<Map<String, dynamic>> run(
    String call,
    String name,
    Map<String, dynamic> args,
  ) => runner.run(
    turnId: 'turn',
    callId: call,
    name: name,
    arguments: args,
    approve: (_) async => true,
  );

  test('only general workspace tools are advertised, not artifact aliases', () {
    final names = registry.definitions.map((t) => t.wireName).toList();
    expect(
      names,
      containsAll(['file_read', 'file_write', 'file_edit', 'shell_execute']),
    );
    expect(names.any((n) => n.startsWith('artifact_')), false);
    expect(
      () => registry.resolve('artifact_write', {'title': 'x', 'html': 'x'}),
      throwsA(anything),
    );
  });
  test(
    'read after edit in the same turn returns current contents; replayed call is idempotent',
    () async {
      await run('write', 'file_write', {'path': 'a.txt', 'content': 'before'});
      expect(
        (await run('read1', 'file_read', {'path': 'a.txt'}))['data']['content'],
        'before',
      );
      await run('edit', 'file_edit', {
        'path': 'a.txt',
        'old_string': 'before',
        'new_string': 'after',
      });
      expect(
        (await run('read2', 'file_read', {'path': 'a.txt'}))['data']['content'],
        'after',
      );
      expect(
        (await run('edit', 'file_edit', {
          'path': 'a.txt',
          'old_string': 'before',
          'new_string': 'after',
        }))['status'],
        'completed',
      );
    },
  );
  test(
    'deterministic edit errors allow a corrected tool call without unknown effects',
    () async {
      await run('write', 'file_write', {'path': 'a.txt', 'content': 'before'});
      final bad = await run('bad', 'file_edit', {
        'path': 'a.txt',
        'old_string': 'absent',
        'new_string': 'after',
      });
      expect(bad['status'], 'completed');
      expect(bad['data']['error'], 'edit_match_not_found');
      final good = await run('good', 'file_edit', {
        'path': 'a.txt',
        'old_string': 'before',
        'new_string': 'after',
      });
      expect(good['data']['replacements'], 1);
    },
  );
  test('nonzero shell exit retains evidence for agent correction', () async {
    final result = await run('shell', 'shell_execute', {'command': 'false'});
    expect(result['status'], 'completed');
    expect(result['data']['exit_code'], 1);
    expect(result['data']['stderr'], 'failure detail');
  });
  test('range validation happens before native dispatch', () {
    for (final args in [
      {'command': 'x', 'timeout': 0},
      {'command': 'x', 'timeout': 3601},
    ]) {
      expect(() => registry.resolve('shell_execute', args), throwsA(anything));
    }
    expect(
      () => registry.resolve('file_read', {'path': 'x', 'limit': 2001}),
      throwsA(anything),
    );
  });
}
