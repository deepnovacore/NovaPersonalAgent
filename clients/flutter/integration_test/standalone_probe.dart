import 'dart:io';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/life_reducer.dart';
import 'package:nova_mobile/personal/local_life.dart';

// Synthetic storage only. No model, native actions, Hub or production Life file.
Future<List<String>> runStandaloneProbe(Directory directory) async {
  final checks = <String>[];
  void check(bool ok, String name) {
    if (!ok) throw StateError(name);
    checks.add(name);
  }

  final persistence = FileLifePersistence(File('${directory.path}/life.json'));
  var life = LocalLife(persistence);
  try {
    await life.open();
    for (final kind in ['todo', 'idea', 'goal']) {
      await life.mutate({
        'op': 'create',
        'kind': kind,
        'title': 'Synthetic $kind',
      }, operationId: 'seed-$kind');
    }
    final todo = (life.life['todos'] as List).single as Map;
    await life.mutate({
      'op': 'update',
      'kind': 'todo',
      'id': todo['id'],
      'expected_version': todo['version'],
      'note': 'persisted edit',
    }, operationId: 'edit-todo');
    life.dispose();
    life = LocalLife(persistence);
    await life.open();
    check(
      [
            'todos',
            'ideas',
            'goals',
          ].every((key) => (life.life[key] as List).length == 1) &&
          life.life['todos'][0]['note'] == 'persisted edit',
      'file_reopen_preserves_three_kinds_and_edit',
    );
    var writes = 0, approvals = 0;
    final registry = ToolRegistry(
      snapshot: () => life.life,
      mutate: (input, {required operationId}) async {
        writes++;
        return life.mutate(input, operationId: operationId);
      },
      hasConflict: () => life.conflict != null,
      fetch: (_) async => throw StateError('network_not_allowed'),
    );
    final journalFile = FileLifePersistence(
      File('${directory.path}/tools.json'),
    );
    var journal = ToolJournal(journalFile);
    await journal.open();
    var runner = ToolRunner(registry: registry, journal: journal);
    Future<Map<String, dynamic>> call(
      String turn,
      String name,
      Map<String, dynamic> args,
      bool allow,
    ) => runner.run(
      turnId: turn,
      callId: 'synthetic-call',
      name: name,
      arguments: args,
      approve: (_) async {
        approvals++;
        return allow;
      },
    );
    final read = await call('read', 'life_list', {'kind': 'todo'}, false);
    check(
      read['status'] == 'completed' && approvals == 0 && writes == 0,
      'read_requires_no_approval_or_write',
    );
    final args = {'kind': 'todo', 'title': 'Synthetic approved todo'};
    final denied = await call('denied', 'life_create', args, false);
    await call('denied', 'life_create', args, true);
    check(
      denied['status'] == 'denied' && writes == 0 && approvals == 1,
      'denial_is_terminal_without_write',
    );
    final created = await call('allowed', 'life_create', args, true);
    check(
      created['status'] == 'completed' && writes == 1 && approvals == 2,
      'approved_create_writes_once',
    );
    journal = ToolJournal(journalFile);
    await journal.open();
    runner = ToolRunner(registry: registry, journal: journal);
    final replay = await call('allowed', 'life_create', args, true);
    check(
      lifeFingerprint(created) == lifeFingerprint(replay) &&
          writes == 1 &&
          approvals == 2 &&
          (life.life['todos'] as List).length == 2,
      'reopened_journal_replay_does_not_duplicate',
    );
    final unknownArgs = {
      'kind': 'todo',
      'title': 'Synthetic interrupted intent',
    };
    final fingerprint = lifeFingerprint({
      'name': 'life_create',
      'arguments': unknownArgs,
    });
    await journal.put('interrupted:$fingerprint', {
      'status': 'executing',
      'operation_id': 'synthetic-interrupted',
    });
    journal = ToolJournal(journalFile);
    await journal.open();
    runner = ToolRunner(registry: registry, journal: journal);
    final unknown = await call('new-turn', 'life_create', unknownArgs, true);
    check(
      unknown['status'] == 'outcome_unknown' && writes == 1 && approvals == 2,
      'interrupted_intent_is_not_retried',
    );
    return checks;
  } finally {
    life.dispose();
  }
}
