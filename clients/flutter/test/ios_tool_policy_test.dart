import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  test(
    'automatic chat writes once without an approval dialog and preserves receipts',
    () async {
      final life = LocalLife(MemoryPersistence());
      await life.open();
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final registry = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) async => {},
        automaticExecution: true,
      );
      final runner = ToolRunner(registry: registry, journal: journal);
      Future<Map<String, dynamic>> create() => runner.run(
        turnId: 'one-turn',
        callId: 'one-call',
        name: 'life_create',
        arguments: {'kind': 'idea', 'title': 'Synthetic automatic idea'},
        approve: (_) async => throw StateError('Unexpected approval dialog'),
      );
      expect((await create())['status'], 'completed');
      expect((await create())['status'], 'completed');
      expect(life.life['ideas'], hasLength(1));
      final reread = LocalLife(life.persistence);
      await reread.open();
      expect(reread.life['ideas'], hasLength(1));
      life.dispose();
      reread.dispose();
    },
  );
  test(
    'native tool schema constrains scope and forwards stable operation id',
    () async {
      final life = LocalLife(MemoryPersistence());
      await life.open();
      Map<String, dynamic>? dispatched;
      String? operation;
      final registry = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) async => {},
        automaticExecution: true,
        runChatTask: (input, id) async {
          dispatched = input;
          operation = id;
          return {'status': 'completed'};
        },
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = ToolRunner(registry: registry, journal: journal);
      const request = {
        'goal': 'Read synthetic note',
        'scope': 'nova',
        'acceptance': 'Report exact note',
      };
      expect(
        (await runner.run(
          turnId: 't',
          callId: 'c',
          name: 'device_run_task',
          arguments: request,
          approve: (_) async => throw StateError('Unexpected dialog'),
        ))['status'],
        'completed',
      );
      expect(dispatched, request);
      expect(operation, isNotEmpty);
      expect(
        () =>
            registry.resolve('device_run_task', {...request, 'scope': 'shell'}),
        throwsA(anything),
      );
      expect(
        () => registry.resolve('device_run_task', {
          ...request,
          'interaction_mode': 'manual',
        }),
        throwsA(anything),
      );
      life.dispose();
    },
  );
}
