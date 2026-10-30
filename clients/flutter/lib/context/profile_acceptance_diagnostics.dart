import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';
import '../agent_core/model_client.dart';
import '../personal/local_life.dart';
import '../space/space_storage.dart';
import 'profile_agent.dart';
import 'profile_generation_coordinator.dart';
import 'profile_validation.dart';
import 'secure_persistence.dart';

/// Opt-in acceptance metadata only; never source text, model prose or credentials.
class ProfileAcceptanceDiagnostics {
  ProfileAcceptanceDiagnostics({
    required this.output,
    required this.readReceipt,
    required this.readState,
  });
  final LifePersistence output;
  final Future<Map<String, dynamic>?> Function() readReceipt;
  final FutureOr<Map<String, dynamic>> Function() readState;
  Future<void> _tail = Future.value();
  List<Map<String, dynamic>>? _snapshots;
  static const _terminal = {'paused', 'blocked', 'failed', 'ready'};
  static const _stages = {
    'observations',
    'draft',
    'review',
    'edit',
    'repair',
    'timeline_select',
    'timeline_reconcile',
    'timeline_compose',
    'timeline_review',
  };
  static const _counts = {
    'eligible_records',
    'validated_observation_records',
    'reused_observation_records',
    'final_original_records',
    'incomplete_batches',
    'unobserved_records',
    'timeline_completed_batches',
    'timeline_incomplete_batches',
    'timeline_dropped_cards',
    'timeline_pending_batches',
  };
  static bool _number(Object? value) =>
      value is int && value >= 0 && value <= 1000000000000;
  static String? _code(Object? value) =>
      value is String ? profileRunErrorCode(AgentFailure(value)) : null;
  static Map<String, dynamic> _numbers(Object? value, Set<String> keys) => {
    if (value is Map)
      for (final key in keys)
        if (_number(value[key])) key: value[key],
  };
  static Future<Map<String, dynamic>?> _read(
    LifePersistence persistence,
  ) async {
    final raw = await persistence.read();
    if (raw == null || raw.length > 65536) return null;
    final parsed = jsonDecode(raw);
    return parsed is Map<String, dynamic> ? parsed : null;
  }

  static Map<String, dynamic>? _detail(Object? value) {
    if (value is! Map) return null;
    final reason = value['reason'], path = value['path'];
    var detail = safeTimelineValidationDetail(
      ProfileValidationFailure('ungrounded_projection', {
        'reason': reason,
        'path': path,
      }),
    );
    const indexReasons = {
      'group_exceeds_writing_capacity',
      'groups_schema',
      'index_not_integer',
      'index_outside_batch',
      'indices_schema',
      'member_unknown_or_repeated',
      'members_schema',
      'refinement_changed_selected_observations',
      'timeline_schema',
      'title_repair_changed_topic_members',
      'topic_exceeds_writing_capacity',
      'topic_schema',
      'topic_title_empty',
      'topic_title_too_long',
      'topic_title_type',
      'topics_schema',
    };
    if (detail == null &&
        indexReasons.contains(reason) &&
        path is String &&
        path.length <= 180 &&
        RegExp(
          r'^(?:topics|groups|timeline)(?:\[[0-9]+\])?(?:\.(?:title|members|observation_indices)(?:\[[0-9]+\])?)?$',
        ).hasMatch(path)) {
      detail = {'reason': reason as String, 'path': path};
    }
    if (detail == null) return null;
    return {
      ...detail,
      if (_stages.contains(value['stage'])) 'stage': value['stage'],
      if (value['invalid_index'] is int &&
          (value['invalid_index'] as int).abs() <= 1000000)
        'invalid_index': value['invalid_index'],
    };
  }

  static Map<String, dynamic> _pipeline(Object? value) => {
    if (value is Map)
      for (final key in ['first', 'last']) key: ?_detail(value[key]),
  };
  static Map<String, dynamic> _clean(Map state, Object? receipt) {
    final data = receipt is Map ? receipt : const {};
    final pipeline = _pipeline(data['pipeline_validation']);
    if (pipeline.isEmpty) {
      pipeline.addAll(_pipeline(state['pipeline_validation']));
    }
    return {
      if (ProfileGenerationPhase.values.any(
        (phase) => phase.name == state['phase'],
      ))
        'phase': state['phase'],
      'code': ?_code(state['code']),
      ..._numbers(state, {'budget_cap_microyuan', 'budget_reserved_microyuan'}),
      'receipt': {
        if (const {
          'running',
          'completed',
          'partial',
          'interrupted',
          'paused',
        }.contains(data['status']))
          'status': data['status'],
        'error_code': ?_code(data['error_code']),
        if (_stages.contains(data['last_stage']))
          'last_stage': data['last_stage'],
        'coverage': _numbers(data['coverage'], _counts),
        'pipeline_validation': pipeline,
      },
    };
  }

  Future<void> capture({bool startup = false}) {
    final state = Future<Map<String, dynamic>>.sync(
      readState,
    ).then((value) => value, onError: (Object _) => <String, dynamic>{});
    final receipt = Future<Map<String, dynamic>?>.sync(
      readReceipt,
    ).then((value) => value, onError: (Object _) => null);
    final next = _tail.then((_) async {
      final snapshot = _clean(await state, await receipt);
      if (!startup && !_terminal.contains(snapshot['phase'])) return;
      if (_snapshots == null) {
        final saved = (await _read(output))?['snapshots'];
        _snapshots = [
          if (saved is List)
            for (final item in saved.reversed.take(10).toList().reversed)
              if (item is Map) _clean(item, item['receipt']),
        ];
      }
      if (_snapshots!.any((item) => jsonEncode(item) == jsonEncode(snapshot))) {
        return;
      }
      final snapshots = [..._snapshots!, snapshot];
      if (snapshots.length > 10) snapshots.removeAt(0);
      await output.write(jsonEncode({'version': 1, 'snapshots': snapshots}));
      _snapshots = snapshots;
    });
    // Diagnostic I/O must never trigger a model retry or block publication.
    _tail = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return _tail;
  }

  static Future<ProfileAcceptanceDiagnostics?> open(
    ProfileAgent agent,
    ProfileGenerationCoordinator generation,
  ) async {
    if (!const bool.fromEnvironment('NOVA_PROFILE_ACCEPTANCE_DIAGNOSTICS') ||
        ProfileAgent.budgetId.isEmpty) {
      return null;
    }
    final scope = SpaceStorage.scope;
    final receipt = SecureContextPersistence(ProfileAgent.receiptKey);
    final budget = agent.budget!;
    try {
      final root = await getApplicationDocumentsDirectory();
      final diagnostics = ProfileAcceptanceDiagnostics(
        output: FileLifePersistence(
          File(
            '${root.path}/nova-acceptance/spaces/${scope?.id ?? 'legacy'}/profile-diagnostics.json',
          ),
        ),
        readReceipt: () => _read(receipt),
        readState: () async {
          final phase = generation.phase.name, code = generation.code;
          final validation = agent.lastPipelineValidation;
          final ledger = await _read(budget.persistence);
          return {
            'phase': phase,
            'code': code,
            'budget_cap_microyuan': budget.capMicroyuan,
            'budget_reserved_microyuan':
                ledger != null && _number(ledger['reserved_microyuan'])
                ? ledger['reserved_microyuan']
                : budget.reservedMicroyuan,
            'pipeline_validation': validation,
          };
        },
      );
      await diagnostics.capture(startup: true);
      return diagnostics;
    } catch (_) {
      return null;
    }
  }
}
