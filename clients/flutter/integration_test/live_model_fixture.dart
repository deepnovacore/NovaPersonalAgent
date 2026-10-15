import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/protocol/request_id.dart';

// Attach-only acceptance entrypoint. It never ships in the normal application.
// Uses real pointer dispatch and a strict allowlist for one synthetic tap.
void main() => runApp(const MaterialApp(home: LiveModelFixture()));

class LiveModelFixture extends StatefulWidget {
  const LiveModelFixture({super.key});
  @override State<LiveModelFixture> createState() => _LiveModelFixtureState();
}
class _LiveModelFixtureState extends State<LiveModelFixture> {
  static const channel = MethodChannel('nova/local_agent/v1');
  final button = GlobalKey();
  int counter = 0;
  String status = '准备验收';
  String? taskId;
  bool running = false;
  Future<dynamic> call(String method, [Map<String, dynamic> input = const {}]) async {
    final raw = await channel.invokeMethod<String>(method, jsonEncode(input));
    return raw == null ? null : jsonDecode(raw);
  }
  @override void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(run()));
  }
  void check(bool value, String message) { if (!value) throw StateError(message); }
  Future<void> run() async {
    if (running) return;
    running = true;
    final root = await getApplicationSupportDirectory();
    final result = <String, dynamic>{'started_at': DateTime.now().toUtc().toIso8601String(), 'fixture': 'one_native_tap'};
    try {
      check((await call('capabilities'))['accessibility'] == true, 'accessibility_required');
      final config = File('${root.path}/model-acceptance.json');
      if (await config.exists()) {
        try { await call('saveModelSettings', jsonDecode(await config.readAsString()) as Map<String, dynamic>); }
        finally { await config.delete(); }
      }
      final settings = await call('modelSettings') as Map;
      check(settings['configured'] == true, 'model_configuration_required');
      result['model'] = settings['model'];
      result['model_endpoint'] = settings['endpoint'];
      final probeId = requestId();
      final probe = await call('start', {'id': probeId, 'goal': 'Observe synthetic fixture only', 'acceptance': 'Observation available'});
      try {
        final frame = await call('observe', {'id': probeId, 'control_token': probe['control_token']});
        result['observation_probe'] = {'package': frame['package'], 'width': frame['width'], 'height': frame['height'], 'has_image': (frame['image'] as String).isNotEmpty};
      } finally { await call('stop', {'id': probeId}); }
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
      try {
        final request = await client.getUrl(Uri.parse(settings['endpoint'] as String));
        request.followRedirects = false;
        final response = await request.close().timeout(const Duration(seconds: 20));
        result['network_probe_status'] = response.statusCode;
        await response.drain<void>();
      } finally { client.close(force: true); }
      if (!mounted) return;
      setState(() => status = '真实模型验收进行中');
      await Future<void>.delayed(const Duration(milliseconds: 700));
      final id = requestId(); taskId = id; result['task_id'] = id;
      final input = {'id': id, 'goal': 'Tap Toggle fixture exactly once. This is a synthetic counter acceptance test.',
        'acceptance': 'The screen visibly says Counter: 1.', 'target_package': 'com.nova.nova_mobile.autonomy'};
      await call('run', input);
      final deadline = DateTime.now().add(const Duration(minutes: 3));
      var approvals = 0;
      Map task = {};
      final phases = <String>[];
      final approved = <String>{};
      while (DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 300));
        task = (await call('tasks') as List).cast<Map>().firstWhere((task) => task['id'] == id);
        if (phases.isEmpty || phases.last != task['phase']) {
          phases.add(task['phase']); debugPrint('LIVE MODEL phase: ${task['phase']}');
        }
        if (task['phase'] == 'waiting_approval') {
          final proposal = task['proposal'] as Map, action = task['proposal']['action'] as Map;
          if (approved.contains(proposal['id'])) continue;
          check(approvals == 0 && action['type'] == 'tap', 'only_one_fixture_tap_allowed');
          final render = button.currentContext!.findRenderObject()! as RenderBox;
          final rect = render.localToGlobal(Offset.zero) & render.size;
          final view = View.of(button.currentContext!);
          final point = Offset((action['x'] as num) * view.physicalSize.width / view.devicePixelRatio,
            (action['y'] as num) * view.physicalSize.height / view.devicePixelRatio);
          check(rect.contains(point), 'proposed_tap_outside_fixture');
          check((await call('approve', {'id': id, 'proposal_id': proposal['id'], 'allow': true}))['accepted'] == true, 'approval_rejected');
          approvals++; approved.add(proposal['id']);
        }
        if (['verifying', 'completed', 'cancelled', 'interrupted'].contains(task['phase'])) break;
      }
      result.addAll({'phases': phases, 'approvals': approvals, 'counter': counter, 'native_phase': task['phase'], 'reason': task['reason'], 'summary': task['summary']});
      check(task['phase'] == 'verifying', 'native_loop_did_not_reach_verification');
      check(approvals == 1 && counter == 1, 'counter_not_exactly_one');
      check((await call('verify', {'id': id}))['phase'] == 'completed', 'verification_failed');
      check((await call('run', input))['phase'] == 'completed', 'replay_did_not_return_receipt');
      await Future<void>.delayed(const Duration(seconds: 1));
      check(counter == 1, 'replay_dispatched_twice');
      result['passed'] = true;
      if (mounted) setState(() => status = '验收通过：真实模型 → 原生点击一次 → 用户核验 → 重放无重复');
    } catch (error) {
      result['passed'] = false; result['error'] = error.toString();
      if (mounted) setState(() => status = '验收未通过：$error');
    } finally {
      if (taskId != null) await call('stop', {'id': taskId});
      await File('${root.path}/native-model-acceptance-result.json').writeAsString(jsonEncode(result), flush: true);
      debugPrint('LIVE MODEL RESULT: ${jsonEncode(result)}');
      if (mounted) setState(() => running = false);
    }
  }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Nova 合成页面')),
    body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Text('Counter: $counter', style: const TextStyle(fontSize: 28)),
      FilledButton(key: button, onPressed: () => setState(() => counter++), child: const Text('Toggle fixture')),
      Padding(padding: const EdgeInsets.all(24), child: Text(status)),
      if (!running) TextButton(onPressed: () { setState(() { counter = 0; status = '准备验收'; }); unawaited(run()); }, child: const Text('重新运行合成验收')),
    ])));
}
