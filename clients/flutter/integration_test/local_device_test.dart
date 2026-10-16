import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/protocol/request_id.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/personal/life_host.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Native accessibility gestures arrive as real device pointer events.
  // Flutter's test binding otherwise discards them by default.
  binding.shouldPropagateDevicePointerEvents = true;
  const channel = MethodChannel('nova/local_agent/v1');
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> args = const {},
  ]) async {
    final value = await channel.invokeMethod<String>(method, jsonEncode(args));
    return value == null ? null : jsonDecode(value);
  }

  setUpAll(() async {
    // Enabling Android accessibility adds an engine-owned semantics handle.
    // Wait before testWidgets captures its leak-check baseline, not inside it.
    runApp(
      const MaterialApp(
        home: Scaffold(body: Center(child: Text('Nova 合成验收：等待无障碍服务就绪'))),
      ),
    );
    final deadline = DateTime.now().add(const Duration(minutes: 3));
    while ((await call('capabilities'))['accessibility'] != true &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    expect((await call('capabilities'))['accessibility'], true);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    if (const bool.fromEnvironment('NOVA_REAL_MODEL')) {
      final config = File(
        '${(await getApplicationSupportDirectory()).path}/model-acceptance.json',
      );
      if (await config.exists()) {
        try {
          await call(
            'saveModelSettings',
            jsonDecode(await config.readAsString()) as Map<String, dynamic>,
          );
        } finally {
          await config.delete();
        }
      }
      expect((await call('modelSettings'))['configured'], true);
    }
  });

  testWidgets(
    'physical device: local persistence, native observation, dedupe and stop',
    (tester) async {
      debugPrint('LIVE: checking native capabilities');
      final capabilities = await call('capabilities') as Map;
      expect(capabilities['android_api'], greaterThanOrEqualTo(30));
      expect(
        capabilities['accessibility'],
        true,
        reason: 'Enable the isolated Nova service before starting this test.',
      );
      debugPrint('LIVE: writing synthetic personal data');
      final file = File(
        '${(await getApplicationSupportDirectory()).path}/acceptance-${requestId()}.json',
      );
      addTearDown(() => file.delete());
      final repo = LocalLife(FileLifePersistence(file));
      await repo.open();
      final goal = await repo.mutate({
        'op': 'create',
        'kind': 'goal',
        'title': '真机验收目标（合成）',
      });
      await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': '离线保存待办（合成）',
        'goal_id': goal['id'],
      });
      final restored = LocalLife(FileLifePersistence(file));
      await restored.open();
      debugPrint('LIVE: persisted data reopened');
      expect(restored.life['todos'][0]['goal_id'], goal['id']);
      expect(restored.pendingCount, 2);
      await tester.pumpWidget(
        NovaApp(lifeHost: LifeHost(repository: restored)),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text('Todos').last);
      await tester.pumpAndSettle();
      expect(find.text('离线保存待办（合成）'), findsOneWidget);
      await tester.tap(find.text('Goals'));
      await tester.pumpAndSettle();
      expect(find.text('真机验收目标（合成）'), findsOneWidget);

      debugPrint('LIVE: local workspace assertions passed');
      await tester.pumpWidget(const MaterialApp(home: NativeFixture()));
      await tester.pumpAndSettle();
      final id = requestId();
      final task =
          await call('start', {
                'id': id,
                'goal': 'Toggle the synthetic fixture once',
                'acceptance': 'Fixture counter reads 1',
              })
              as Map;
      final command = {'id': id, 'control_token': task['control_token']};
      addTearDown(() => call('stop', {'id': id}));
      await Future<void>.delayed(const Duration(seconds: 1));
      final observation = await call('observe', command) as Map;
      debugPrint('LIVE: native observation received');
      expect(observation['package'], 'com.nova.nova_mobile.autonomy');
      expect(observation['image'], isNotEmpty);
      final line = (observation['tree'] as String)
          .split('\n')
          .firstWhere((line) => line.contains('Toggle fixture'));
      final bounds = RegExp(
        r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]',
      ).firstMatch(line)!;
      final x =
          (int.parse(bounds[1]!) + int.parse(bounds[3]!)) /
          2 /
          (observation['width'] as int);
      final y =
          (int.parse(bounds[2]!) + int.parse(bounds[4]!)) /
          2 /
          (observation['height'] as int);
      final action = {
        ...command,
        'attempt_id': requestId(),
        'action': {'type': 'tap', 'x': x, 'y': y},
      };
      expect((await call('execute', action))['state'], 'dispatched');
      await tester.pumpAndSettle();
      expect(find.text('Counter: 1'), findsOneWidget);
      debugPrint('LIVE: native gesture changed fixture once');
      expect((await call('execute', action))['state'], 'dispatched');
      await tester.pumpAndSettle();
      expect(find.text('Counter: 1'), findsOneWidget);
      await call('stop', {'id': id});
      await expectLater(
        call('execute', {...action, 'attempt_id': requestId()}),
        throwsA(isA<PlatformException>()),
      );
      final tasks = await call('tasks') as List;
      expect(tasks.firstWhere((row) => row['id'] == id)['phase'], 'cancelled');
      // A persisted start receipt must not restart the cancelled task.
      expect(
        (await call('start', {
          'id': id,
          'goal': 'Toggle the synthetic fixture once',
          'acceptance': 'Fixture counter reads 1',
        }))['phase'],
        'cancelled',
      );
      debugPrint('LIVE: dedupe, stop and persisted receipt assertions passed');
    },
  );
  if (const bool.fromEnvironment('NOVA_REAL_MODEL')) {
    testWidgets(
      'real model proposes native action and completion on synthetic fixture',
      (tester) async {
        await tester.pumpWidget(
          const MaterialApp(
            home: NativeFixture(key: ValueKey('model-fixture')),
          ),
        );
        await tester.pumpAndSettle();
        final id = requestId();
        addTearDown(() => call('stop', {'id': id}));
        await call('run', {
          'id': id,
          'goal':
              'Tap Toggle fixture exactly once, then stop. This is a synthetic counter test.',
          'acceptance': 'The screen visibly says Counter: 1.',
          'target_package': 'com.nova.nova_mobile.autonomy',
        });
        final deadline = DateTime.now().add(const Duration(minutes: 3));
        Map task = {};
        var approvals = 0;
        while (DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(milliseconds: 250));
          await Future<void>.delayed(const Duration(milliseconds: 250));
          task = (await call('tasks') as List).cast<Map>().firstWhere(
            (row) => row['id'] == id,
          );
          if (task['phase'] == 'waiting_approval') {
            // This harness is authorized only for this synthetic counter action.
            // It validates the proposal before granting the native single-use permit.
            final proposal = task['proposal'] as Map;
            final action = proposal['action'] as Map;
            expect(action['type'], 'tap');
            expect(
              approvals,
              0,
              reason: 'The model must not request a second tap',
            );
            final button = tester.getRect(find.text('Toggle fixture'));
            final screen = tester.view.physicalSize;
            final ratio = tester.view.devicePixelRatio;
            final x = (action['x'] as num) * screen.width / ratio;
            final y = (action['y'] as num) * screen.height / ratio;
            expect(
              button.inflate(35).contains(Offset(x, y)),
              true,
              reason: 'Only a tap within the synthetic button is authorized',
            );
            final result = await call('approve', {
              'id': id,
              'proposal_id': proposal['id'],
              'allow': true,
            });
            expect(result['accepted'], true);
            approvals++;
          }
          if ([
            'verifying',
            'completed',
            'cancelled',
            'interrupted',
          ].contains(task['phase'])) {
            break;
          }
        }
        expect(
          task['phase'],
          'verifying',
          reason:
              'Native loop must reach a completion claim: ${task['reason']}',
        );
        expect(approvals, 1);
        await tester.pumpAndSettle();
        expect(find.text('Counter: 1'), findsOneWidget);
        expect((await call('verify', {'id': id}))['phase'], 'completed');
        expect(
          (await call('run', {
            'id': id,
            'goal':
                'Tap Toggle fixture exactly once, then stop. This is a synthetic counter test.',
            'acceptance': 'The screen visibly says Counter: 1.',
            'target_package': 'com.nova.nova_mobile.autonomy',
          }))['phase'],
          'completed',
        );
        await tester.pumpAndSettle();
        expect(find.text('Counter: 1'), findsOneWidget);
        debugPrint(
          'LIVE MODEL: native loop, one approved action, completion verification and replay passed',
        );
      },
    );
  }
}

class NativeFixture extends StatefulWidget {
  const NativeFixture({super.key});
  @override
  State<NativeFixture> createState() => _NativeFixtureState();
}

class _NativeFixtureState extends State<NativeFixture> {
  int count = 0;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Nova live test · synthetic')),
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Counter: $count'),
          SizedBox(
            width: 240,
            height: 80,
            child: FilledButton(
              onPressed: () => setState(() => count++),
              child: const Text('Toggle fixture'),
            ),
          ),
        ],
      ),
    ),
  );
}
