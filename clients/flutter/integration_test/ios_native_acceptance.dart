import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent/life_tool_bridge.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/protocol/request_id.dart';

// Explicit acceptance entrypoint; never imported by production main.dart.
// Only isolated synthetic Life data is exposed to the real native host/model.
void main() => runApp(const MaterialApp(home: NativeAcceptance()));

class NativeAcceptance extends StatefulWidget {
  const NativeAcceptance({super.key});
  @override
  State<NativeAcceptance> createState() => _NativeAcceptanceState();
}

class _NativeAcceptanceState extends State<NativeAcceptance> {
  final agent = const NativeLocalAgent();
  String status = 'iPhone 原生任务验收';
  String? active;
  late File output;
  final result = <String, dynamic>{
    'fixture': 'ios_native_synthetic_life',
    'checks': <String>[],
  };
  void check(bool ok, String message) {
    if (!ok) throw StateError(message);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(run()));
  }

  Future<Map> task(String id) async => (await agent.call('tasks') as List)
      .cast<Map>()
      .firstWhere((t) => t['id'] == id);
  Future<Map> waitFor(String id, Set<String> phases) async {
    final end = DateTime.now().add(const Duration(seconds: 110));
    while (DateTime.now().isBefore(end)) {
      final t = await task(id);
      if (phases.contains(t['phase'])) return t;
      check(
        !['cancelled', 'interrupted'].contains(t['phase']),
        'unexpected_terminal: ${t['summary']}',
      );
      await Future<void>.delayed(const Duration(milliseconds: 300));
    }
    throw StateError('task_timeout');
  }

  Future<void> run() async {
    final docs = await getApplicationDocumentsDirectory();
    output = File('${docs.path}/ios-native-acceptance-result.json');
    LifeToolBridge? bridge;
    try {
      final caps = await agent.call('capabilities') as Map;
      check(
        caps['platform'] == 'ios' && caps['model_runtime'] == true,
        'native_host_missing',
      );
      result['capabilities'] = caps;
      final config = File('${docs.path}/model-acceptance.json');
      if (await config.exists()) {
        try {
          await agent.call(
            'saveModelSettings',
            jsonDecode(await config.readAsString()) as Map<String, dynamic>,
          );
        } finally {
          await config.delete();
        }
      }
      final settings = await agent.call('modelSettings') as Map;
      check(
        settings['configured'] == true &&
            Uri.parse(settings['endpoint']).host == 'dashscope.aliyuncs.com',
        'dashscope_required',
      );
      result['model'] = settings['model'];
      final life = LocalLife(
        FileLifePersistence(
          File('${docs.path}/acceptance-life-${requestId()}.json'),
        ),
      );
      await life.open();
      final marker = 'Evidence-${requestId()}';
      await life.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'iPhone synthetic observation',
        'note': marker,
      });
      bridge = RecordingLifeBridge(life, result)..attach();
      Future<Map<String, dynamic>> start(String goal, String acceptance) async {
        final input = <String, dynamic>{
          'id': requestId(),
          'goal': goal,
          'acceptance': acceptance,
          'target_package': 'nova',
        };
        active = input['id'] as String;
        await agent.call('run', input);
        return input;
      }

      final read = await start(
        'Read the existing synthetic todo and report its exact note. Do not write anything.',
        'The summary contains the observed note verbatim.',
      );
      final observed = await waitFor(active!, {'verifying'});
      check(
        (observed['summary'] as String).contains(marker),
        'unobserved_note',
      );
      check((observed['operations'] as List).isEmpty, 'readonly_wrote');
      await agent.call('verify', {'id': active});
      check(
        (await agent.call('run', read))['phase'] == 'completed',
        'completed_replay',
      );
      (result['checks'] as List).add('real_model_read_verify_replay');
      final title = 'iPhone synthetic create ${requestId()}';
      final create = await start(
        'Create exactly one Nova todo with title "$title". Do not modify existing items.',
        'Exactly one new todo with that title is present.',
      );
      var t = await waitFor(active!, {'waiting_approval'});
      final action = t['proposal']['action'] as Map;
      final input = action['input'] as Map;
      result['create_proposal'] = action;
      check(
        action['tool'] == 'nova' &&
            input['op'] == 'create' &&
            input['kind'] == 'todo' &&
            input['title'] == title &&
            input.keys.every(
              (k) => [
                'op',
                'kind',
                'title',
                'note',
                'importance',
                'due',
              ].contains(k),
            ) &&
            (input['note'] == null || input['note'] == '') &&
            (input['importance'] == null || input['importance'] == 'normal') &&
            input['due'] == null,
        'create_outside_allowlist',
      );
      check(
        (await agent.call('approve', {
              'id': active,
              'proposal_id': t['proposal']['id'],
              'allow': true,
            }))['accepted'] ==
            true,
        'approval_rejected',
      );
      t = await waitFor(active!, {'verifying'});
      check(
        (life.life['todos'] as List).where((x) => x['title'] == title).length ==
            1,
        'write_not_exactly_once',
      );
      check(
        (t['operations'] as List).length == 1 &&
            t['operations'][0]['state'] == 'applied',
        'missing_native_receipt',
      );
      await agent.call('verify', {'id': active});
      check(
        (await agent.call('run', create))['phase'] == 'completed',
        'write_replay',
      );
      check(
        (life.life['todos'] as List).where((x) => x['title'] == title).length ==
            1,
        'replay_duplicated_write',
      );
      (result['checks'] as List).add('real_model_approve_create_verify_replay');
      await start(
        'Create exactly one Nova todo with title "iPhone synthetic create ${requestId()}". Do not modify existing items.',
        'One new synthetic todo exists.',
      );
      t = await waitFor(active!, {'waiting_approval'});
      final proposal = t['proposal']['id'];
      await agent.call('stop', {'id': active});
      check(
        (await agent.call('approve', {
              'id': active,
              'proposal_id': proposal,
              'allow': true,
            }))['accepted'] ==
            false,
        'stale_approval_accepted',
      );
      await Future<void>.delayed(const Duration(seconds: 1));
      check(
        (await task(active!))['phase'] == 'cancelled',
        'cancel_not_terminal',
      );
      check(
        (life.life['todos'] as List).length == 2,
        'cancelled_write_applied',
      );
      (result['checks'] as List).add(
        'cancel_waiting_approval_reject_stale_no_write',
      );
      result['tasks'] = (await agent.call('tasks') as List)
          .where((x) => [read['id'], create['id'], active].contains(x['id']))
          .toList();
      result['passed'] = true;
    } catch (e) {
      result['passed'] = false;
      result['error'] = e.toString();
    } finally {
      if (active != null) {
        try {
          await agent.call('stop', {'id': active});
        } catch (_) {}
      }
      bridge?.detach();
      result['finished_at'] = DateTime.now().toUtc().toIso8601String();
      await output.writeAsString(
        const JsonEncoder.withIndent('  ').convert(result),
        flush: true,
      );
      if (mounted) {
        setState(
          () => status = result['passed'] == true
              ? '原生任务验收通过'
              : '验收暂停：${result['error']}',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Nova 合成数据验收')),
    body: Padding(padding: const EdgeInsets.all(24), child: Text(status)),
  );
}

// Diagnostic wrapper delegates every operation to the production bridge.
class RecordingLifeBridge extends LifeToolBridge {
  RecordingLifeBridge(super.repository, this.result);
  final Map<String, dynamic> result;
  @override
  Future<Map<String, dynamic>> handle(
    String method,
    Map<String, dynamic> args,
  ) async {
    try {
      return await super.handle(method, args);
    } catch (error) {
      result['bridge_failure'] = {
        'method': method,
        'input': args['input'],
        'error': error.toString(),
      };
      rethrow;
    }
  }
}
