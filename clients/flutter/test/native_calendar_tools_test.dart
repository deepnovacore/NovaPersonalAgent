import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  test(
    'chat exposes system calendar and reminders separately from Nova items',
    () async {
      final life = LocalLife(MemoryPersistence());
      await life.open();
      final calls = <Map<String, dynamic>>[];
      final registry = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) async => {},
        queryNative: (input) async {
          calls.add(input);
          return {
            'scope': input['scope'],
            'available': true,
            'items': [
              {'id': 'system-item', 'title': 'Synthetic system item'},
            ],
          };
        },
        automaticExecution: true,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = ToolRunner(registry: registry, journal: journal);
      for (final name in ['calendar_list', 'reminders_list']) {
        final result = await runner.run(
          turnId: name,
          callId: 'c',
          name: name,
          arguments: name == 'calendar_list'
              ? {
                  'start': '2026-10-17T00:00:00+08:00',
                  'end': '2026-10-18T00:00:00+08:00',
                }
              : {'include_completed': true},
          approve: (_) async => throw StateError('No extra dialog'),
        );
        expect(result['data']['items'].single['id'], 'system-item');
      }
      expect(calls[0]['scope'], 'calendar');
      expect(calls[1]['scope'], 'reminders');
      expect(calls[1]['include_completed'], true);
      expect(
        () => registry.resolve('reminders_list', {'include_completed': 'true'}),
        throwsA(anything),
      );
      expect(life.life['todos'], isEmpty);
      life.dispose();
    },
  );
}
