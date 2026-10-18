import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/schedule_repository.dart';
import 'package:nova_mobile/agent_core/schedule_time.dart';
import 'package:nova_mobile/agent_core/scheduled_agent_runner.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class FixtureSettings extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => ModelConfiguration(
    endpoint: 'https://model.invalid',
    model: 'fixture',
    key: 'fixture-key',
  );
}

class ScheduleModel extends ModelClient {
  int calls = 0;
  bool write = false;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration config,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    calls++;
    if (calls == 1) {
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'call',
            'function': {
              'name': write ? 'life_create' : 'life_list',
              'arguments': write
                  ? '{"kind":"todo","title":"Needs approval"}'
                  : '{"kind":"todo"}',
            },
          },
        ],
      };
    } else {
      yield {'content': 'Read the authorized local tasks.'};
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test(
    'due task invokes the ordinary model and journal once, then persists its terminal receipt',
    () async {
      var now = DateTime.utc(2026, 10, 17, 8);
      final life = LifeHost(repository: LocalLife(MemoryLifePersistence()));
      await life.open();
      life.didChangeAppLifecycleState(AppLifecycleState.paused);
      final repo = ScheduleRepository(
        MemoryLifePersistence(),
        deviceId: 'phone',
        clock: ScheduleClock(),
        now: () => now,
      );
      await repo.open();
      await repo.create({
        'title': 'Fixture',
        'goal': 'Read local tasks',
        'acceptance': 'Summary',
        'rule': {'kind': 'daily', 'timezone': 'UTC', 'time': '09:00'},
        'provider': 'https://model.invalid|fixture',
        'context': {'life': true, 'web': false},
      });
      final model = ScheduleModel(),
          runner = ScheduledAgentRunner(
            repo,
            life,
            FixtureSettings(),
            clientFactory: () => model,
          );
      now = DateTime.utc(2026, 10, 17, 9);
      await runner.wake();
      expect(model.calls, 2);
      expect(repo.runs.single['status'], 'completed');
      expect(repo.runs.single['task_id'], isNotNull);
      expect(
        await runner.result(repo.runs.single['run_id'] as String),
        contains('Read the authorized local tasks.'),
      );
      await runner.wake();
      expect(model.calls, 2);
      runner.dispose();
      life.dispose();
    },
  );
  test(
    'cancel while awaiting approval persists control revision before a late acceptance',
    () async {
      var now = DateTime.utc(2026, 10, 17, 8);
      final life = LifeHost(repository: LocalLife(MemoryLifePersistence()));
      await life.open();
      life.didChangeAppLifecycleState(AppLifecycleState.paused);
      final repo = ScheduleRepository(
        MemoryLifePersistence(),
        deviceId: 'phone',
        clock: ScheduleClock(),
        now: () => now,
      );
      await repo.open();
      await repo.create({
        'title': 'Fixture',
        'goal': 'Create a task',
        'acceptance': 'Pending',
        'rule': {'kind': 'daily', 'timezone': 'UTC', 'time': '09:00'},
        'provider': 'https://model.invalid|fixture',
        'context': {'life': true, 'web': false},
      });
      final model = ScheduleModel()..write = true;
      final runner = ScheduledAgentRunner(
        repo,
        life,
        FixtureSettings(),
        clientFactory: () => model,
      );
      final waiting = Completer<void>();
      runner.addListener(() {
        if (runner.pendingApproval != null && !waiting.isCompleted) {
          waiting.complete();
        }
      });
      now = DateTime.utc(2026, 10, 17, 9);
      final running = runner.wake();
      await waiting.future;
      final run = repo.runs.single;
      await runner.cancel(run['run_id'], 0);
      runner.approve(true);
      await running;
      expect(repo.runs.single['status'], 'cancelled');
      expect(life.snapshot()['todos'], isEmpty);
      runner.dispose();
      life.dispose();
    },
  );
}
