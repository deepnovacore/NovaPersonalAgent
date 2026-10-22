// Opt-in physical acceptance: build only with an isolated bundle identifier.
// Source messages and Feishu credentials are synthetic; only the configured
// model endpoint receives them. Never import this entrypoint from main.dart.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/profile_pipeline_checkpoint.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/personal/local_life.dart';

class _Memory implements LifePersistence {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String data) async {
    value = data;
  }
}

class _Models extends ModelSettings {
  _Models(this.model);
  final ModelConfiguration model;
  @override
  Future<ModelConfiguration?> read() async => model;
}

void main() => runApp(const MaterialApp(home: _Acceptance()));

class _Acceptance extends StatefulWidget {
  const _Acceptance();
  @override
  State<_Acceptance> createState() => _State();
}

class _State extends State<_Acceptance> {
  String status = 'Preparing synthetic profile acceptance';
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(run()));
  }

  void require(bool value, String code) {
    if (!value) throw StateError(code);
  }

  Future<void> run() async {
    final docs = await getApplicationDocumentsDirectory();
    final output = File('${docs.path}/ios-profile-acceptance-result.json');
    final result = <String, dynamic>{
      'suite': 'ios_synthetic_profile_timeline_real_model',
      'pass_scope': 'pipeline_structure_and_references',
      'semantic_review': 'required',
      'started_at': DateTime.now().toUtc().toIso8601String(),
      'passed': false,
    };
    ProfileAgent? agent;
    FeishuHost? host;
    Future<void> save() => output.writeAsString(
      const JsonEncoder.withIndent('  ').convert(result),
      flush: true,
    );
    try {
      require(Platform.isIOS, 'physical_ios_required');
      // Preserve the previous synthetic run before host.open clears its task
      // context. Without a new config this entrypoint only exports diagnostics.
      final prior = <String, dynamic>{};
      for (final key in [
        ProfileAgent.receiptKey,
        'nova.profile.task.context.v1',
        ProfilePipelineCheckpoint.storageKey,
        'nova.profile.local.v1',
      ]) {
        final raw = await SecureContextPersistence(key).read();
        if (raw != null) prior[key] = jsonDecode(raw);
      }
      await File(
        '${docs.path}/ios-profile-acceptance-diagnostics.json',
      ).writeAsString(jsonEncode(prior), flush: true);
      final config = File('${docs.path}/model-acceptance.json');
      if (!await config.exists()) {
        result['stage'] = 'diagnostics_only';
        return;
      }
      final value = jsonDecode(await config.readAsString()) as Map;
      await config.delete();
      final model = ModelConfiguration(
        endpoint: value['endpoint'] as String,
        model: value['model'] as String,
        key: value['key'] as String,
      );
      require(
        Uri.parse(model.endpoint).host == 'dashscope.aliyuncs.com',
        'unexpected_model_endpoint',
      );
      result['model'] = model.model;
      final now = DateTime.now().toUtc();
      final auth = FeishuAuth(
        _Memory()
          ..value = jsonEncode({
            'version': 1,
            'generation': 1,
            'app': {
              'brand': 'feishu',
              'app_id': 'fixture',
              'secret': 'synthetic',
            },
            'identity': {'open_id': 'self'},
            'credential': {
              'access_token': 'synthetic',
              'expires_at': now
                  .add(const Duration(days: 1))
                  .millisecondsSinceEpoch,
            },
          }),
        FeishuApi(),
        now: () => now,
      );
      await auth.open();
      final sources = SourceStore(_Memory(), now: () => now);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.select(
        'synthetic-chat',
        now.subtract(const Duration(days: 1)),
      );
      const texts = [
        '我是一名前端开发工程师，平时主要使用 TypeScript 和 Flutter。',
        '我更喜欢简洁的中文回复，讨论方案时请先讲结论再讲原因。',
        '今天我完成了萤火计数器网页的加一按钮开发，点击一次会让数字增加一。',
        '今天我修复了萤火计数器的重置按钮，点击后会显示零，并已测试通过。',
        '萤火计数器这轮开发已经完成，明天计划整理一份使用说明。',
      ];
      await sources.ingestPage(
        sources.fence('synthetic-chat'),
        [
          for (var i = 0; i < texts.length; i++)
            {
              'message_id': 'synthetic-$i',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time':
                  '${now.subtract(Duration(minutes: texts.length - i)).millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {
                'content': jsonEncode({'text': texts[i]}),
              },
            },
        ],
        nextPage: null,
        windowEnd: now,
      );
      host = FeishuHost(auth: auth, sources: sources);
      await host.open();
      final authority = SpaceAuthorityRepository(_Memory());
      await authority.open();
      agent = ProfileAgent(
        host,
        authority,
        _Models(model),
        maxDuration: const Duration(minutes: 5),
      );
      agent.addListener(() {
        if (mounted) setState(() => status = agent!.status);
      });
      // No explicit grant: exercise the product's current-model default.
      final snapshot = await agent.inspectGeneration();
      require(snapshot?.total == texts.length, 'default_access_missing');
      result['default_access'] = true;
      result['stage'] = 'generating';
      await save();
      await agent.run(maxNewBatches: 1);
      final projection = agent.repository.value;
      require(projection != null, 'no_projection');
      final entries = (projection!['entries'] as List).cast<Map>();
      require(entries.any((e) => e['kind'] == 'profile'), 'missing_profile');
      require(entries.any((e) => e['kind'] == 'timeline'), 'missing_timeline');
      final ids = sources
          .messages('synthetic-chat')
          .map((m) => m['evidence_id'])
          .toSet();
      require(
        entries.every(
          (e) =>
              (e['evidence_ids'] as List).isNotEmpty &&
              (e['evidence_ids'] as List).every(ids.contains),
        ),
        'ungrounded_result',
      );
      result['projection'] = projection;
      result['coverage'] = agent.lastCoverage;
      result['passed'] = true;
      result['stage'] = 'complete';
    } catch (error) {
      result['error_code'] = profileRunErrorCode(error);
      if (error is StateError &&
          const {
            'default_access_missing',
            'no_projection',
            'missing_profile',
            'missing_timeline',
            'ungrounded_result',
            'unexpected_model_endpoint',
          }.contains(error.message)) {
        result['assertion'] = error.message;
      }
      result['coverage'] = agent?.lastCoverage;
      result['validation'] = agent?.lastPipelineValidation;
      result['projection'] = agent?.repository.value;
      result['stage'] = 'failed';
    } finally {
      agent?.dispose();
      host?.dispose();
      result['finished_at'] = DateTime.now().toUtc().toIso8601String();
      await save();
      if (mounted) {
        setState(
          () => status = result['passed'] == true
              ? 'CONTRACT PASS — semantic review required'
              : 'FAIL: ${result['error_code']}',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Padding(padding: const EdgeInsets.all(24), child: Text(status)),
    ),
  );
}
