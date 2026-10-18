import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import '../context/secure_persistence.dart';
import '../conversation/local_conversation_store.dart';
import '../personal/life_host.dart';
import 'agent_core_host.dart';
import 'background_execution.dart';
import 'model_settings.dart';
import 'tool_registry.dart';
import 'web_fetch.dart';
import 'schedule_repository.dart';
import 'schedule_time.dart';
import 'model_client.dart';
import 'schedule_wake.dart';

/// One app-owned scheduler and writer. OS wakeups call wake(), not a second loop.
class ScheduledAgentRunner extends ChangeNotifier with WidgetsBindingObserver {
  ScheduledAgentRunner(
    this.repository,
    this.life,
    this.models, {
    this.clientFactory,
  });
  final ScheduleRepository repository;
  final LifeHost life;
  final ModelSettings models;
  final ModelClient Function()? clientFactory;
  AgentCoreHost? _active;
  String? activeRun;
  ApprovalOffer? pendingApproval;
  Completer<bool>? _approval;
  Timer? _timer;
  bool _disposed = false;
  Future<void>? _wakeInFlight;
  bool foreground = true;
  String? wakeError;
  ScheduleWake? _nativeWake;
  bool headless = false;
  bool? _configured;
  Future<String> result(String runId) async {
    repository.run(runId); // Reject arbitrary storage-key reads.
    final raw = await SecureContextPersistence(
      'nova.schedule.task.$runId',
    ).read();
    if (raw == null) return '尚无持久化结果。';
    final data = jsonDecode(raw) as Map;
    final texts = (data['conversations'] as List)
        .expand((c) => c['messages'] as List)
        .where(
          (m) =>
              m['role'] == 'assistant' &&
              m['content'] is String &&
              (m['content'] as String).isNotEmpty,
        )
        .map((m) => m['content'] as String);
    return texts.isEmpty ? '尚无完整回答；请结合任务状态核对。' : texts.join('\n\n');
  }

  static Future<ScheduledAgentRunner> open(
    LifeHost life,
    ModelSettings models, {
    bool headless = false,
  }) async {
    final nativeWake = ScheduleWake();
    await nativeWake.acquire(headless: headless);
    try {
      await life.open();
      final repository = ScheduleRepository(
        const SecureContextPersistence('nova.local.schedules.v1'),
        deviceId: life.authority.localDeviceId,
        clock: ScheduleClock(),
      );
      await repository.open();
      final runner = ScheduledAgentRunner(repository, life, models);
      runner._nativeWake = nativeWake;
      runner.headless = headless;
      runner.start();
      await nativeWake.attach(runner.wake, runner.expire);
      return runner;
    } catch (_) {
      await nativeWake.release();
      rethrow;
    }
  }

  void start() {
    WidgetsBinding.instance.addObserver(this);
    repository.addListener(_changed);
    foreground =
        !headless &&
        (WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState ==
                AppLifecycleState.resumed);
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (foreground) unawaited(wake());
    });
    if (foreground) unawaited(wake());
  }

  void _changed() {
    final enabled = repository.items.any((item) => item['enabled'] == true);
    if (_configured != enabled) {
      _configured = enabled;
      unawaited(
        _nativeWake?.configure(enabled).catchError((Object _) {
              wakeError = '系统后台调度未启用，打开应用时仍会检查任务。';
            }) ??
            Future.value(),
      );
    }
    if (!_disposed) notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = !headless && state == AppLifecycleState.resumed;
    if (foreground) unawaited(wake());
  }

  Future<void> wake() {
    if (_disposed) return Future.value();
    return _wakeInFlight ??= _wake().whenComplete(() => _wakeInFlight = null);
  }

  Future<void> _wake() async {
    try {
      await repository.claimDue();
      for (final run in repository.runs.where(
        (r) => r['status'] == 'claimed',
      )) {
        if (_disposed) break;
        await _execute(run);
      }
      wakeError = null;
    } catch (_) {
      wakeError = '等待下次唤醒或打开应用后继续检查。';
    } finally {
      _changed();
    }
  }

  Future<void> _execute(Map<String, dynamic> run) async {
    final id = run['run_id'] as String,
        revision = run['control_revision'] as int,
        definition = run['definition'] as Map;
    final store = ConversationStore(
      SecureContextPersistence('nova.schedule.task.$id'),
    );
    await store.open();
    final journal = ToolJournal(
      SecureContextPersistence('nova.schedule.tools.$id'),
    );
    await journal.open();
    final taskId = await store.create();
    await repository.bindTask(id, taskId);
    final config = await models.read();
    if (config == null ||
        '${config.endpoint}|${config.model}' != definition['provider']) {
      await repository.checkpoint(
        id,
        revision,
        'failed',
        reason: 'provider_authorization_changed',
      );
      return;
    }
    final scopes = definition['context'] as Map;
    final registry = ToolRegistry(
      snapshot: life.snapshot,
      mutate: life.mutate,
      hasConflict: () => life.hasConflict,
      fetch: SafeWebFetch().fetch,
      allowedNames: {
        if (scopes['life'] == true) ...[
          'life.list',
          'life.get',
          if (!headless) ...['life.create', 'life.update'],
        ],
        if (scopes['web'] == true) 'web.fetch',
      },
    );
    final agent = AgentCoreHost(
      store: store,
      settings: models,
      tools: ToolRunner(registry: registry, journal: journal),
      backgroundExecution: BackgroundExecution(),
      clientFactory: clientFactory,
      beforeModel: (config) async {
        if ('${config.endpoint}|${config.model}' != definition['provider'] ||
            repository.run(id)['control_revision'] != revision) {
          throw StateError('authorization_changed');
        }
      },
    );
    _active = agent;
    activeRun = id;
    _changed();
    try {
      await repository.checkpoint(id, revision, 'running');
      await agent.send(
        taskId,
        'Scheduled task authorized by the user. Goal: ${definition['goal']}\nAcceptance: ${definition['acceptance']}\nReport what was actually observed or done. A denied action or unknown outcome is not success. Do not broaden the selected context or execution scope.',
        approve: (offer) async {
          await repository.checkpoint(id, revision, 'waiting_approval');
          pendingApproval = offer;
          _approval = Completer<bool>();
          _changed();
          if (!foreground) await _nativeWake?.notifyWaiting();
          final accepted = await _approval!.future.timeout(
            const Duration(minutes: 2),
            onTimeout: () => false,
          );
          _approval = null;
          pendingApproval = null;
          if (repository.run(id)['control_revision'] != revision) return false;
          await repository.checkpoint(id, revision, 'running');
          _changed();
          return accepted && foreground && !_disposed;
        },
      );
      if (repository.run(id)['control_revision'] != revision) return;
      await repository.checkpoint(
        id,
        revision,
        journal.hasUnresolved
            ? 'outcome_unknown'
            : agent.lastTurnCompleted
            ? 'completed'
            : 'failed',
        reason:
            agent.error ??
            (agent.lastTurnCompleted ? null : 'task_not_completed'),
      );
    } catch (_) {
      final current = repository.run(id);
      if (current['control_revision'] == revision &&
          ![
            'completed',
            'failed',
            'outcome_unknown',
          ].contains(current['status'])) {
        await repository.checkpoint(
          id,
          revision,
          'outcome_unknown',
          reason: 'interrupted',
        );
      }
    } finally {
      agent.dispose();
      _active = null;
      activeRun = null;
      pendingApproval = null;
      _approval = null;
      _changed();
    }
  }

  void approve(bool allow) {
    if (_approval != null && !_approval!.isCompleted) {
      _approval!.complete(allow && foreground);
    }
  }

  Future<void> cancel(String id, int revision) async {
    await repository.cancel(id, revision);
    if (activeRun == id) {
      approve(false);
      _active?.cancel();
    }
  }

  void expire() {
    approve(false);
    _active?.cancel();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    repository.removeListener(_changed);
    expire();
    unawaited(
      (_wakeInFlight ?? Future.value()).whenComplete(
        () => _nativeWake?.release() ?? Future.value(),
      ),
    );
    super.dispose();
  }
}
