import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/models.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/schedule_editor.dart';
import 'package:nova_mobile/ui/scheduled_tasks_page.dart';
import 'package:nova_mobile/ui/workbench_page.dart';

final sample = <String, dynamic>{
  'title': 'Daily priorities',
  'goal': 'Read current priorities',
  'acceptance': ['Give the next action'],
  'rule': {'kind': 'daily', 'time': '09:00', 'timezone': 'Asia/Shanghai'},
  'context': {
    'todos': true,
    'goals': true,
    'tasks': true,
    'memory': false,
    'knowledge': false,
    'search': false,
  },
};
void main() {
  test(
    'old snapshots stay compatible and schedule references reject forged metadata',
    () {
      expect(PersonalSnapshot({'revision': 1}).object('schedules'), isEmpty);
      expect(
        () => PersonalSnapshot({'revision': 1, 'schedules': []}),
        throwsFormatException,
      );
      expect(
        parseScheduleReference({
          'schedule_id': 's',
          'revision': 1,
        })?['schedule_id'],
        's',
      );
      expect(
        () => parseScheduleReference({
          'schedule_id': 's',
          'revision': 1,
          'identity': 'fake',
        }),
        throwsFormatException,
      );
    },
  );
  test('mobile retries carry the same explicit request ID', () async {
    final sent = <Map<String, dynamic>>[];
    final store = PersonalStore(
      send: (v) {
        sent.add(v);
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'test');
    final first = store.commandWithRequestId('schedules.run_now', {
      'id': 's',
      'expected_revision': 1,
    }, 'stable');
    final rejected = expectLater(first, throwsA(isA<PersonalCommandError>()));
    store.setConnected(false);
    await rejected;
    store.setConnected(true, instance: 'test');
    final retry = store.commandWithRequestId('schedules.run_now', {
      'id': 's',
      'expected_revision': 1,
    }, 'stable');
    store.receive({
      'type': 'personal.result',
      'request_id': 'stable',
      'ok': true,
      'data': {'run_id': 'r'},
    });
    await retry;
    expect(
      sent
          .where((v) => v['method'] == 'schedules.run_now')
          .map((v) => v['request_id']),
      ['stable', 'stable'],
    );
  });
  testWidgets('old hosts do not show scheduling controls', (tester) async {
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({'type': 'personal.state', 'revision': 1, 'life': {}});
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 0, onSettings: () {}),
      ),
    );
    expect(find.text('Scheduled tasks'), findsNothing);
  });
  testWidgets('editor sends the shared rule and preserves the IANA timezone', (
    tester,
  ) async {
    final calls = <Map<String, dynamic>>[];
    late PersonalStore store;
    store = PersonalStore(
      send: (frame) {
        calls.add(frame);
        scheduleMicrotask(
          () => store.receive({
            'type': 'personal.result',
            'request_id': frame['request_id'],
            'ok': true,
            'data': frame['method'] == 'schedules.preview'
                ? {
                    'next_slot': {
                      'scheduled_at': '2026-10-13T01:00:00Z',
                      'local_date': '2026-10-13',
                      'local_time': '09:00',
                    },
                  }
                : {'id': 'saved', 'revision': 1},
          }),
        );
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'test');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ScheduleEditor(store: store, value: sample),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Save schedule'));
    await tester.tap(find.text('Save schedule'));
    await tester.pumpAndSettle();
    final write = calls.singleWhere((v) => v['method'] == 'schedules.create');
    expect(
      (write['params']['input']['rule'] as Map)['timezone'],
      'Asia/Shanghai',
    );
    expect(write['params']['input']['title'], 'Daily priorities');
  });
  testWidgets('ISO Sunday is displayed and saved as weekday 7', (tester) async {
    expect(
      scheduleRuleText({
        'kind': 'weekly',
        'weekdays': [7],
        'time': '09:00',
        'timezone': 'UTC',
      }, 'en'),
      contains('Sun'),
    );
    final calls = <Map<String, dynamic>>[];
    late PersonalStore store;
    store = PersonalStore(
      send: (frame) {
        calls.add(frame);
        scheduleMicrotask(
          () => store.receive({
            'type': 'personal.result',
            'request_id': frame['request_id'],
            'ok': true,
            'data': frame['method'] == 'schedules.preview'
                ? {
                    'next_slot': {'scheduled_at': '2026-10-18T09:00:00Z'},
                  }
                : {'id': 's', 'revision': 1},
          }),
        );
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'test');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ScheduleEditor(
            store: store,
            value: {
              ...sample,
              'rule': {
                'kind': 'weekly',
                'weekdays': [1],
                'time': '09:00',
                'timezone': 'UTC',
              },
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Mon'));
    await tester.tap(find.text('Mon'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sun'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Save schedule'));
    await tester.tap(find.text('Save schedule'));
    await tester.pumpAndSettle();
    expect(
      calls.singleWhere(
        (row) => row['method'] == 'schedules.create',
      )['params']['input']['rule']['weekdays'],
      [7],
    );
  });
  testWidgets('stale edit keeps the draft and exposes explicit reload', (
    tester,
  ) async {
    late PersonalStore store;
    store = PersonalStore(
      send: (frame) {
        scheduleMicrotask(
          () => store.receive({
            'type': 'personal.result',
            'request_id': frame['request_id'],
            'ok': frame['method'] != 'schedules.update',
            'error': 'stale_schedule',
            'data': frame['method'] == 'schedules.preview'
                ? {
                    'next_slot': {'scheduled_at': '2026-10-13T01:00:00Z'},
                  }
                : {},
          }),
        );
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'test');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ScheduleEditor(
            store: store,
            value: {...sample, 'id': 's', 'revision': 1},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Task name'),
      'My edited title',
    );
    await tester.ensureVisible(find.text('Save schedule'));
    await tester.tap(find.text('Save schedule'));
    await tester.pumpAndSettle();
    expect(find.text('Load latest version'), findsOneWidget);
    expect(find.text('My edited title'), findsOneWidget);
  });
  testWidgets('history opens its Task and pause never cancels it', (
    tester,
  ) async {
    final calls = <Map<String, dynamic>>[];
    String? opened;
    late PersonalStore store;
    final item = {...sample, 'id': 's', 'revision': 1, 'enabled': true};
    store = PersonalStore(
      send: (frame) {
        calls.add(frame);
        scheduleMicrotask(
          () => store.receive({
            'type': 'personal.result',
            'request_id': frame['request_id'],
            'ok': true,
            'data': frame['method'] == 'schedules.history'
                ? {
                    'items': [
                      {
                        'run_id': 'r',
                        'task_id': 'task',
                        'claimed_at': '2026-10-12T01:00:00Z',
                        'summary': {
                          'outcome': 'completed',
                          'text': 'A verified result',
                        },
                      },
                    ],
                  }
                : item,
          }),
        );
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'test');
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'schedules': {
        'items': [item],
        'active_runs': [],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: ScheduledTasksPage(
          store: store,
          initialId: 's',
          onOpenTask: (id) async {
            opened = id;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('View task'));
    await tester.tap(find.text('View task'));
    await tester.pumpAndSettle();
    expect(opened, 'task');
    await tester.ensureVisible(find.text('Pause schedule'));
    await tester.tap(find.text('Pause schedule'));
    await tester.pumpAndSettle();
    expect(calls.any((call) => call['method'] == 'schedules.pause'), true);
    expect(calls.any((call) => call['method'] == 'tasks.cancel'), false);
  });
  testWidgets('schedule navigation fits a phone at large text sizes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'capabilities': {'schedules': true},
      'schedules': {'items': [], 'active_runs': []},
    });
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: WorkbenchPage(store: store, page: 0, onSettings: () {}),
      ),
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Scheduled tasks'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
