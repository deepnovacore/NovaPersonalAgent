import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import '../context/local_publication.dart';
import '../space/space_storage.dart';
import '../connectors/feishu/host.dart';
import 'profile_repository.dart';
import 'secure_persistence.dart';
import 'profile_corrections.dart';
import 'profile_evidence.dart';
import 'profile_writer.dart';
import 'timeline_pipeline.dart';
import 'profile_pipeline_checkpoint.dart';
import 'profile_budget.dart';
import 'profile_observation_checkpoint.dart';
import 'profile_generation_coordinator.dart';

/// Distinguish a planned pause from provider/network and permission failures.
class ProfileRunFailure extends AgentFailure {
  const ProfileRunFailure.deadline() : super('profile_deadline');
  const ProfileRunFailure.cancelled() : super('profile_cancelled');
}

/// Only fixed diagnostic codes may be persisted; provider text is untrusted.
String profileRunErrorCode(Object error) {
  if (error is ProfileGenerationTerminalFailure) {
    return profileRunErrorCode(error.cause);
  }
  final code = error is AgentFailure
      ? error.code
      : error is StateError
      ? error.message
      : null;
  const allowed = {
    'profile_deadline',
    'profile_cancelled',
    'cancelled',
    'model_required',
    'connector_unavailable',
    'source_expired',
    'model_request_failed',
    'model_timeout',
    'model_output_limit',
    'model_response_too_large',
    'model_stream_interrupted',
    'model_stream_required',
    'invalid_model_response',
    'invalid_model_settings',
    'invalid_chatgpt_endpoint',
    'invalid_tool_calls',
    'unsupported_model_output',
    'invalid_profile_json',
    'profile_output_invalid',
    'profile_not_published',
    'profile_no_saved_observations',
    'profile_round_no_observations',
    'profile_no_progress',
    'profile_running',
    'profile_result_more_complete',
    'partial_profile_todo_unsupported',
    'profile_budget_exhausted',
    'profile_budget_model_unsupported',
    'profile_budget_request_unsupported',
    'profile_budget_unavailable',
    'profile_budget_usage_exceeds_reservation',
    'profile_budget_usage_invalid',
    'profile_checkpoint_storage_full',
    'invalid_profile_observations',
    'invalid_profile_observation_text',
    'invalid_profile_observation_refs',
    'observation_refs_not_list',
    'observation_refs_empty',
    'observation_refs_too_many',
    'observation_ref_outside_batch',
    'invalid_profile_review',
    'insufficient_profile_evidence',
    'profile_context_too_large',
    'profile_selection_invalid',
    'profile_timeline_checkpoint_invalid',
    'invalid_profile_pipeline_checkpoint',
    'profile_timeline_invalid',
    'profile_timeline_deferred',
    'profile_result_capacity',
    'corrections_changed',
    'authorization_changed',
    'provider_changed',
    'stale_inputs',
    'processing_not_allowed',
    'processing_consent_required',
    'local_host_required',
    'invalid_projection',
    'ungrounded_projection',
    'invalid_projection_kind',
    'invalid_profile_category',
    'profile_requires_self_evidence',
    'timeline_time_not_grounded',
    'invalid_profile_time',
    'unread_context',
    'missing_timeline',
  };
  if (code is String && allowed.contains(code)) return code;
  if (code is String && RegExp(r'^model_http_[1-5]\d{2}$').hasMatch(code)) {
    return code;
  }
  return 'profile_run_failed';
}

/// Completed provider usage describes an incurred cost even if JSON or permission
/// validation subsequently fails. Missing/incomplete usage supplies no callback.
Future<Map<String, dynamic>> decodeCompletedProfileResponse(
  String content, {
  Future<void> Function()? settleUsage,
  String? collection,
  required Future<void> Function() validate,
}) async {
  await settleUsage?.call();
  await validate();
  // Match desktop transport handling without extracting JSON from prose.
  final trimmed = content.trim();
  final fence = RegExp(
    r'^```(?:json)?\s*\n([\s\S]*?)\n```$',
    caseSensitive: false,
  ).firstMatch(trimmed);
  final value = jsonDecode(fence?.group(1) ?? trimmed);
  if (value is List &&
      (collection == 'topics' || collection == 'review_notes')) {
    return {collection!: value};
  }
  if (value is! Map<String, dynamic>) {
    throw const FormatException('json_object_required');
  }
  return value;
}

/// Phone-owned orchestration; desktop's observation/write/review recipe in Dart.
class ProfileAgent extends ChangeNotifier {
  ProfileAgent(
    this.connector,
    this.publication,
    this.models, {
    this.onProgress,
    this.useTimelinePipeline = true,
    this.maxDuration = const Duration(minutes: 15),
  });
  final _spaceScope = SpaceStorage.scope;
  final Duration maxDuration;
  final bool useTimelinePipeline;
  bool _timedOut = false;
  bool _userCancelled = false;
  Object? _invalidationFailure;
  static const receiptKey = 'nova.profile.task.receipt.v1';
  final VoidCallback? onProgress;
  String status = '';
  bool _disposed = false;
  Map<String, int> lastCoverage = {};
  Map<String, dynamic>? lastPipelineValidation;

  /// Apply the configured model's default, preserving explicit user stops.
  Future<ProfileGenerationSnapshot?> inspectGeneration() =>
      SpaceStorage.runScoped(_spaceScope, _inspectGeneration);

  Future<ProfileGenerationSnapshot?> _inspectGeneration() async {
    if (_disposed ||
        busy ||
        !connector.ready ||
        !publication.canPublish ||
        connector.collection.running) {
      return null;
    }
    if (budget != null) {
      final raw = await SecureContextPersistence(receiptKey).read();
      var receipt = raw == null ? null : jsonDecode(raw);
      if (receipt is Map<String, dynamic>) {
        final resumed = await recoverBudgetPause(
          receipt,
          errorKey: 'error_code',
        );
        if (resumed != null) {
          await SecureContextPersistence(receiptKey).write(jsonEncode(resumed));
          receipt = resumed;
        }
      }
      final failure = receipt is Map ? receipt['error_code'] : null;
      if (failure is String &&
          profileRunErrorCode(
            AgentFailure(failure),
          ).startsWith('profile_budget_')) {
        throw AgentFailure(failure);
      }
    }
    final model = await models.read();
    if (model == null) throw const AgentFailure('model_required');
    final provider = '${model.endpoint}|${model.model}';
    if (connector.sources.sources.isEmpty) return null;
    await connector.sources.enableDefaultProcessing(provider);
    final consent = connector.sources.processingRevision;
    connector.sources.validateProcessing(provider, 'profile', consent);
    await repository.open();
    final evidence = ProfileEvidence(
      connector.sources.readAuthorizedEvidence(provider, 'profile'),
      validThrough: connector.sources.now().add(maxDuration),
    );
    if (evidence.records.isEmpty) return null;
    final scope = _generationScope(
      model,
      evidence,
      corrections.context(repository.correctionScope, provider),
    );
    final value = repository.value;
    final sameScope = value?['generation_scope'] == scope;
    final coverage = sameScope ? (value?['coverage'] as Map?) : null;
    final pendingOutput =
        (coverage?['timeline_pending_batches'] as int? ?? 0) > 0 ||
        (coverage?['profile_pending'] as int? ?? 0) > 0 ||
        (coverage?['timeline_pending'] as int? ?? 0) > 0;
    return ProfileGenerationSnapshot(
      pendingOutput: pendingOutput,
      outputBatches: coverage?['timeline_completed_batches'] as int? ?? 0,
      scope: scope,
      hasResult: value != null && value['generation_scope'] == scope,
      complete:
          value != null &&
          value['generation_scope'] == scope &&
          !pendingOutput &&
          value['partial'] != true &&
          (value['incomplete_batches'] as int? ?? 0) == 0,
      covered: value?['generation_scope'] == scope
          ? value?['coverage']?['validated_observation_records'] as int? ?? 0
          : 0,
      total: evidence.records.length,
    );
  }

  String _generationScope(
    ModelConfiguration model,
    ProfileEvidence evidence,
    String correctionContext,
  ) {
    return ProfileObservationCheckpoint.digest({
      'result_recipe': useTimelinePipeline
          ? 'timeline-batched-v6'
          : 'timeline-brief-v5',
      'provider': '${model.endpoint}|${model.model}',
      'protocol': model.protocol.name,
      'account': connector.sources.identity,
      'auth_generation': connector.auth.generation,
      'source_generation': connector.sources.generation,
      'source_revision': connector.sources.revision,
      'consent_revision': connector.sources.processingRevision,
      'space': publication.spaceId,
      'publisher_device': publication.deviceId,
      'corrections': correctionContext,
      'evidence': evidence.checkpointDigest,
    });
  }

  static const budgetId = String.fromEnvironment('NOVA_PROFILE_BUDGET_ID');
  final budget = budgetId.isEmpty
      ? null
      : ProfileBudget(
          SecureContextPersistence('nova.profile.budget.$budgetId'),
        );
  static const budgetUpgradeId = String.fromEnvironment(
    'NOVA_PROFILE_BUDGET_UPGRADE_ID',
  );
  static const previousBudgetCap = int.fromEnvironment(
    'NOVA_PROFILE_BUDGET_PREVIOUS_LIMIT_MICROYUAN',
  );
  Map<String, dynamic> get _budgetMetadata => budget == null
      ? {}
      : {'budget_id': budgetId, 'budget_limit_microyuan': budget!.capMicroyuan};
  Future<Map<String, dynamic>?> recoverBudgetPause(
    Map<String, dynamic> state, {
    String errorKey = 'terminal_code',
  }) async => budget?.recoverExhaustedPause(
    state,
    budgetId: budgetId,
    upgradeId: budgetUpgradeId,
    previousCapMicroyuan: previousBudgetCap,
    errorKey: errorKey,
  );

  void _report(String value) {
    status =
        '$value${budget == null ? '' : '\n验收预算 ¥${budget!.capMicroyuan / 1000000}；累计预留 ¥${(budget!.reservedMicroyuan / 1000000).toStringAsFixed(3)}（保守上限，非账单）'}';
    if (!_disposed) {
      onProgress?.call();
      notifyListeners();
    }
  }

  final FeishuHost connector;
  final LocalPublicationContext publication;
  final ModelSettings models;
  final corrections = ProfileCorrections();
  late final repository = ProfileRepository(
    SecureContextPersistence('nova.profile.local.v1'),
    publication,
    connector.sources,
    corrections: corrections,
  );
  final _clients = <ModelClient>{};
  bool _cancelled = false;
  static bool _running = false;
  bool get busy => _running;
  Future<void> run({bool savedObservationsOnly = false, int? maxNewBatches}) =>
      SpaceStorage.runScoped(
        _spaceScope,
        () => _runInSpace(
          savedObservationsOnly: savedObservationsOnly,
          maxNewBatches: maxNewBatches,
        ),
      );

  Future<void> _runInSpace({
    required bool savedObservationsOnly,
    int? maxNewBatches,
  }) async {
    if (_disposed) throw StateError('profile_disposed');
    lastCoverage = {};
    if (busy) throw StateError('profile_running');
    _running = true;
    _cancelled = false;
    _timedOut = false;
    _userCancelled = false;
    _invalidationFailure = null;
    var receiptStarted = false;
    final deadlineTimer = Timer(maxDuration, () {
      if (!_userCancelled) {
        _timedOut = true;
        _stopClients();
      }
    });
    _report('正在读取本机资料…');
    try {
      await SecureContextPersistence(receiptKey).write(
        jsonEncode({
          ..._budgetMetadata,
          'status': 'running',
          'started_at': DateTime.now().toUtc().toIso8601String(),
          'coverage': <String, int>{},
        }),
      );
      receiptStarted = true;
      await _run(
        savedObservationsOnly: savedObservationsOnly,
        maxNewBatches: maxNewBatches,
      );
    } catch (error, stack) {
      final failure = _pauseFailure(error);
      final code = profileRunErrorCode(failure);
      final reason = code == 'profile_deadline'
          ? '本轮整理已到时，已暂停'
          : code == 'profile_cancelled'
          ? '已暂停生成'
          : '整理未完成：$code';
      _report('$reason，消息仍保存在手机。已保存的观察可在资料和授权未变化时继续使用。');
      // Preserve coverage written by the writer, including an interrupted run.
      // Failure before writer creation still replaces the previous run's receipt.
      try {
        final raw = receiptStarted
            ? await SecureContextPersistence(receiptKey).read()
            : null;
        final previous = raw == null ? null : jsonDecode(raw);
        await SecureContextPersistence(receiptKey).write(
          jsonEncode({
            if (previous is Map<String, dynamic>) ...previous,
            ..._budgetMetadata,
            'status': {'profile_deadline', 'profile_cancelled'}.contains(code)
                ? 'paused'
                : 'interrupted',
            'error_code': code,
            'finished_at': DateTime.now().toUtc().toIso8601String(),
            if (previous is! Map || previous['coverage'] is! Map)
              'coverage': <String, int>{},
          }),
        );
      } catch (_) {
        /* Diagnostics must not replace the actual failure. */
      }
      Error.throwWithStackTrace(failure, stack);
    } finally {
      deadlineTimer.cancel();
      _running = false;
      if (!_disposed) notifyListeners();
    }
  }

  Object _pauseFailure(Object error) {
    if (error is ProfileGenerationTerminalFailure) {
      return ProfileGenerationTerminalFailure(_pauseFailure(error.cause));
    }
    // Only a cancelled operation can be attributed to a requested pause.
    // Permission failures and unrelated provider/storage errors keep their cause.
    if (error is! AgentFailure || error.code != 'cancelled') return error;
    if (_invalidationFailure != null) return _invalidationFailure!;
    if (_timedOut) return const ProfileRunFailure.deadline();
    if (_userCancelled) return const ProfileRunFailure.cancelled();
    return error;
  }

  Future<void> _run({
    required bool savedObservationsOnly,
    int? maxNewBatches,
  }) async {
    final model = await models.read();
    if (model == null) throw const AgentFailure('model_required');
    if (!connector.ready) throw const AgentFailure('connector_unavailable');
    final provider = '${model.endpoint}|${model.model}';
    await connector.sources.enableDefaultProcessing(provider);
    final generation = connector.auth.generation,
        sourceRevision = connector.sources.revision,
        consentRevision = connector.sources.processingRevision;
    publication.requireCurrent();
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
    void checkRun({bool ignoreCancellation = false}) {
      if (_cancelled && !ignoreCancellation) {
        throw _invalidationFailure ?? const AgentFailure('cancelled');
      }
      if (evidence.expired(connector.sources.now())) {
        throw const AgentFailure('source_expired');
      }
    }

    void validateSourceScope() {
      if (!connector.ready || connector.auth.generation != generation) {
        throw StateError('authorization_changed');
      }
      publication.requireCurrent();
      connector.sources.validateProcessing(
        provider,
        'profile',
        consentRevision,
      );
      if (connector.sources.revision != sourceRevision) {
        throw StateError('stale_inputs');
      }
    }

    Future<void> validate({bool ignoreCancellation = false}) async {
      checkRun(ignoreCancellation: ignoreCancellation);
      await corrections.open();
      final current = await models.read();
      checkRun(ignoreCancellation: ignoreCancellation);
      if (corrections.context(repository.correctionScope, provider) !=
          correctionContext) {
        throw StateError('corrections_changed');
      }
      if (current == null ||
          '${current.endpoint}|${current.model}' != provider ||
          current.protocol != model.protocol) {
        throw StateError('provider_changed');
      }
      validateSourceScope();
    }

    final checkpoint = evidence.expiresAt == null
        ? null
        : ProfileObservationCheckpoint(
            SecureContextPersistence(ProfileObservationCheckpoint.storageKey),
            scope: ProfileObservationCheckpoint.digest({
              'algorithm': ProfileObservationCheckpoint.algorithm,
              'provider': provider,
              'protocol': model.protocol.name,
              'account': connector.sources.identity,
              'auth_generation': generation,
              'source_generation': connector.sources.generation,
              'space': publication.spaceId,
              'device': publication.deviceId,
              'source_revision': sourceRevision,
              'consent_revision': consentRevision,
              'corrections': correctionContext,
              'evidence': evidence.checkpointDigest,
            }),
            expiresAt: evidence.expiresAt!,
            now: connector.sources.now,
            authorize: () => validate(ignoreCancellation: true),
          );

    final generationScope = _generationScope(
      model,
      evidence,
      correctionContext,
    );
    final pipelineCheckpoint = evidence.expiresAt == null
        ? null
        : ProfilePipelineCheckpoint(
            SecureContextPersistence(ProfilePipelineCheckpoint.storageKey),
            scope: generationScope,
            expiresAt: evidence.expiresAt!,
            now: connector.sources.now,
            authorize: () => validate(ignoreCancellation: true),
          );
    const pipelineStages = {
      'timeline_select',
      'timeline_reconcile',
      'timeline_compose',
      'timeline_review',
    };
    String? lastStage;
    Future<Map<String, dynamic>> complete(
      String stage,
      String instructions,
      Map<String, dynamic> input,
    ) async {
      if (const {
        'observations',
        ...pipelineStages,
        'draft',
        'review',
        'edit',
        'repair',
      }.contains(stage)) {
        lastStage = stage;
      }
      if (!useTimelinePipeline &&
          (stage == 'draft' || stage == 'timeline_select') &&
          (savedObservationsOnly || maxNewBatches != null)) {
        final coverage = Map<String, int>.from(input['coverage'] as Map);
        if (coverage['validated_observation_records']! <
            coverage['eligible_records']!) {
          final scope = _generationScope(model, evidence, correctionContext);
          final existing = repository.value;
          // Compare the actual original count again once selection is complete.
          final checkedCoverage = {
            ...coverage,
            if (stage == 'timeline_select' &&
                existing?['generation_scope'] == scope)
              'final_original_records':
                  existing?['coverage']?['final_original_records'] as int? ?? 0,
          };
          repository.validatePartialCoverage(
            checkedCoverage,
            generationScope: scope,
          );
          final oldCovered = existing?['generation_scope'] == scope
              ? existing?['coverage']?['validated_observation_records']
              : null;
          if (maxNewBatches != null &&
              oldCovered is int &&
              coverage['validated_observation_records']! <= oldCovered) {
            throw StateError('profile_no_progress');
          }
        }
      }
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
        final reservation = await budget?.reserve(model, messages);
        await validate();
        checkRun();
        final client = ModelClient(
          timeout: const Duration(minutes: 3),
          collectUsage: budget != null,
        );
        _clients.add(client);
        var content = '';
        try {
          await for (final delta in client.stream(model, messages)) {
            if (delta['_nova_replace'] == true) content = '';
            content += delta['content'] as String? ?? '';
          }
          return await decodeCompletedProfileResponse(
            content,
            collection: stage == 'timeline_select'
                ? 'topics'
                : stage == 'review'
                ? 'review_notes'
                : null,
            validate: validate,
            settleUsage: reservation != null && client.completedUsage != null
                ? () => budget!.settle(reservation, client.completedUsage!)
                : null,
          );
        } on FormatException {
          if (pipelineStages.contains(stage)) {
            throw AgentFailure(
              stage == 'timeline_select' || stage == 'timeline_reconcile'
                  ? 'profile_selection_invalid'
                  : 'profile_timeline_invalid',
            );
          }
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
        validateSourceScope();
      } catch (error) {
        // Preserve the first invalidation even if stopping the HTTP client
        // subsequently reports only cancellation or cleanup crosses a deadline.
        _invalidationFailure ??= error;
        _stopClients();
      }
    }

    final conversationDisk = SecureContextPersistence(
          'nova.profile.task.context.v1',
        ),
        journalDisk = SecureContextPersistence('nova.profile.task.tools.v1'),
        receipt = SecureContextPersistence(receiptKey);
    // Remove legacy transcripts; intermediate text now stays only in memory.
    await conversationDisk.write('{"schema_version":1,"conversations":[]}');
    await journalDisk.write('{"schema_version":1,"records":{}}');
    connector.addListener(changed);
    publication.addListener(changed);
    var outcome = 'interrupted';
    String? failureCode;
    late final ProfileWriter writer;
    Future<void> publishProgress(
      String entries,
      Map<String, int> coverage, {
      required bool partial,
    }) async {
      await validate();
      final existing = repository.value;
      // A replay walks completed batches before reaching the interruption point.
      // Keep the stronger durable publication until this run catches up.
      if (partial && existing?['generation_scope'] == generationScope) {
        final old = existing?['coverage'] as Map?;
        if (existing?['partial'] != true ||
            (old?['validated_observation_records'] as int? ?? 0) >
                (coverage['validated_observation_records'] ?? 0) ||
            (old?['final_original_records'] as int? ?? 0) >
                (coverage['final_original_records'] ?? 0)) {
          return;
        }
      }
      await repository.publish(
        evidence.restoreCitations(entries),
        sourceRevision: sourceRevision,
        consentRevision: consentRevision,
        provider: provider,
        incompleteBatches: writer.incompleteBatches,
        partial: partial,
        coverage: coverage,
        generationScope: generationScope,
        mergeTimelineHistory: true,
      );
      await validate();
      _report('已保存核对完成的内容，正在继续整理…');
    }

    late final TimelinePipeline? pipeline;
    pipeline = useTimelinePipeline
        ? TimelinePipeline(
            complete: complete,
            authorize: validate,
            cacheScope: generationScope,
            loadCheckpoint: pipelineCheckpoint?.load,
            saveCheckpoint: pipelineCheckpoint?.save,
            onPublish: (result) async {
              writer.updatePipelineCoverage(result.coverage);
              writer.updateTimelineEvidence(pipeline!.readEvidenceIds);
              await publishProgress(
                writer.withVerifiedProfile(result.entries),
                writer.coverage,
                partial: true,
              );
            },
          )
        : null;
    writer = ProfileWriter(
      timelinePipeline: pipeline,
      loadProfileOutput: pipelineCheckpoint == null
          ? null
          : (key) async {
              await validate();
              final cached = await pipelineCheckpoint.load(key);
              await validate();
              if (cached == null) return null;
              if (cached['entries'] is! String) {
                throw StateError('profile_timeline_checkpoint_invalid');
              }
              return cached['entries'] as String;
            },
      saveProfileOutput: pipelineCheckpoint == null
          ? null
          : (key, entries) async {
              await validate();
              await pipelineCheckpoint.save(key, {'entries': entries});
              await validate();
            },
      onProfilePublish: (entries, coverage) =>
          publishProgress(entries, coverage, partial: writer.isPartial),
      complete: complete,
      onProgress: _report,
      loadValidatedBatch: checkpoint == null
          ? null
          : (messages) async {
              await validate();
              final value = await checkpoint.load(messages);
              await validate();
              return value;
            },
      saveValidatedBatch: checkpoint == null
          ? null
          : (messages, facts) async {
              await validate();
              await checkpoint.save(messages, facts);
              await validate();
            },
    );
    final cachedCounts = connector.sources.statusCounts;
    final skippedSources = connector.sources.skippedSummary;
    final excludedEvidence = {
      'near_expiry': evidence.expiringCount,
      'copied_participant_text': evidence.copiedCount,
      'empty_or_redacted': evidence.emptyOrRedactedCount,
    };
    try {
      await receipt.write(
        jsonEncode({
          ..._budgetMetadata,
          'status': 'running',
          'space_scope': publication.spaceId,
          'source_revision': sourceRevision,
          'consent_revision': consentRevision,
        }),
      );
      _report(
        '正在分批归纳飞书文本…${evidence.expiringCount == 0 ? '' : '已跳过 ${evidence.expiringCount} 条将在处理期间到期的消息。'}',
      );
      final entries = await writer.generate(
        evidence.records,
        corrections: correctionContext,
        savedObservationsOnly: savedObservationsOnly,
        maxNewBatches: maxNewBatches,
      );
      await validate();
      checkRun();
      await repository.publish(
        evidence.restoreCitations(entries),
        sourceRevision: sourceRevision,
        consentRevision: consentRevision,
        provider: provider,
        incompleteBatches: writer.incompleteBatches,
        partial: writer.isPartial,
        coverage: writer.coverage,
        generationScope: generationScope,
        mergeTimelineHistory: useTimelinePipeline,
      );
      await validate();
      if (repository.value == null) {
        throw const AgentFailure('profile_not_published');
      }
      outcome = writer.isPartial ? 'partial' : 'completed';
      if (!useTimelinePipeline &&
          !writer.isPartial &&
          writer.incompleteBatches == 0) {
        await checkpoint?.clear();
      }
      // Keep validated observations/stages for an interrupted or explicit rerun.
      // Scope/expiry/revocation invalidation owns their lifetime.
      if (writer.profileFailureCode != null) {
        throw const AgentFailure('profile_output_invalid');
      }
      if ((writer.coverage['timeline_deferred_batches'] ?? 0) > 0) {
        throw StateError('profile_timeline_deferred');
      }
      _report(
        '${writer.isPartial ? '已生成部分结果，未整理的消息可继续补充；' : ''}整理完成：缓存中 ${cachedCounts['available'] ?? 0} 条可用文本，${writer.observedRecordCount + writer.reusedObservationRecordCount} 条合格文本完成分批观察（本轮 ${writer.observedRecordCount} 条、复用 ${writer.reusedObservationRecordCount} 条）；最终撰写与审查使用 ${writer.selectedOriginalCount} 条完整原文和 ${writer.selectedObservationCount} 条观察。'
        '未进入最终上下文：${writer.sourceRecordCount - writer.selectedOriginalCount} 条原文、${writer.observationCount - writer.selectedObservationCount} 条观察（按相关性与容量筛选）。'
        '${skippedSources.isEmpty ? '' : '未送入模型：$skippedSources。'}'
        '${excludedEvidence.values.every((n) => n == 0) ? '' : '观察前排除：${evidence.expiringCount} 条即将到期、${evidence.copiedCount} 条重复转贴他人正文、${evidence.emptyOrRedactedCount} 条空白或脱敏后无内容。'}'
        '${writer.incompleteBatches == 0 ? '' : '${writer.incompleteBatches} 批观察未全部通过核对，仅使用已通过部分，结果不完整。'}',
      );
    } catch (error, stack) {
      var failure = error;
      // Cancel/time limits keep valid completed work; permission or source
      // changes erase it even when publication failed before a cache operation.
      try {
        await validate(ignoreCancellation: true);
      } catch (validationError) {
        await checkpoint?.clear();
        await pipelineCheckpoint?.clear();
        if (const {
          'source_expired',
          'corrections_changed',
          'authorization_changed',
          'provider_changed',
          'stale_inputs',
          'processing_consent_required',
          'local_host_required',
        }.contains(profileRunErrorCode(validationError))) {
          failure = validationError;
        }
      }
      failure = _pauseFailure(failure);
      failureCode = profileRunErrorCode(failure);
      if (writer.profileFailureCode != null) {
        failure = ProfileGenerationTerminalFailure(failure);
      }
      Error.throwWithStackTrace(failure, stack);
    } finally {
      lastCoverage = writer.coverage;
      lastPipelineValidation = pipeline?.validationDiagnostics;
      connector.removeListener(changed);
      publication.removeListener(changed);
      _stopClients();
      await receipt.write(
        jsonEncode({
          ..._budgetMetadata,
          'status': outcome,
          'error_code': ?failureCode,
          'model': ['qwen-flash', 'qwen3-vl-plus'].contains(model.model)
              ? model.model
              : 'other',
          'space_scope': publication.spaceId,
          'source_revision': sourceRevision,
          'consent_revision': consentRevision,
          'finished_at': DateTime.now().toUtc().toIso8601String(),
          'coverage': writer.coverage,
          'last_stage': ?lastStage,
          'profile_validation_error': ?writer.profileFailureCode,
          'pipeline_validation': ?lastPipelineValidation,
          'cached_message_statuses': cachedCounts,
          'excluded_before_observations': excludedEvidence,
        }),
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    cancel();
    super.dispose();
  }

  void cancel() {
    if (!_timedOut) _userCancelled = true;
    _stopClients();
  }

  void _stopClients() {
    _cancelled = true;
    for (final client in _clients) {
      client.cancel();
    }
  }
}
