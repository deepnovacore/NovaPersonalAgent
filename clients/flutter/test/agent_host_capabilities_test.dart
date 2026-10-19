import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/workspace_shell.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

class PromptModel extends ModelClient {
  String instructions = '';
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration config,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    instructions = messages
        .where((m) => m['role'] == 'system')
        .map((m) => m['content'])
        .join('\n');
    yield {'content': 'Ready'};
  }
}

class RecordingShell extends WorkspaceShell {
  RecordingShell(super.workspace);
  int cancellations = 0;
  @override
  Future<void> cancel() async {
    cancellations++;
  }
}

void main() {
  test(
    'host cancels only its active shell tool, not unrelated conversation work',
    () async {
      final workspace = AgentWorkspace(Directory('/unused-test-workspace'));
      final shell = RecordingShell(workspace);
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final registry = ToolRegistry(
        snapshot: () => {},
        mutate: (input, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        workspace: workspace,
        shell: shell,
      );
      final host = AgentCoreHost(
        store: store,
        settings: FixtureSettings(),
        tools: ToolRunner(
          registry: registry,
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
      host.cancel();
      expect(shell.cancellations, 0);
      host.activeTool = 'file_read';
      host.cancel();
      expect(shell.cancellations, 0);
      host.activeTool = 'shell_execute';
      host.cancel();
      expect(shell.cancellations, 1);
      host.activeTool = null;
      host.dispose();
      expect(shell.cancellations, 1);
    },
  );
  test(
    'host explains file and Linux tools with browser checks through shell',
    () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final model = PromptModel();
      final host = AgentCoreHost(
        store: store,
        settings: FixtureSettings(),
        clientFactory: () => model,
      );
      addTearDown(host.dispose);
      await host.send(id, 'Build a game');
      for (final tool in [
        'file_read',
        'file_write',
        'file_edit',
        'shell_execute',
      ]) {
        expect(model.instructions, contains(tool));
      }
      expect(
        model.instructions,
        contains('self-contained HTML with inline CSS and JavaScript'),
      );
      expect(model.instructions, contains('bundle'));
      expect(
        model.instructions,
        contains('Relative files and network assets are not loaded'),
      );
      expect(model.instructions, contains('Linux'));
      expect(model.instructions, contains('Python'));
      expect(model.instructions, contains('package installation'));
      expect(model.instructions, contains('nova-file:///workspace/'));
      expect(
        model.instructions,
        contains(
          'nova-browser inspect --path /workspace/index.html --script /workspace/check.js',
        ),
      );
      expect(model.instructions, isNot(contains('artifact_write')));
      expect(model.instructions, isNot(contains('not Python')));
    },
  );
}
