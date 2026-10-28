import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../personal/local_life.dart';

/// A failed output must not trigger another paid Profile round automatically.
/// Preserve the actual failure for permission, budget and network diagnostics.
class ProfileGenerationTerminalFailure implements Exception {
  const ProfileGenerationTerminalFailure(this.cause);
  final Object cause;
  @override
  String toString() => cause.toString();
}

enum ProfileGenerationPhase {
  waiting,
  working,
  continuing,
  paused,
  blocked,
  failed,
  ready,
}

class ProfileGenerationSnapshot {
  const ProfileGenerationSnapshot({
    required this.scope,
    required this.complete,
    required this.hasResult,
    required this.covered,
    required this.total,
    this.pendingOutput = false,
    this.outputBatches = 0,
  });
  final String scope;
  final bool complete, hasResult, pendingOutput;
  final int outputBatches;
  final int covered, total;
}

/// One foreground application owner. Navigation never creates another scheduler.
/// Durable attempts are written before work; input policy owns model access.
class ProfileGenerationCoordinator extends ChangeNotifier
    with WidgetsBindingObserver {
  ProfileGenerationCoordinator({
    required this.persistence,
    required this.inspect,
    required this.generate,
    required this.cancel,
    required this.failureCode,
    int Function()? processedRecords,
    DateTime Function()? now,
    this.autoSchedule = true,
    this.pauseAfterRound = false,
    this.inputs = const [],
    this.progress,
    this.recoverBudgetPause,
    this.budgetLimitMicroyuan,
    this.retryBase = const Duration(seconds: 30),
    this.roundDelay = const Duration(seconds: 3),
  }) : now = now ?? DateTime.now,
       processedRecords = processedRecords ?? (() => 0);
  final LifePersistence persistence;
  final Future<Map<String, dynamic>?> Function(Map<String, dynamic>)?
  recoverBudgetPause;
  final int? budgetLimitMicroyuan;
  final Future<ProfileGenerationSnapshot?> Function() inspect;
  final Future<void> Function({
    required bool savedObservationsOnly,
    required int? maxNewBatches,
  })
  generate;
  final VoidCallback cancel;

  /// Must return the product's allowlisted error code, never exception prose.
  final String Function(Object) failureCode;
  final int Function() processedRecords;
  final DateTime Function() now;
  final bool autoSchedule;

  /// Bounded acceptance runs finish and persist before stopping new rounds.
  /// Normal application builds leave this false.
  final bool pauseAfterRound;
  final List<Listenable> inputs;
  final Listenable? progress;
  final Duration retryBase, roundDelay;
  Map<String, dynamic> _record = {};
  Timer? _timer, _heartbeat;
  bool _opened = false,
      _disposed = false,
      _checking = false,
      _foreground = true;
  Future<void>? _opening;
  Future<void> _writes = Future.value();
  ProfileGenerationPhase phase = ProfileGenerationPhase.waiting;
  String? code;
  int covered = 0, total = 0, revision = 0;
  bool get working => phase == ProfileGenerationPhase.working;
  bool get manuallyPaused => _record['manual_pause'] == true;
  bool get hasResult => covered > 0;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start() => _opening ??= _start();
  Future<void> _start() async {
    try {
      final raw = await persistence.read();
      if (raw != null && raw != 'null') {
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['version'] != 1) {
          throw const FormatException('generation_state');
        }
        _record = value;
      }
      if (_disposed) return;
      if (!manuallyPaused &&
          _record['requires_explicit_retry'] != true &&
          _record['terminal_code'] == 'profile_budget_exhausted') {
        final resumed = await recoverBudgetPause?.call(Map.of(_record));
        if (resumed != null) {
          _record = resumed;
          _record.remove('error_code');
          _record.remove('next_at');
          _record['stage'] = 'saved';
          _record['retry_count'] = 0;
          _record['status'] = 'budget_resumed';
          await _save();
        }
      }
      if (_record['status'] == 'running') {
        _record['stage'] = 'saved';
        _record['retry_count'] = (_record['retry_count'] as int? ?? 0) + 1;
        if ((_record['retry_count'] as int) >= 3) {
          _record['terminal_code'] = 'profile_interrupted';
        }
        _record['status'] = 'interrupted';
        await _save();
      }
      _opened = true;
      if (manuallyPaused) phase = ProfileGenerationPhase.paused;
      for (final input in inputs) {
        input.addListener(wake);
      }
      progress?.addListener(_notify);
      if (autoSchedule) {
        WidgetsBinding.instance.addObserver(this);
        _foreground =
            WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState ==
                AppLifecycleState.resumed ||
            WidgetsBinding.instance.lifecycleState ==
                AppLifecycleState.inactive;
        _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) => wake());
      }
      wake();
    } catch (_) {
      phase = ProfileGenerationPhase.blocked;
      code = 'generation_state_unavailable';
      _notify();
    }
  }

  Future<void> _save() {
    final encoded = jsonEncode({'version': 1, ..._record});
    final next = _writes.then((_) => persistence.write(encoded));
    _writes = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  void wake() {
    if (_disposed || !_opened || !_foreground || !autoSchedule) return;
    _timer?.cancel();
    _timer = Timer(const Duration(milliseconds: 300), () => unawaited(poll()));
  }

  void _schedule() {
    if (_disposed || !_foreground || !autoSchedule) return;
    _timer?.cancel();
    final at = _record['next_at'] as int? ?? now().millisecondsSinceEpoch;
    final delay = Duration(
      milliseconds: math.max(300, at - now().millisecondsSinceEpoch),
    );
    _timer = Timer(delay, () => unawaited(poll()));
  }

  Future<void> poll() async {
    if (!_opened || _disposed || !_foreground || _checking) return;
    if (manuallyPaused) {
      phase = ProfileGenerationPhase.paused;
      _notify();
      return;
    }
    if (_record['requires_explicit_retry'] == true &&
        _record['terminal_code'] is String) {
      phase = ProfileGenerationPhase.blocked;
      code = _record['terminal_code'] as String;
      _notify();
      return;
    }
    if ((_record['terminal_code'] as String?)?.startsWith('profile_budget_') ==
        true) {
      phase = ProfileGenerationPhase.blocked;
      code = _record['terminal_code'] as String;
      _notify();
      return;
    }
    _checking = true;
    try {
      final snapshot = await inspect();
      if (_disposed || !_foreground || manuallyPaused) return;
      if (snapshot == null) {
        phase = ProfileGenerationPhase.waiting;
        code = null;
        _notify();
        return;
      }
      covered = snapshot.covered;
      total = snapshot.total;
      // Budget/storage failures do not become permission to spend on a new scope.
      if ((_record['terminal_code'] as String?)?.startsWith(
            'profile_budget_',
          ) ==
          true) {
        phase = ProfileGenerationPhase.blocked;
        code = _record['terminal_code'] as String;
        _notify();
        return;
      }
      if (_record['scope'] != snapshot.scope) {
        _record = {
          'scope': snapshot.scope,
          'stage': 'saved',
          'last_covered': snapshot.covered,
          'retry_count': 0,
        };
      }
      if (snapshot.complete) {
        _record['completed'] = true;
        phase = ProfileGenerationPhase.ready;
        code = null;
        _notify();
        return;
      }
      if (_record['terminal_code'] != null) {
        phase = ProfileGenerationPhase.blocked;
        code = _record['terminal_code'] as String;
        _notify();
        return;
      }
      final nextAt = _record['next_at'] as int? ?? 0;
      if (nextAt > now().millisecondsSinceEpoch) {
        phase = _record['error_code'] == null
            ? ProfileGenerationPhase.continuing
            : ProfileGenerationPhase.failed;
        code = _record['error_code'] as String?;
        _notify();
        _schedule();
        return;
      }
      _record['completed'] = false;
      final savedOnly = _record['stage'] == 'saved';
      final before = _record['last_covered'] as int? ?? 0;
      _record['status'] = 'running';
      // A process killed during a request cannot immediately replay on restart.
      _record['next_at'] = now()
          .add(const Duration(minutes: 2))
          .millisecondsSinceEpoch;
      await _save();
      if (_disposed || !_foreground || manuallyPaused) return;
      phase = ProfileGenerationPhase.working;
      code = null;
      _notify();
      try {
        await generate(
          savedObservationsOnly: savedOnly,
          maxNewBatches: savedOnly ? 0 : 4,
        );
        if (_disposed) return;
        final after = await inspect();
        if (_disposed) return;
        _record['stage'] = after?.pendingOutput == true ? 'saved' : 'collect';
        _record['retry_count'] = 0;
        _record.remove('error_code');
        _record['last_covered'] = math.max(before, processedRecords());
        if (after != null && after.scope == snapshot.scope) {
          covered = after.covered;
          total = after.total;
          _record['completed'] = after.complete;
        }
        phase = _record['completed'] == true
            ? ProfileGenerationPhase.ready
            : ProfileGenerationPhase.continuing;
        final publicationAdvanced =
            after != null &&
            after.scope == snapshot.scope &&
            (after.outputBatches > snapshot.outputBatches ||
                after.covered > snapshot.covered ||
                after.hasResult && !snapshot.hasResult);
        if (_record['completed'] != true &&
            processedRecords() <= before &&
            !publicationAdvanced) {
          final retries = (_record['no_progress_count'] as int? ?? 0) + 1;
          _record['no_progress_count'] = retries;
          _record['retry_count'] = retries;
          _record['error_code'] = code = 'profile_no_progress';
          if (retries >= 3) _record['terminal_code'] = code;
          phase = retries >= 3
              ? ProfileGenerationPhase.blocked
              : ProfileGenerationPhase.failed;
        } else {
          _record.remove('no_progress_count');
        }
        revision++;
      } catch (error) {
        if (_disposed) return;
        code = failureCode(error);
        final explicitRetry = error is ProfileGenerationTerminalFailure;
        final progressed = processedRecords() > before;
        _record['last_covered'] = math.max(before, processedRecords());
        if (!explicitRetry &&
            (savedOnly &&
                    {
                      'profile_no_saved_observations',
                      'profile_no_progress',
                      'profile_result_more_complete',
                    }.contains(code) ||
                progressed &&
                    {
                      'profile_round_no_observations',
                      'profile_result_more_complete',
                    }.contains(code))) {
          _record['stage'] = 'collect';
          // A cache-only probe is not a successful paid retry. Preserve the
          // failure count so network errors cannot alternate forever with misses.
          if (!savedOnly) _record['retry_count'] = 0;
          _record.remove('error_code');
          code = null;
          phase = ProfileGenerationPhase.continuing;
        } else if (!explicitRetry &&
            (manuallyPaused ||
                !_foreground &&
                    {'cancelled', 'profile_cancelled'}.contains(code))) {
          phase = manuallyPaused
              ? ProfileGenerationPhase.paused
              : ProfileGenerationPhase.continuing;
        } else {
          if (code != 'profile_no_progress') _record['stage'] = 'saved';
          final count = (_record['retry_count'] as int? ?? 0) + 1;
          _record['retry_count'] = count;
          _record['error_code'] = code;
          final terminal =
              explicitRetry ||
              code!.startsWith('profile_budget_') ||
              {
                'authorization_changed',
                'processing_not_allowed',
                'processing_consent_required',
                'local_host_required',
                'provider_changed',
                'model_required',
                'connector_unavailable',
                'source_expired',
                'profile_checkpoint_storage_full',
                'profile_selection_invalid',
                'profile_timeline_checkpoint_invalid',
                'profile_timeline_invalid',
                'profile_timeline_deferred',
                'profile_result_capacity',
                'profile_context_too_large',
              }.contains(code) ||
              count >= 3;
          if (terminal) {
            _record['terminal_code'] = code;
            if (explicitRetry) _record['requires_explicit_retry'] = true;
            if (code!.startsWith('profile_budget_') &&
                budgetLimitMicroyuan != null) {
              _record['budget_limit_microyuan'] = budgetLimitMicroyuan;
            }
          }
          phase = terminal
              ? ProfileGenerationPhase.blocked
              : ProfileGenerationPhase.failed;
        }
      }
      if (_disposed) return;
      if (pauseAfterRound) {
        _record['manual_pause'] = true;
        _record['stage'] = 'saved';
      }
      _record['status'] = manuallyPaused ? 'paused' : 'idle';
      if (manuallyPaused) phase = ProfileGenerationPhase.paused;
      final retries = _record['retry_count'] as int? ?? 0;
      _record['next_at'] = now()
          .add(
            retries == 0
                ? roundDelay
                : retryBase * (1 << math.min(retries - 1, 4)),
          )
          .millisecondsSinceEpoch;
      await _save();
      _notify();
      if (_record['completed'] != true &&
          _record['terminal_code'] == null &&
          !manuallyPaused) {
        _schedule();
      }
    } catch (error) {
      if (!_disposed) {
        phase = ProfileGenerationPhase.blocked;
        code = failureCode(error);
        if (code?.startsWith('profile_budget_') == true) {
          _record['terminal_code'] = code;
          if (budgetLimitMicroyuan != null) {
            _record['budget_limit_microyuan'] = budgetLimitMicroyuan;
          }
          _record['status'] = 'blocked';
          try {
            await _save();
          } catch (_) {
            /* No generation follows a storage failure. */
          }
        }
        _notify();
      }
    } finally {
      _checking = false;
    }
  }

  Future<void> pause() async {
    _record['manual_pause'] = true;
    _record['stage'] = 'saved';
    phase = ProfileGenerationPhase.paused;
    _timer?.cancel();
    cancel();
    _notify();
    try {
      await _save();
    } catch (_) {
      code = 'generation_state_unavailable';
    }
  }

  Future<void> retry() async {
    _record.remove('manual_pause');
    _record.remove('terminal_code');
    _record.remove('requires_explicit_retry');
    _record.remove('error_code');
    _record['retry_count'] = 0;
    _record['next_at'] = 0;
    phase = ProfileGenerationPhase.waiting;
    code = null;
    try {
      await _save();
      wake();
    } catch (_) {
      phase = ProfileGenerationPhase.blocked;
      code = 'generation_state_unavailable';
    }
    _notify();
  }

  void setForeground(bool value) {
    _foreground = value;
    if (!value) {
      _timer?.cancel();
      // Stop new rounds, but let an already paid bounded round finish and save.
    } else {
      wake();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) return;
    setForeground(state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _heartbeat?.cancel();
    cancel();
    for (final input in inputs) {
      input.removeListener(wake);
    }
    progress?.removeListener(_notify);
    if (autoSchedule) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
