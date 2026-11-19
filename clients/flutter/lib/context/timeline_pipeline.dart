import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'profile_repository.dart';
import 'profile_text.dart';
import 'profile_writer.dart';
import 'timeline_brief.dart';

class TimelinePipelineTopic {
  TimelinePipelineTopic(this.title, this.indices, this.refs);
  final String title;
  final List<int> indices;
  final List<String> refs;
}

class TimelineWritingPlan {
  TimelineWritingPlan(this.batches, this.deferred);
  final List<List<TimelinePipelineTopic>> batches;
  final List<TimelinePipelineTopic> deferred;
}

class TimelinePipelineResult {
  TimelinePipelineResult({
    required this.entries,
    required this.coverage,
    required this.deferredTopics,
    required this.completedBatches,
    required this.totalBatches,
  });
  final String entries;
  final Map<String, int> coverage;
  final int deferredTopics, completedBatches, totalBatches;
  int get pendingBatches => totalBatches - completedBatches;
  bool get partial => pendingBatches > 0;
}

/// Fixed codes and trusted schema paths; never contains source/model prose.
class TimelinePipelineValidationFailure extends StateError {
  TimelinePipelineValidationFailure(super.message, this.detail);
  final Map<String, dynamic> detail;
}

List<List<Map<String, dynamic>>> timelineSelectionBatches(
  List<Map<String, dynamic>> index, {
  int maxObservations = 80,
  int maxCharacters = 16000,
  int maxBytes = 48000,
}) {
  final batches = <List<Map<String, dynamic>>>[];
  var batch = <Map<String, dynamic>>[];
  bool fits(List<Map<String, dynamic>> rows) {
    final encoded = jsonEncode(rows);
    return rows.length <= maxObservations &&
        encoded.length <= maxCharacters &&
        utf8.encode(encoded).length <= maxBytes;
  }

  for (final row in index) {
    if (!fits([row])) {
      final encoded = jsonEncode([row]);
      throw ProfileContextFailure(
        'timeline_select',
        encoded.length,
        utf8.encode(encoded).length,
      );
    }
    if (batch.isNotEmpty && !fits([...batch, row])) {
      batches.add(batch);
      batch = [];
    }
    batch.add(row);
  }
  if (batch.isNotEmpty) batches.add(batch);
  return batches;
}

TimelineWritingPlan timelineWritingPlan(
  List<TimelinePipelineTopic> topics,
  List<Map<String, dynamic>> records, {
  int maxRecords = 120,
  int maxCharacters = 48000,
}) {
  final originals = {
    for (final record in records) record['evidence_id']: record,
  };
  final batches = <List<TimelinePipelineTopic>>[];
  final deferred = <TimelinePipelineTopic>[];
  var batch = <TimelinePipelineTopic>[];
  bool fits(List<TimelinePipelineTopic> group) {
    final ids = group.expand((topic) => topic.refs).toSet();
    if (!ids.every(originals.containsKey)) {
      throw StateError('ungrounded_projection');
    }
    return ids.length <= maxRecords &&
        jsonEncode([for (final id in ids) originals[id]]).length <=
            maxCharacters;
  }

  for (final topic in topics) {
    if (!fits([topic])) {
      deferred.add(topic);
      continue;
    }
    if (batch.isNotEmpty && (batch.length >= 4 || !fits([...batch, topic]))) {
      batches.add(batch);
      batch = [];
    }
    batch.add(topic);
  }
  if (batch.isNotEmpty) batches.add(batch);
  return TimelineWritingPlan(batches, deferred);
}

const _selectInstructions = '''$timelinePerspectiveRules
title必须是非空字符串，长度≤160字符，只返回本次规定的JSON对象。
逐条阅读本批完整原文records，选出有实际个人价值的独立事项，不设目标数量。只返回 {"topics":[{"title":"具体对象的独立交付与变化","observation_indices":[0]}]}。title只作检索索引，不是发布事实；写具体事项，不能用“项目概况”“全部进展”把不同事项塞成一组。同一对象同一交付的计划、完成、取消、恢复归在一起，不同交付分开。编号只能是allowed_indices中的原文key，不是本批行号或字典下标。observation_indices沿用成员字段名，但编号指records的key，不指画像观察；正文回取所选完整原文。共享背景观察可跨主题引用，但不能因此合并独立事项。没有相关事项可返回空topics。单主题原文过大时按真实独立事项重新分题；若确实不可分割则保留完整主题，宿主标记待处理，不能机械拆编号伪造独立事项或抛掉完成/取消观察。''';
const _reconcileInstructions = '''$timelinePerspectiveRules
这是跨批次主题索引归并。只返回JSON对象 {"groups":[{"members":["t0","t1"]}]}。仅列出有把握应合并的主题组；未列出的主题由宿主保留为独立项，不会删除。没有确定的合并关系时返回空groups，不需要逐个枚举独立主题；也允许单成员组。每个列出的id必须来自输入且最多出现一次，不能新增id。同一主体、同一对象、同一交付的早期计划与后续完成、取消、恢复归为一组；不同事项独立。共同项目名、会话、背景消息或同一个人不足以证明同一事项。拿不准则独立保留。title及观察文字只是检索线索，不是最终证据；正文回取所有所选完整原文。不要把全部主题压成项目概况。容量不足时按真正独立事项分组，不能为了容量拆散确属同一事项的状态更新。''';
const timelinePriorRules =
    'context.prior_cards 只是已发布卡片的索引，不是事实来源；事实、日期、人物与状态仍须引用所给原文。修订已有卡片时必须填写其 prior_id，草稿中的 prior_id 原样保留。';

const timelineDeltaRules =
    '本次是增量整理。context.prior_cards 是已发布的简报摘要，context.new_input_ids 是自上次整理后新增或变化的输入。只就 new_input_ids 涉及的事项及因此需要更新的旧卡写卡：修订某张 prior_card 时必须在 prior_id 填写该卡 id，并让 facts/refs 引用能支持新状态的原文；未变化的事项不必重复输出。prior_cards 只是索引，不是事实来源，不得据摘要补写原文没有的事实、日期、人物或状态；prior_id 只能使用 context.prior_cards 中出现的 id；草稿中已有卡片的 prior_id 必须原样保留。';

const _composeInstructions =
    '''$timelinePerspectiveRules
$timelineEntryInstructions
本请求仅生成Timeline，返回 {"timeline":[...]}，不生成profile或todos。逐项识别独立事项；单个timeline_topics也可包含多个独立事项，应分别成卡，不能据其中性标题写总览。按输入的多个独立timeline_topics逐项核对，不能因为同项目而压成一张总览，不凑卡。history_complete=false表示未读到全部历史，不得推断当前仍未完成。每张卡的全部引用必须来自单一timeline_topics主题。只用messages完整原文作事实证据，title是检索线索。''';

/// Pure orchestration. Host owns authorization, encrypted storage and publication.
class TimelinePipeline {
  TimelinePipeline({
    required this.complete,
    required this.authorize,
    required this.cacheScope,
    this.loadCheckpoint,
    this.saveCheckpoint,
    this.onPublish,
    this.evidenceIdentities = const {},
    this.maxWritingRecords = 120,
    this.maxWritingCharacters = 48000,
  }) {
    if (cacheScope.isEmpty) throw ArgumentError.value(cacheScope, 'cacheScope');
    if (maxWritingRecords < 1 ||
        maxWritingRecords > 120 ||
        maxWritingCharacters < 1 ||
        maxWritingCharacters > 48000) {
      throw ArgumentError('invalid_timeline_writing_capacity');
    }
  }
  static const recipe = 'timeline-pipeline-v3';
  static const _hostFallbackReasons = {
    'groups_schema',
    'members_schema',
    'member_unknown_or_repeated',
  };
  final ProfileCompletion complete;
  final Future<void> Function() authorize;
  final String cacheScope;
  final Map<String, String> evidenceIdentities;
  final int maxWritingRecords, maxWritingCharacters;
  final Future<Map<String, dynamic>?> Function(String)? loadCheckpoint;
  final Future<void> Function(String, Map<String, dynamic>)? saveCheckpoint;
  final Future<void> Function(TimelinePipelineResult)? onPublish;
  final _metrics = <String, int>{};
  Map<String, dynamic>? _firstValidationFailure, _lastValidationFailure;
  String? _activeStage;

  /// Host-defined reason/path/index only; no model output or source content.
  Map<String, dynamic>? get validationDiagnostics =>
      _firstValidationFailure == null
      ? null
      : {
          'first': Map.of(_firstValidationFailure!),
          'last': Map.of(_lastValidationFailure!),
        };
  Map<String, dynamic> _context = {};
  final _readEvidenceIds = <String>{};
  final _inputEvidenceIds = <String>{};
  final _completedEvidenceIds = <String>{};
  final _pendingEvidenceIds = <String>{};
  final _droppedCards = <String>{};
  Set<String> get completedEvidenceIds =>
      Set.unmodifiable(_completedEvidenceIds.difference(_pendingEvidenceIds));
  Set<String> get inputEvidenceIds => Set.unmodifiable(_inputEvidenceIds);
  Set<String> _priorIds = {};
  final _priorKeysByEvidence = <String, String?>{};
  Set<String> get readEvidenceIds => Set.unmodifiable(_readEvidenceIds);
  Map<String, int> get coverage => Map.unmodifiable(_metrics);

  static String _digest(Object value) =>
      sha256.convert(utf8.encode(jsonEncode(value))).toString();
  // Called only after all topic structures and integer membership were checked.
  List<String> _topicMembership(Map<String, dynamic> response) =>
      (response['topics'] as List).map((row) {
        final indices =
            (row['observation_indices'] as List).cast<int>().toSet().toList()
              ..sort();
        return jsonEncode(indices);
      }).toList()..sort();

  // Routing labels are untrusted index metadata, never source evidence. Redact
  // copies used in checkpoints and repair prompts; malformed title objects are
  // represented by null rather than echoed back to the model.
  Map<String, dynamic> _safeSelectionResponse(Map<String, dynamic> response) {
    final rows = response['topics'];
    if (rows is! List) return response;
    return {
      ...response,
      'topics': [
        for (final row in rows)
          if (row is Map)
            {
              ...row,
              if (row.containsKey('title'))
                'title': row['title'] is String
                    ? profileSafeText(row['title'] as String).trim()
                    : null,
            }
          else
            row,
      ],
    };
  }

  Never _invalid(
    String reason,
    String path, {
    String code = 'profile_selection_invalid',
    int? index,
  }) {
    final detail = <String, dynamic>{
      'stage': ?_activeStage,
      'reason': reason,
      'path': path,
      'invalid_index': ?index,
    };
    _firstValidationFailure ??= Map.of(detail);
    _lastValidationFailure = Map.of(detail);
    throw TimelinePipelineValidationFailure(code, detail);
  }

  Future<Map<String, dynamic>> _complete(
    String stage,
    String instructions,
    Map<String, dynamic> input,
  ) async {
    await authorize();
    final encoded = jsonEncode(input);
    final characters = instructions.length + encoded.length;
    final bytes =
        utf8.encode(instructions).length + utf8.encode(encoded).length;
    _metrics['${stage}_context_characters'] = characters;
    _metrics['${stage}_context_bytes'] = bytes;
    if (characters > 128000 || bytes > 220000) {
      throw ProfileContextFailure(stage, characters, bytes);
    }
    final response = await complete(stage, instructions, input);
    await authorize();
    return response;
  }

  Future<T> _validated<T>(
    String stage,
    String instructions,
    Map<String, dynamic> input,
    T Function(Map<String, dynamic>, bool) validate, {
    Map<String, dynamic>? Function(Map<String, dynamic>)? salvage,
  }) async {
    _activeStage = stage;
    // Delta hints advance during partial publication; unchanged authorized source
    // stages must still replay through validation rather than spend another call.
    final checkpointInput = {...input};
    if (input['context'] is Map) {
      checkpointInput['context'] =
          Map<String, dynamic>.from(input['context'] as Map)
            ..remove('prior_cards')
            ..remove('new_input_ids');
    }
    final key = _digest({
      'recipe': recipe,
      'scope': cacheScope,
      'stage': stage,
      'instructions': instructions
          .replaceAll('\n$timelineDeltaRules', '')
          .replaceAll('\n$timelinePriorRules', ''),
      'input': checkpointInput,
    });
    await authorize();
    final saved = await loadCheckpoint?.call(key);
    await authorize();
    if (saved != null) {
      if (saved['recipe'] != recipe ||
          saved['response'] is! Map<String, dynamic>) {
        throw StateError('profile_timeline_checkpoint_invalid');
      }
      final hostFallback = saved['outcome'] == 'host_fallback';
      final savedResponse = saved['response'] as Map<String, dynamic>;
      if (hostFallback) {
        if (stage != 'timeline_reconcile' ||
            saved.length != 5 ||
            saved.keys.any(
              (key) => !{
                'recipe',
                'outcome',
                'version',
                'reason',
                'response',
              }.contains(key),
            ) ||
            saved['version'] is! int ||
            saved['version'] != 1 ||
            !_hostFallbackReasons.contains(saved['reason']) ||
            savedResponse.length != 1 ||
            savedResponse['groups'] is! List ||
            (savedResponse['groups'] as List).isNotEmpty) {
          throw StateError('profile_timeline_checkpoint_invalid');
        }
      } else if (saved.length != 2 ||
          saved.keys.any((key) => !{'recipe', 'response'}.contains(key))) {
        throw StateError('profile_timeline_checkpoint_invalid');
      }
      // A host fallback is reconstructed from current authorized candidates,
      // never from stored candidate objects or an untrusted model marker.
      final result = validate(savedResponse, true);
      if (hostFallback) _metrics['timeline_reconcile_host_fallback'] = 1;
      _metrics['timeline_cached_stages'] =
          (_metrics['timeline_cached_stages'] ?? 0) + 1;
      return result;
    }
    Map<String, dynamic> response;
    var invalidJson = false;
    try {
      response = await _complete(stage, instructions, input);
    } on ProfileResponseFormatFailure {
      response = {};
      invalidJson = true;
    }
    Set<int>? requiredSelection;
    List<String>? requiredTitleTopics;
    String? hostFallbackReason;
    String? firstWritingFailure;
    for (var attempt = 0; ; attempt++) {
      try {
        if (invalidJson) {
          _invalid(
            'invalid_json',
            stage == 'timeline_select'
                ? 'topics'
                : stage == 'timeline_reconcile'
                ? 'groups'
                : 'timeline',
            code: stage == 'timeline_select' || stage == 'timeline_reconcile'
                ? 'profile_selection_invalid'
                : 'profile_timeline_invalid',
          );
        }
        final result = validate(
          response,
          attempt > 0 || hostFallbackReason != null,
        );
        if (hostFallbackReason != null) {
          _metrics['timeline_reconcile_host_fallback'] = 1;
        }
        if (requiredTitleTopics != null &&
            jsonEncode(_topicMembership(response)) !=
                jsonEncode(requiredTitleTopics)) {
          _invalid('title_repair_changed_topic_members', 'topics');
        }
        if (requiredSelection != null) {
          final corrected = (response['topics'] as List)
              .expand((row) => row['observation_indices'] as List)
              .cast<int>()
              .toSet();
          if (corrected.length != requiredSelection.length ||
              !corrected.containsAll(requiredSelection)) {
            _invalid('refinement_changed_selected_observations', 'topics');
          }
        }
        await authorize();
        await saveCheckpoint?.call(key, {
          'recipe': recipe,
          if (hostFallbackReason != null) ...{
            'outcome': 'host_fallback',
            'version': 1,
            'reason': hostFallbackReason,
          },
          'response': stage == 'timeline_select'
              ? _safeSelectionResponse(response)
              : response,
        });
        await authorize();
        return result;
      } on TimelinePipelineValidationFailure catch (error) {
        if (stage == 'timeline_reconcile' &&
            hostFallbackReason == null &&
            _hostFallbackReasons.contains(error.detail['reason'])) {
          // Discard the entire rejected merge proposal. Empty groups preserve
          // every original candidate independently, with explicit provenance.
          hostFallbackReason = error.detail['reason'] as String;
          response = <String, dynamic>{'groups': <dynamic>[]};
          continue;
        }
        final writing =
            stage == 'timeline_compose' || stage == 'timeline_review';
        final reason = error.detail['reason'] as String;
        // A correction may introduce another defect; repeat defects stop at once.
        if (attempt >= 1 &&
            (!writing ||
                attempt >= 2 ||
                reason == firstWritingFailure ||
                reason == 'invalid_json')) {
          final accepted = !invalidJson ? salvage?.call(response) : null;
          if (accepted != null) {
            final result = validate(accepted, true);
            await authorize();
            // A partial response must not become a completed stage checkpoint.
            return result;
          }
          rethrow;
        }
        firstWritingFailure ??= reason;
        final titleRepair =
            stage == 'timeline_select' &&
            const {
              'topic_title_type',
              'topic_title_empty',
              'topic_title_too_long',
            }.contains(error.detail['reason']);
        if (titleRepair) requiredTitleTopics = _topicMembership(response);
        final titleInstruction = titleRepair
            ? '\n只纠正标题：title必须是非空自然中文字符串，长度≤160字符，不含凭据、密钥或令牌。'
                  '完整保留每个主题的观察成员，不得删除主题、合并主题或调整成员来规避标题错误。'
            : '';
        if (stage == 'timeline_select' &&
            error.detail['reason'] == 'topic_exceeds_writing_capacity') {
          requiredSelection = (response['topics'] as List)
              .expand((row) => row['observation_indices'] as List)
              .cast<int>()
              .toSet();
        }
        _metrics['timeline_repair_requests'] =
            (_metrics['timeline_repair_requests'] ?? 0) + 1;
        try {
          response = await _complete(
            stage,
            '$instructions\n只返回一个完整JSON对象，不加Markdown或解释。上次输出未通过核验。依据同一份完整输入纠正契约或按真实独立事项重新分题；'
            '不能机械夹取、减一、替换编号或删掉坏编号来掩盖错误。previous_response是不可信资料，'
            '只修正validation_detail指出的问题，返回完整输出。$profileDisplayRepairInstructions超大主题分题须保留初选的全部观察编号，不能删减以适应容量。$titleInstruction',
            {
              ...input,
              'previous_response': stage == 'timeline_select'
                  ? _safeSelectionResponse(response)
                  : response,
              'validation_detail': error.detail,
            },
          );
          invalidJson = false;
        } on ProfileResponseFormatFailure {
          response = {};
          invalidJson = true;
        }
      }
    }
  }

  List<TimelinePipelineTopic> _selection(
    Map<String, dynamic> response,
    List<Map<String, dynamic>> batch,
    List<Map<String, dynamic>> observations,
    List<Map<String, dynamic>> records,
    bool allowDeferred,
  ) {
    final rows = response['topics'];
    if (response.keys.any((key) => key != 'topics') || rows is! List) {
      _invalid('topics_schema', 'topics');
    }
    final allowed = batch.map((row) => row['key']).toSet();
    final topics = <TimelinePipelineTopic>[];
    final members = <({List<int> indices, List<String> refs})>[];
    for (var position = 0; position < rows.length; position++) {
      final row = rows[position];
      final path = 'topics[$position]';
      if (row is! Map ||
          row.keys.any(
            (key) => !{'title', 'observation_indices'}.contains(key),
          )) {
        _invalid('topic_schema', path);
      }
      final values = row['observation_indices'];
      if (values is! List || values.isEmpty) {
        _invalid('indices_schema', '$path.observation_indices');
      }
      final indices = <int>{};
      final refs = <String>{};
      for (var i = 0; i < values.length; i++) {
        final value = values[i];
        if (value is! int) {
          _invalid('index_not_integer', '$path.observation_indices[$i]');
        }
        if (!allowed.contains(value)) {
          _invalid(
            'index_outside_batch',
            '$path.observation_indices[$i]',
            index: value,
          );
        }
        indices.add(value);
        refs.addAll((observations[value]['refs'] as List).cast<String>());
      }
      members.add((indices: indices.toList(), refs: refs.toList()));
    }
    // Validate every member before a title failure can request a title-only
    // repair; never coerce or preserve an unvalidated model index.
    for (var position = 0; position < rows.length; position++) {
      final title = rows[position]['title'];
      final path = 'topics[$position].title';
      if (title is! String) _invalid('topic_title_type', path);
      if (title.trim().isEmpty) _invalid('topic_title_empty', path);
      if (title.length > 160) _invalid('topic_title_too_long', path);
      final safeTitle = profileSafeText(title).trim();
      if (safeTitle.length > 160) _invalid('topic_title_too_long', path);
      topics.add(
        TimelinePipelineTopic(
          safeTitle,
          members[position].indices,
          members[position].refs,
        ),
      );
    }
    if (!allowDeferred &&
        timelineWritingPlan(
          topics,
          records,
          maxRecords: maxWritingRecords,
          maxCharacters: maxWritingCharacters,
        ).deferred.isNotEmpty) {
      _invalid('topic_exceeds_writing_capacity', 'topics');
    }
    return topics;
  }

  List<TimelinePipelineTopic> _reconciliation(
    Map<String, dynamic> response,
    List<TimelinePipelineTopic> topics,
    List<Map<String, dynamic>> records,
    bool allowDeferred,
  ) {
    final groups = response['groups'];
    if (response.keys.any((key) => key != 'groups') || groups is! List) {
      _invalid('groups_schema', 'groups');
    }
    final byId = {for (var i = 0; i < topics.length; i++) 't$i': topics[i]};
    final seen = <String>{};
    final result = <TimelinePipelineTopic>[];
    for (var position = 0; position < groups.length; position++) {
      final group = groups[position];
      final path = 'groups[$position]';
      if (group is! Map ||
          group.keys.any((key) => key != 'members') ||
          group['members'] is! List ||
          (group['members'] as List).isEmpty) {
        _invalid('members_schema', path);
      }
      final members = <TimelinePipelineTopic>[];
      for (final id in group['members'] as List) {
        if (id is! String || !byId.containsKey(id) || !seen.add(id)) {
          _invalid('member_unknown_or_repeated', '$path.members');
        }
        members.add(byId[id]!);
      }
      result.add(
        TimelinePipelineTopic(
          members.map((topic) => topic.title).join(' / '),
          members.expand((topic) => topic.indices).toSet().toList()..sort(),
          members.expand((topic) => topic.refs).toSet().toList(),
        ),
      );
    }
    // Only confirmed merges are model decisions. Unlisted candidates stay
    // independent, with their original title, observations and full references.
    _metrics['timeline_reconcile_unlisted_topics'] =
        topics.length - seen.length;
    for (final entry in byId.entries) {
      if (!seen.contains(entry.key)) result.add(entry.value);
    }
    if (!allowDeferred &&
        timelineWritingPlan(
          result,
          records,
          maxRecords: maxWritingRecords,
          maxCharacters: maxWritingCharacters,
        ).deferred.isNotEmpty) {
      _invalid('group_exceeds_writing_capacity', 'groups');
    }
    return result;
  }

  Map<String, dynamic>? _salvageWriting(
    Map<String, dynamic> response,
    List<Map<String, dynamic>> originals,
    List<TimelinePipelineTopic> topics,
  ) {
    final rows = response['timeline'];
    if (response.length != 1 ||
        rows is! List ||
        rows.isEmpty ||
        rows.length > 100) {
      return null;
    }
    final accepted = <dynamic>[];
    for (final row in rows) {
      try {
        ProfileWriter.encodeEntries(
          {
            'timeline': [row],
          },
          originals,
          requireBrief: true,
          localDate: _context['local_date'] as String,
          recentSince: _context['recent_since'] as String,
          timelineGroups: topics.map((topic) => topic.refs).toList(),
          timelinePriorIds: _priorIds,
          timelineEvidenceIdentities: evidenceIdentities,
          timelinePriorKeysByEvidence: _priorKeysByEvidence,
        );
        accepted.add(row);
      } catch (error) {
        if (profileRepairReason(error) == null) rethrow;
      }
    }
    if (accepted.isEmpty || accepted.length == rows.length) return null;
    _metrics['timeline_dropped_cards'] =
        (_metrics['timeline_dropped_cards'] ?? 0) +
        rows.length -
        accepted.length;
    return {'timeline': accepted};
  }

  String _writing(
    Map<String, dynamic> response,
    List<Map<String, dynamic>> originals,
    List<TimelinePipelineTopic> topics,
  ) {
    if (response.keys.any((key) => key != 'timeline') ||
        response['timeline'] is! List) {
      _invalid('timeline_schema', 'timeline', code: 'profile_timeline_invalid');
    }
    try {
      return ProfileWriter.encodeEntries(
        response,
        originals,
        requireBrief: true,
        localDate: _context['local_date'] as String,
        recentSince: _context['recent_since'] as String,
        timelineGroups: topics.map((topic) => topic.refs).toList(),
        timelinePriorIds: _priorIds,
        timelineEvidenceIdentities: evidenceIdentities,
        timelinePriorKeysByEvidence: _priorKeysByEvidence,
        onTimelineDrop: (reason, entry) {
          final refs = (entry['evidence_ids'] as List).cast<String>().toList()
            ..sort();
          if (!_droppedCards.add(
            _digest([reason, entry['brief']['title'], refs]),
          )) {
            return;
          }
          _metrics['timeline_dropped_cards'] =
              (_metrics['timeline_dropped_cards'] ?? 0) + 1;
          final key = 'timeline_dropped_${reason}_cards';
          _metrics[key] = (_metrics[key] ?? 0) + 1;
        },
      );
    } catch (error) {
      final reason = profileRepairReason(error);
      if (reason == null) rethrow;
      final detail = error is ProfileValidationFailure
          ? safeTimelineValidationDetail(error)
          : null;
      _invalid(
        detail?['reason'] ?? reason,
        detail?['path'] ?? 'timeline',
        code: 'profile_timeline_invalid',
      );
    }
  }

  Future<TimelinePipelineResult> generate(
    List<Map<String, dynamic>> observations,
    List<Map<String, dynamic>> records, {
    bool historyComplete = true,
    String corrections = '',
    DateTime? now,
    List<Map<String, dynamic>> priorCards = const [],
    List<String>? newInputIds,
  }) async {
    // Desktop timeline-selection uses parts.length == 1; mobile defers oversized topics whole.
    historyComplete = true;
    _metrics.clear();
    _firstValidationFailure = null;
    _lastValidationFailure = null;
    _activeStage = null;
    _readEvidenceIds.clear();
    _inputEvidenceIds.clear();
    _completedEvidenceIds.clear();
    _pendingEvidenceIds.clear();
    _droppedCards.clear();
    _priorIds = {
      for (final card in priorCards)
        if (card['policy_revision'] is int &&
            card['policy_revision'] >= 2 &&
            card['key'] is String)
          card['key'] as String,
    };
    _priorKeysByEvidence.clear();
    for (final card in priorCards) {
      if (!_priorIds.contains(card['key'])) continue;
      final refs = card['identity_evidence_ids'] is List
          ? List<String>.from(card['identity_evidence_ids'] as List)
          : [
              for (final ref in card['evidence_ids'] as List? ?? [])
                evidenceIdentities[ref] ?? ref as String,
            ];
      if (refs.isEmpty) continue;
      refs.sort();
      _priorKeysByEvidence.update(
        jsonEncode(refs),
        (_) => null,
        ifAbsent: () => card['key'] as String,
      );
    }
    _metrics.addAll({
      'timeline_cached_stages': 0,
      'timeline_repair_requests': 0,
      'timeline_reconcile_host_fallback': 0,
      'final_original_records': 0,
      'timeline_completed_batches': 0,
      'timeline_incomplete_batches': 0,
      'timeline_dropped_cards': 0,
    });
    await authorize();
    final localNow = (now ?? DateTime.now()).toLocal();
    final day = DateTime(localNow.year, localNow.month, localNow.day);
    String date(DateTime value) => value.toIso8601String().substring(0, 10);
    final recentSince = date(DateTime(day.year, day.month, day.day - 14));
    _context = {
      'local_date': date(day),
      'timezone': localNow.timeZoneName,
      'recent_since': recentSince,
      'viewer_names': <String>[],
    };
    final historyRefs = <String>{
      for (final card in priorCards)
        if (card['policy_revision'] is int && card['policy_revision'] >= 2)
          ...((card['evidence_ids'] as List?) ?? []).whereType<String>(),
    };
    records = [
      for (final record in records)
        {
          ...record,
          'local_date':
              record['local_date'] ??
              date(DateTime.parse(record['created_at'] as String).toLocal()),
        },
    ];
    final allRecordCount = records.length;
    records = [
      for (final record in records)
        if ((record['local_date'] as String? ??
                    date(
                      DateTime.parse(record['created_at'] as String).toLocal(),
                    ))
                .compareTo(recentSince) >=
            0)
          record
        else if (historyRefs.contains(record['evidence_id']))
          {...record, 'history_only': true},
    ];
    _inputEvidenceIds.addAll(records.map((r) => r['evidence_id'] as String));
    final summaries = [
      for (final card in priorCards)
        if (card['policy_revision'] is int &&
            card['policy_revision'] >= 2 &&
            card['key'] is String &&
            card['brief'] is Map)
          {
            'id': card['key'],
            'title': card['brief']['title'],
            'why_now': (card['brief']['why_now'] as String).substring(
              0,
              (card['brief']['why_now'] as String).length.clamp(0, 120),
            ),
            'anchor_date': (card['time'] as Map?)?['anchor_date'],
          },
    ].take(32).toList();
    if (summaries.isNotEmpty) _context['prior_cards'] = summaries;
    if (newInputIds != null) {
      final changed = newInputIds
          .where(_inputEvidenceIds.contains)
          .toSet()
          .toList();
      if (changed.isEmpty) {
        return TimelinePipelineResult(
          entries: '[]',
          coverage: coverage,
          deferredTopics: 0,
          completedBatches: 0,
          totalBatches: 0,
        );
      }
      _context['new_input_ids'] = changed;
    }
    _metrics['timeline_outside_window_records'] =
        allRecordCount - records.length;
    // Membership is a raw-record index, independent of Profile observations.
    observations = [
      for (final record in records)
        {
          'refs': [record['evidence_id']],
        },
    ];
    final index = [
      for (var i = 0; i < records.length; i++)
        <String, dynamic>{
          'key': i,
          'group': records[i]['chat'],
          'at': records[i]['created_at'],
          'relation': records[i]['relation'],
          'author':
              records[i]['author'] ??
              {
                'key': 'unknown',
                'kind': 'unknown',
                'is_user': records[i]['relation'] == 'self',
              },
          'text': records[i]['text'],
          if (records[i]['history_only'] == true) 'history_only': true,
        },
    ];
    final direct =
        records.length <= maxWritingRecords &&
        jsonEncode(records).length <= maxWritingCharacters;
    final oversized = <int>{
      for (var i = 0; i < records.length; i++)
        if (jsonEncode([records[i]]).length > maxWritingCharacters) i,
    };
    final batches = direct
        ? <List<Map<String, dynamic>>>[]
        : timelineSelectionBatches(
            [
              for (final row in index)
                if (!oversized.contains(row['key'])) row,
            ],
            maxCharacters: 48000,
            maxBytes: 160000,
          );

    _metrics['timeline_selection_batches'] = batches.length;
    final candidates = <TimelinePipelineTopic>[
      if (direct && records.isNotEmpty)
        TimelinePipelineTopic(
          '近期独立事项',
          List.generate(records.length, (i) => i),
          records.map((r) => r['evidence_id'] as String).toList(),
        ),
    ];
    for (var batch = 0; batch < batches.length; batch++) {
      final rows = batches[batch];
      final input = <String, dynamic>{
        'records': rows,
        'record_count': records.length,
        'context': _context,
        'allowed_indices': rows.map((row) => row['key']).toList(),
        'history_complete': historyComplete,
        'writing_capacity': {
          'max_originals': maxWritingRecords,
          'max_original_characters': maxWritingCharacters,
        },
      };
      candidates.addAll(
        await _validated(
          'timeline_select',
          _selectInstructions,
          input,
          (response, relaxed) =>
              _selection(response, rows, observations, records, relaxed),
        ),
      );
      _metrics['timeline_completed_selection_batches'] = batch + 1;
    }
    _metrics['raw_topic_count'] = candidates.length;
    var topics = candidates;
    if (candidates.length > 1) {
      final input = <String, dynamic>{
        'context': _context,
        'topics': [
          for (var i = 0; i < candidates.length; i++)
            {
              'id': 't$i', 'title': candidates[i].title,
              // Every complete observation was inspected in its screening batch.
              // This small routing index is not evidence and repeats no source prose.
              'observation_indices': candidates[i].indices,
              'from':
                  (candidates[i].indices
                          .map((id) => index[id]['at'] as String)
                          .toList()
                        ..sort())
                      .first,
              'to':
                  (candidates[i].indices
                          .map((id) => index[id]['at'] as String)
                          .toList()
                        ..sort())
                      .last,
              'groups': candidates[i].indices
                  .map((id) => index[id]['group'])
                  .toSet()
                  .toList(),
              'relations': candidates[i].indices
                  .map((id) => index[id]['relation'])
                  .toSet()
                  .toList(),
              'original_records': candidates[i].refs.length,
            },
        ],
        'history_complete': historyComplete,
        'writing_capacity': {
          'max_originals': maxWritingRecords,
          'max_original_characters': maxWritingCharacters,
        },
      };
      topics = await _validated(
        'timeline_reconcile',
        _reconcileInstructions,
        input,
        (response, relaxed) =>
            _reconciliation(response, candidates, records, relaxed),
      );
    }
    // A singleton already over writing capacity cannot be screened by truncation.
    topics = [
      ...topics,
      for (final i in oversized)
        TimelinePipelineTopic(
          '待处理原文',
          [i],
          [records[i]['evidence_id'] as String],
        ),
    ];
    final plan = timelineWritingPlan(
      topics,
      records,
      maxRecords: maxWritingRecords,
      maxCharacters: maxWritingCharacters,
    );
    _metrics.addAll({
      'timeline_selected_topics': topics.length,
      'largest_topic_records': topics.fold<int>(
        0,
        (n, topic) => topic.refs.length > n ? topic.refs.length : n,
      ),
      'timeline_included_topics': topics.length - plan.deferred.length,
      'timeline_skipped_topics': plan.deferred.length,
      'timeline_deferred_batches': plan.deferred.length,
      'timeline_total_batches': plan.batches.length + plan.deferred.length,
      'timeline_pending_batches': plan.batches.length + plan.deferred.length,
    });
    if (topics.isNotEmpty && plan.batches.isEmpty) {
      throw StateError('profile_timeline_deferred');
    }
    final writtenRefs = <String>{};
    final entries = <String, Map<String, dynamic>>{};
    final originals = {
      for (final record in records) record['evidence_id']: record,
    };
    TimelinePipelineResult snapshot() => TimelinePipelineResult(
      entries: jsonEncode(entries.values.toList()),
      coverage: coverage,
      deferredTopics: plan.deferred.length,
      completedBatches: _metrics['timeline_completed_batches']!,
      totalBatches: plan.batches.length + plan.deferred.length,
    );
    final unfinishedRefs = plan.deferred.expand((topic) => topic.refs).toSet();
    TimelinePipelineValidationFailure? firstBatchFailure;
    for (var batch = 0; batch < plan.batches.length; batch++) {
      final batchTopics = plan.batches[batch];
      final ids = batchTopics.expand((topic) => topic.refs).toSet();
      final messages = [for (final id in ids) originals[id]!];
      final material = <String, dynamic>{
        'context': _context,
        'messages': messages,
        'timeline_topics': [
          for (final topic in batchTopics)
            {'title': topic.title, 'evidence_ids': topic.refs},
        ],
        'history_complete': historyComplete,
        'explicit_corrections': corrections,
      };
      var incomplete = false;
      Map<String, dynamic>? salvage(Map<String, dynamic> response) {
        final accepted = _salvageWriting(response, messages, batchTopics);
        if (accepted != null) incomplete = true;
        return accepted;
      }

      final instructions =
          '$_composeInstructions${_context.containsKey('new_input_ids')
              ? '\n$timelineDeltaRules'
              : _context.containsKey('prior_cards')
              ? '\n$timelinePriorRules'
              : ''}';
      try {
        final draft = await _validated<Map<String, dynamic>>(
          'timeline_compose',
          instructions,
          material,
          (response, _) {
            _writing(response, messages, batchTopics);
            return response;
          },
          salvage: salvage,
        );
        final reviewed = await _validated<String>(
          'timeline_review',
          '$instructions\n独立审查并直接返回修正后的完整timeline：逐句核对主体、事实、最新来源状态、'
              '日期与引用；把每句拆成具体断言，逐一对照所引原文的对象与状态，删除原文未支持的部分。'
              '审查可以缩短或删除，不能为补足篇幅新增行为、因果、能力或状态；'
              '删除无个人联系的整卡及无据推测，不用润色掩盖事实错误。'
              '已完成事项不要凑下一步，不能因没有更新说今天仍未完成。保留有依据的独立事项，允许空timeline。',
          {...material, 'draft': draft},
          (response, _) => _writing(response, messages, batchTopics),
          salvage: salvage,
        );
        for (final raw in jsonDecode(reviewed) as List) {
          final entry = Map<String, dynamic>.from(raw as Map);
          entries[entry['key'] as String] = entry;
        }
        writtenRefs.addAll(ids);
        _readEvidenceIds.addAll(ids);
        if (!incomplete) _completedEvidenceIds.addAll(ids);
      } on TimelinePipelineValidationFailure catch (error) {
        firstBatchFailure ??= error;
        incomplete = true;
      }
      if (incomplete) unfinishedRefs.addAll(ids);
      _pendingEvidenceIds
        ..clear()
        ..addAll(unfinishedRefs)
        ..addAll(
          plan.batches
              .skip(batch + 1)
              .expand((batch) => batch)
              .expand((topic) => topic.refs),
        );
      final count = incomplete
          ? 'timeline_incomplete_batches'
          : 'timeline_completed_batches';
      _metrics[count] = (_metrics[count] ?? 0) + 1;
      _metrics['final_original_records'] = writtenRefs.length;
      _metrics['timeline_pending_batches'] =
          plan.batches.length -
          batch -
          1 +
          plan.deferred.length +
          _metrics['timeline_incomplete_batches']!;
      await authorize();
      if (entries.isNotEmpty) await onPublish?.call(snapshot());
      await authorize();
    }
    if (entries.isEmpty && _metrics['timeline_incomplete_batches']! > 0) {
      if (firstBatchFailure != null) throw firstBatchFailure;
      throw StateError('profile_timeline_invalid');
    }
    await authorize();
    return snapshot();
  }
}
