import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent/life_tool_bridge.dart';
import 'package:nova_mobile/agent/hub_tasks.dart';
import 'package:nova_mobile/personal/hub_transport.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/protocol/request_id.dart';

// Opt-in physical acceptance. Only explicitly configured synthetic offers are
// consented; production HubTasks, native host and Life writer are unchanged.
void main() => runApp(const MaterialApp(home: HubAcceptance()));

class HubAcceptance extends StatefulWidget {
  const HubAcceptance({super.key});
  @override
  State<HubAcceptance> createState() => _HubAcceptanceState();
}

class _HubAcceptanceState extends State<HubAcceptance> {
  final agent = const NativeLocalAgent();
  final result = <String, dynamic>{
    'fixture': 'ios_real_hub_native',
    'checks': <String>[],
  };
  String status = '准备 Hub 合成验收';
  late File output;
  Future<void> progress(String value) async {
    result['stage'] = value;
    result['updated_at'] = DateTime.now().toUtc().toIso8601String();
    await output.writeAsString(
      const JsonEncoder.withIndent('  ').convert(result),
      flush: true,
    );
    if (mounted) setState(() => status = value);
  }

  void check(bool ok, String code) {
    if (!ok) throw StateError(code);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(run()));
  }

  Future<void> run() async {
    final docs = await getApplicationDocumentsDirectory();
    output = File('${docs.path}/ios-hub-acceptance-result.json');
    LifeToolBridge? bridge;
    HubTasks? hub;
    final owned = <String, String>{};
    try {
      final file = File('${docs.path}/hub-acceptance.json');
      final config =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      await file.delete();
      final transport = HttpLifeSync(config['endpoint'], config['token']);
      final suffix = requestId();
      final life = LocalLife(
        FileLifePersistence(
          File('${docs.path}/hub-acceptance-life-$suffix.json'),
        ),
      );
      await life.open();
      await life.sync(transport);
      check(
        (life.life['todos'] as List).length == 1 &&
            life.life['todos'][0]['note'] == config['expected_note'],
        'hub_todo_sync_mismatch',
      );
      result['synced_todo'] = life.life['todos'][0];
      bridge = LifeToolBridge(life)..attach();
      hub = HubTasks(
        request: transport.request,
        persistence: FileLifePersistence(
          File('${docs.path}/hub-acceptance-delivery-$suffix.json'),
        ),
        agent: agent,
        hubId: life.hubId!,
        accountId: life.accountId!,
      );
      await hub.open();
      await hub.poll();
      (result['checks'] as List).add('real_iphone_hub_todo_sync');
      await progress('ready_for_read_offer');
      final end = DateTime.now().add(const Duration(minutes: 8));
      bool readDone = false, cancelDone = false;
      String? pendingProposal;
      while (DateTime.now().isBefore(end)) {
        await hub.poll();
        for (final offer in await hub.offers()) {
          final c = Map<String, dynamic>.from(offer['command']);
          final type = c['goal'] == config['read_goal']
              ? 'read'
              : c['goal'] == config['cancel_goal']
              ? 'cancel'
              : null;
          check(
            type != null &&
                c['target'] == 'nova' &&
                c['capability'] == 'ios_native',
            'unexpected_offer_scope',
          );
          check(!owned.containsKey(type), 'duplicate_synthetic_offer');
          check(
            c['acceptance'] == config['${type}_acceptance'],
            'unexpected_acceptance',
          );
          owned[type!] = hub.localId(c['task_id']);
          result['${type}_hub_task'] = c['task_id'];
          await hub.accept(c, allow: true);
          await progress('${type}_accepted');
        }
        final tasks = (await agent.call('tasks') as List).cast<Map>();
        for (final entry in owned.entries) {
          final t = tasks.firstWhere((t) => t['id'] == entry.value);
          check(
            t['phase'] != 'interrupted',
            'native_interrupted: ${t['summary']}',
          );
          if (entry.key == 'read' && !readDone && t['phase'] == 'verifying') {
            check(
              (t['summary'] as String).contains(config['expected_note']),
              'model_did_not_read_synced_note',
            );
            check((t['operations'] as List).isEmpty, 'readonly_task_wrote');
            await agent.call('verify', {'id': entry.value});
            await hub.poll();
            readDone = true;
            result['read_native'] = tasks.firstWhere(
              (x) => x['id'] == entry.value,
            );
            (result['checks'] as List).add(
              'mac_offer_native_read_verified_receipt',
            );
            await progress('read_completed_ready_for_cancel_offer');
          }
          if (entry.key == 'cancel' && !cancelDone) {
            if (t['phase'] == 'waiting_approval' && pendingProposal == null) {
              pendingProposal = t['proposal']['id'];
              await progress('cancel_waiting_approval');
            }
            if (t['phase'] == 'cancelled') {
              check(pendingProposal != null, 'cancel_did_not_reach_approval');
              check(
                (t['operations'] as List).isEmpty,
                'cancel_dispatched_write',
              );
              check(
                (await agent.call('approve', {
                      'id': entry.value,
                      'proposal_id': pendingProposal,
                      'allow': true,
                    }))['accepted'] ==
                    false,
                'cancelled_approval_reused',
              );
              check(
                (life.life['todos'] as List).length == 1,
                'cancel_mutated_life',
              );
              cancelDone = true;
              result['cancel_native'] = t;
              await hub.poll();
              (result['checks'] as List).add(
                'mac_cancel_native_terminal_stale_approval_rejected',
              );
            }
          }
        }
        if (readDone && cancelDone) {
          result['passed'] = true;
          await progress('complete_heartbeat_stopped');
          return;
        }
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      throw StateError('hub_acceptance_timeout');
    } catch (e) {
      result['passed'] = false;
      result['error'] = e.toString();
      await progress('failed');
    } finally {
      for (final id in owned.values) {
        try {
          await agent.call('stop', {'id': id});
        } catch (_) {}
      }
      bridge?.detach();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Nova Hub 真机验收')),
    body: Padding(
      padding: const EdgeInsets.all(24),
      child: Text('$status\n\n${result['synced_todo'] ?? ''}'),
    ),
  );
}
