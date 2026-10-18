import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import '../device/space_authority.dart';
import '../connectors/feishu/host.dart';
import 'profile_repository.dart';
import 'secure_persistence.dart';
import 'profile_corrections.dart';
import 'profile_evidence.dart';
import 'profile_writer.dart';
import 'profile_budget.dart';

/// Phone-owned orchestration; desktop's observation/write/review recipe in Dart.
class ProfileAgent {
  ProfileAgent(
    this.connector,
    this.authority,
    this.models, {
    this.onProgress,
    this.maxDuration = const Duration(minutes: 15),
  });
  final Duration maxDuration;
  bool _timedOut = false;
  final VoidCallback? onProgress;
  String status = '';
  static const budgetId = String.fromEnvironment('NOVA_PROFILE_BUDGET_ID');
  final budget = budgetId.isEmpty
      ? null
      : ProfileBudget(
          const SecureContextPersistence('nova.profile.budget.$budgetId'),
        );
  void _report(String value) {
    status =
        '$value${budget == null ? '' : '\n验收预算 ¥5；累计预留 ¥${(budget!.reservedMicroyuan / 1000000).toStringAsFixed(3)}（保守上限，非账单）'}';
    onProgress?.call();
  }

  final FeishuHost connector;
  final SpaceAuthorityRepository authority;
  final ModelSettings models;
  final corrections = ProfileCorrections();
  late final repository = ProfileRepository(
    const SecureContextPersistence('nova.profile.local.v1'),
    authority,
    connector.sources,
    corrections: corrections,
  );
  final _clients = <ModelClient>{};
  bool _cancelled = false;
  static bool _running = false;
  bool get busy => _running;
  Future<void> run() async {
    if (busy) throw StateError('profile_running');
    _running = true;
    _cancelled = false;
    _timedOut = false;
    final deadlineTimer = Timer(maxDuration, () {
      _timedOut = true;
      cancel();
    });
    _report('正在读取本机资料…');
    try {
      await _run();
    } catch (error) {
      final reason = _timedOut
          ? '已达到本轮处理时长上限'
          : error is ProfileValidationFailure
          ? '${error.message}（${error.detail['path']}）'
          : error is ProfileObservationFailure
          ? '${error.message}（${error.detail}）'
          : error is AgentFailure
          ? error.code
          : profileRepairReason(error) ??
                switch (error) {
                  StateError(message: final message)
                      when const {
                        'invalid_profile_observations',
                        'invalid_profile_observation_text',
                        'invalid_profile_observation_refs',
                        'invalid_profile_review',
                        'insufficient_profile_evidence',
                        'corrections_changed',
                        'authorization_changed',
                        'provider_changed',
                        'authority_changed',
                        'stale_inputs',
                        'processing_not_allowed',
                      }.contains(message) =>
                    message,
                  _ => null,
                };
      _report('整理未完成${reason == null ? '' : '：$reason'}，消息仍保存在手机。');
      rethrow;
    } finally {
      deadlineTimer.cancel();
      _running = false;
    }
  }

  Future<void> _run() async {
    final model = await models.read();
    if (model == null) throw const AgentFailure('model_required');
    if (!connector.ready) throw const AgentFailure('connector_unavailable');
    final provider = '${model.endpoint}|${model.model}',
        epoch = authority.epoch,
        generation = connector.auth.generation,
        authorityGeneration = authority.publicationGeneration,
        sourceRevision = connector.sources.revision,
        consentRevision = connector.sources.processingRevision;
    authority.validatePublish(epoch);
    connector.sources.validateProcessing(provider, 'profile', consentRevision);
    await repository.open();
    final correctionContext = corrections.context(
      repository.correctionScope,
      provider,
    );
    final evidence = ProfileEvidence(
      connector.sources.readAuthorizedEvidence(provider, 'profile'),
      validThrough: connector.sources.now().add(maxDuration),
    );
    void checkRun() {
      if (_cancelled) throw const AgentFailure('cancelled');
      if (evidence.expired(connector.sources.now())) {
        throw const AgentFailure('source_expired');
      }
    }

    Future<void> validate() async {
      checkRun();
      await corrections.open();
      final current = await models.read();
      checkRun();
      if (corrections.context(repository.correctionScope, provider) !=
          correctionContext) {
        throw StateError('corrections_changed');
      }
      if (!connector.ready || connector.auth.generation != generation) {
        throw StateError('authorization_changed');
      }
      if (current == null ||
          '${current.endpoint}|${current.model}' != provider) {
        throw StateError('provider_changed');
      }
      authority.validatePublish(epoch);
      connector.sources.validateProcessing(
        provider,
        'profile',
        consentRevision,
      );
      if (authority.publicationGeneration != authorityGeneration) {
        throw StateError('authority_changed');
      }
      if (connector.sources.revision != sourceRevision) {
        throw StateError('stale_inputs');
      }
    }

    Future<Map<String, dynamic>> complete(
      String stage,
      String instructions,
      Map<String, dynamic> input,
    ) async {
      for (var attempt = 0; attempt < 2; attempt++) {
        await validate();
        checkRun();
        final messages = <Map<String, dynamic>>[
          {
            'role': 'system',
            'content':
                instructions +
                (attempt == 0
                    ? ''
                    : ' 上次JSON格式错误，只返回一个JSON对象，不使用Markdown围栏或解释。'),
          },
          {'role': 'user', 'content': jsonEncode(input)},
        ];
        await budget?.reserve(model, messages);
        await validate();
        checkRun();
        final client = ModelClient(timeout: const Duration(minutes: 3));
        _clients.add(client);
        var content = '';
        try {
          await for (final delta in client.stream(model, messages)) {
            if (delta['_nova_replace'] == true) content = '';
            content += delta['content'] as String? ?? '';
          }
          await validate();
          final value = jsonDecode(content);
          if (value is! Map<String, dynamic>) {
            throw const FormatException('json_object_required');
          }
          return value;
        } on FormatException {
          if (attempt == 1) throw const AgentFailure('invalid_profile_json');
        } finally {
          client.cancel();
          _clients.remove(client);
        }
      }
      throw const AgentFailure('invalid_profile_json');
    }

    void changed() {
      try {
        authority.validatePublish(epoch);
        connector.sources.validateProcessing(
          provider,
          'profile',
          consentRevision,
        );
        if (!connector.ready ||
            connector.sources.revision != sourceRevision ||
            connector.auth.generation != generation ||
            authority.publicationGeneration != authorityGeneration) {
          cancel();
        }
      } catch (_) {
        cancel();
      }
    }

    const conversationDisk = SecureContextPersistence(
          'nova.profile.task.context.v1',
        ),
        journalDisk = SecureContextPersistence('nova.profile.task.tools.v1'),
        receipt = SecureContextPersistence('nova.profile.task.receipt.v1');
    // Remove legacy transcripts; intermediate text now stays only in memory.
    await conversationDisk.write('{"schema_version":1,"conversations":[]}');
    await journalDisk.write('{"schema_version":1,"records":{}}');
    connector.addListener(changed);
    authority.addListener(changed);
    var outcome = 'interrupted';
    try {
      await receipt.write(
        jsonEncode({
          'status': 'running',
          'authority_epoch': epoch,
          'source_revision': sourceRevision,
          'consent_revision': consentRevision,
        }),
      );
      final writer = ProfileWriter(complete: complete, onProgress: _report);
      _report(
        '正在分批归纳飞书文本…${evidence.expiringCount == 0 ? '' : '已跳过 ${evidence.expiringCount} 条将在处理期间到期的消息。'}',
      );
      final entries = await writer.generate(
        evidence.records,
        corrections: correctionContext,
      );
      await validate();
      checkRun();
      await repository.publish(
        evidence.restoreCitations(entries),
        epoch: epoch,
        sourceRevision: sourceRevision,
        consentRevision: consentRevision,
        provider: provider,
        incompleteBatches: writer.incompleteBatches,
      );
      await validate();
      if (repository.value == null) {
        throw const AgentFailure('profile_not_published');
      }
      outcome = 'completed';
      _report(
        '整理完成，读取 ${evidence.records.length} 条可用文本，已完成模型审查。${writer.incompleteBatches == 0 ? '' : '其中 ${writer.incompleteBatches} 批有观察未通过核对，已排除，结果不完整。'}',
      );
    } finally {
      connector.removeListener(changed);
      authority.removeListener(changed);
      cancel();
      await receipt.write(
        jsonEncode({
          'status': outcome,
          'authority_epoch': epoch,
          'source_revision': sourceRevision,
          'consent_revision': consentRevision,
          'finished_at': DateTime.now().toUtc().toIso8601String(),
        }),
      );
    }
  }

  void cancel() {
    _cancelled = true;
    for (final client in _clients) {
      client.cancel();
    }
  }
}
