import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import '../space/space_storage.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/background_execution.dart';
import '../agent_core/tool_registry.dart';
import '../agent_core/tool_owner.dart';
import '../personal/local_life.dart';
import '../protocol/request_id.dart';
import '../ui/reason_copy.dart';

class VoiceDelegateUpdate {
  const VoiceDelegateUpdate(
    this.id,
    this.conversationId,
    this.text, {
    required this.terminal,
  });
  final String id, conversationId, text;
  final bool terminal;
}

/// One independent execution lane; its durable conversations live in Tasks.
/// The call owns listening. Ending it never cancels delegated work.
class VoiceDelegateBridge extends ChangeNotifier {
  VoiceDelegateBridge({required this.primary, required this.worker}) {
    worker.addListener(_progress);
  }
  final AgentCoreHost primary, worker;
  final _updates = StreamController<VoiceDelegateUpdate>.broadcast();
  Stream<VoiceDelegateUpdate> get updates => _updates.stream;
  String? id, conversationId;
  String? _taskConversationId, _updateConversationId;
  String? get taskConversationId => _taskConversationId;
  String _lastProgress = '';
  String _language = 'zh';
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);
  bool _disposed = false, _cancelRequested = false;
  bool get busy => id != null;
  String get draft => worker.draft;
  String? get activeTool => worker.activeTool;

  bool ownsConversation(String conversation) => worker.store.conversations.any(
    (row) => row['id'] == conversation && row['delegate_origin'] is String,
  );

  AgentCoreHost hostForConversation(String conversation) =>
      ownsConversation(conversation) ? worker : primary;

  static Future<VoiceDelegateBridge> open(AgentCoreHost primary) async {
    final bridge = VoiceDelegateBridge(
      primary: primary,
      worker: AgentCoreHost(
        store: primary.store,
        settings: primary.settings,
        tools: primary.tools,
        experienceModel: primary.experienceModel,
        experiencePersona: primary.experiencePersona,
        additionalContext: primary.additionalContext,
        backgroundExecution: primary.backgroundExecution == null
            ? null
            : BackgroundExecution(),
        clientFactory: primary.clientFactory,
        allowLocalMemory: false,
        // Recall only: a delegated request can never authorize a save.
        memoryReadOnly: true,
        owner: '${ToolOwner.voice}:delegate',
      ),
    );
    try {
      await bridge._importLegacy();
      await bridge.reconcile();
      return bridge;
    } catch (_) {
      bridge.dispose();
      rethrow;
    }
  }

  Future<void> _importLegacy() async {
    final Map data;
    try {
      final directory = await SpaceStorage.directory();
      final raw = await FileLifePersistence(
        File('${directory.path}/voice-delegate-contexts-v1.json'),
      ).read();
      if (raw == null) {
        return;
      }
      data = jsonDecode(raw) as Map;
      if (data['schema_version'] != 1 || data['conversations'] is! List) {
        throw const FormatException('unsupported_delegate_schema');
      }
    } catch (_) {
      debugPrint('[VoiceDelegate] Skipped unreadable legacy contexts.');
      return;
    }
    final linked = <String, ({String origin, Map intent})>{};
    for (final conversation in primary.store.conversations) {
      for (final message in conversation['messages'] as List) {
        final context = message['delegate_context'];
        if (context is String && message['delegate_id'] is String) {
          linked[context] = (
            origin: conversation['id'] as String,
            intent: message as Map,
          );
        }
      }
    }
    for (final source in data['conversations'] as List) {
      try {
        if (source is! Map) {
          throw const FormatException('invalid_delegate_context');
        }
        final link = linked[source['id']];
        if (link == null) {
          continue;
        }
        await primary.store.importDelegateTask(
          Map<String, dynamic>.from(source),
          origin: link.origin,
          task: link.intent['delegate_id'] as String,
          status: link.intent['delegate_status'] is String
              ? link.intent['delegate_status'] as String
              : 'returned',
          language: link.intent['delegate_language'] is String
              ? link.intent['delegate_language'] as String
              : 'zh',
        );
      } catch (_) {
        debugPrint('[VoiceDelegate] Skipped invalid legacy context.');
      }
    }
    // The old file remains intact, including unlinked recovery contexts.
  }

  /// Repair saved projections without ever replaying interrupted execution.
  Future<void> reconcile() async {
    if (busy || worker.busy) {
      throw StateError('delegate_busy');
    }
    for (final row in worker.store.conversations) {
      if (row['delegate_origin'] is! String ||
          row['delegate_status'] != 'dispatched') {
        continue;
      }
      final linked = primary.store.conversations.any(
        (origin) =>
            origin['id'] == row['delegate_origin'] &&
            (origin['messages'] as List).any(
              (message) =>
                  message['delegate_id'] == row['delegate_id'] &&
                  message['delegate_context'] == row['id'],
            ),
      );
      if (!linked) {
        await worker.store.delegateStatus(
          row['id'] as String,
          row['delegate_id'] as String,
          'process_interrupted_unknown',
        );
      }
    }
    for (final conversation in primary.store.conversations) {
      final messages = conversation['messages'] as List;
      for (final intent in messages.where(
        (m) => m['delegate_status'] == 'dispatched',
      )) {
        final task = intent['delegate_id'];
        if (task is! String) {
          continue;
        }
        final language = intent['delegate_language'] is String
            ? intent['delegate_language'] as String
            : 'zh';
        if (messages.any(
          (m) =>
              m['delegate_id'] == task && m['delegate_status'] != 'dispatched',
        )) {
          continue;
        }
        final context = worker.store.conversations
            .where((c) => c['id'] == intent['delegate_context'])
            .firstOrNull;
        final workerMessages = context?['messages'] as List? ?? <dynamic>[];
        final saved = workerMessages
            .where((m) => m['delegate_result'] == task)
            .toList();
        // A continuation must not recover an earlier run's final answer.
        final current = context?['delegate_id'] == task;
        final candidates = context?['delegate_id'] != null && !current
            ? <dynamic>[]
            : current &&
                  context?['delegate_start_index'] is int &&
                  (context!['delegate_start_index'] as int) >= 0
            ? workerMessages
                  .skip(context['delegate_start_index'] as int)
                  .toList()
            : workerMessages
                  .where(
                    (m) =>
                        (m['time'] as String).compareTo(
                          intent['time'] as String,
                        ) >=
                        0,
                  )
                  .toList();
        final last = candidates.lastOrNull;
        final result = saved.isNotEmpty
            ? saved.last
            : last != null &&
                  last['role'] == 'assistant' &&
                  last['tool_calls'] == null &&
                  last['interrupted'] != true &&
                  (last['content'] as String).isNotEmpty
            ? last
            : null;
        final savedStatus = result?['delegate_status'];
        final status = result == null
            ? 'process_interrupted_unknown'
            : savedStatus is String
            ? savedStatus
            : 'returned';
        final text =
            result?['content'] as String? ??
            (language == 'en'
                ? 'Task execution was interrupted. Its outcome is unknown; it will not be retried automatically.'
                : '任务执行已中断，操作结果未知；不会自动重试。');
        if (context != null && context['delegate_origin'] != null) {
          await worker.store.delegateStatus(
            context['id'] as String,
            task,
            status,
          );
        }
        await primary.store.append(conversation['id'] as String, {
          'role': 'assistant',
          'content': _summary(text, language),
          'delegate_id': task,
          'delegate_context': intent['delegate_context'],
          if (intent['delegate_language'] != null)
            'delegate_language': language,
          'delegate_status': status,
        }, external: true);
      }
    }
  }

  Future<void> clearConversationContext(String conversation) async {
    if (busy || worker.busy) {
      throw StateError('delegate_busy');
    }
    if (identical(primary.store, worker.store)) {
      return;
    }
    final contexts =
        (primary.store.conversation(conversation)['messages'] as List)
            .map((message) => message['delegate_context'])
            .whereType<String>()
            .toSet();
    for (final context in contexts) {
      if (worker.store.conversations.any((c) => c['id'] == context)) {
        await worker.store.clearConversation(context);
      }
    }
  }

  Future<String> start({
    required String conversation,
    required String callId,
    required String request,
    String language = 'zh',
  }) async {
    final context = ownsConversation(conversation) ? conversation : null;
    final origin = context == null
        ? conversation
        : worker.store.conversation(context)['delegate_origin'] as String;
    return _dispatch(
      origin: origin,
      callId: callId,
      request: request,
      language: language,
      context: context,
      updateConversation: conversation,
    );
  }

  Future<void> continueTask(
    String conversation,
    String text, {
    ToolApproval? approve,
    String? language,
    bool userAuthored = true,
  }) async {
    if (!ownsConversation(conversation)) {
      throw StateError('delegate_task_missing');
    }
    final row = worker.store.conversation(conversation);
    await _dispatch(
      origin: row['delegate_origin'] as String,
      callId: requestId(),
      request: text,
      language: language ?? row['delegate_language'] as String? ?? 'zh',
      context: conversation,
      approve: approve,
      userAuthored: userAuthored,
      wait: true,
      updateConversation: conversation,
    );
  }

  Future<String> _dispatch({
    required String origin,
    required String callId,
    required String request,
    required String language,
    String? context,
    ToolApproval? approve,
    bool userAuthored = false,
    bool wait = false,
    required String updateConversation,
  }) async {
    if (_disposed || busy || worker.busy || primary.busy) {
      throw StateError('delegate_busy');
    }
    if (request.trim().isEmpty || request.length > 8000) {
      throw ArgumentError('invalid_delegate');
    }
    final history = primary.store.conversation(origin)['messages'] as List;
    if (history.any((m) => m['voice_delegate_call'] == callId)) {
      throw StateError('delegate_already_dispatched');
    }
    final taskLanguage = language == 'zh' ? 'zh' : 'en';
    final task = id = requestId();
    _cancelRequested = false;
    conversationId = origin;
    _updateConversationId = updateConversation;
    _language = taskLanguage;
    _lastProgress = '';
    _lastSent = DateTime.fromMillisecondsSinceEpoch(0);
    notifyListeners();
    try {
      final child = await worker.store.delegateTask(
        origin: origin,
        task: task,
        request: request,
        language: taskLanguage,
        context: context,
      );
      _taskConversationId = child;
      await primary.store.append(origin, {
        'role': 'assistant',
        'content': taskLanguage == 'zh'
            ? (context == null ? '已创建任务，正在处理。' : '任务已继续处理。')
            : (context == null
                  ? 'Created a task and started working.'
                  : 'Continued the task.'),
        'voice_delegate_call': callId,
        'delegate_id': task,
        'delegate_status': 'dispatched',
        'delegate_context': child,
        'request': request,
        'delegate_language': taskLanguage,
      }, external: true);
      notifyListeners();
      final execution = _run(
        task,
        origin,
        child,
        request,
        taskLanguage,
        approve: approve,
        userAuthored: userAuthored,
        updateConversation: updateConversation,
      );
      if (wait) {
        await execution;
      } else {
        unawaited(execution);
      }
      return task;
    } catch (_) {
      final child = _taskConversationId;
      if (child != null) {
        try {
          await worker.store.delegateStatus(child, task, 'failed');
        } catch (_) {
          // Startup reconciliation accounts for a failed dispatch receipt.
        }
      }
      id = null;
      conversationId = null;
      _taskConversationId = null;
      _updateConversationId = null;
      if (!_disposed) notifyListeners();
      rethrow;
    }
  }

  String _summary(String text, String language) {
    final characters = text.runes;
    if (characters.length <= 600) {
      return text;
    }
    return '${String.fromCharCodes(characters.take(600)).trimRight()}\n… ${language == 'zh' ? '完整结果见任务。' : 'See the task for the full result.'}';
  }

  Future<void> _run(
    String task,
    String conversation,
    String context,
    String request,
    String language, {
    ToolApproval? approve,
    required bool userAuthored,
    required String updateConversation,
  }) async {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    var result = t(
      '任务结果保存失败，请核对现有操作；不会自动重试。',
      'The task result could not be saved. Check the existing action; it will not be retried automatically.',
    );
    try {
      final before =
          (worker.store.conversation(context)['messages'] as List).length;
      final cancelledBeforeStart = _cancelRequested;
      if (!cancelledBeforeStart) {
        await worker.send(
          context,
          request,
          userAuthored: userAuthored,
          language: language,
          approve:
              approve ??
              (ApprovalOffer _) async =>
                  worker.tools?.registry.automaticExecution == true,
        );
      }
      final messages = worker.store.conversation(context)['messages'] as List;
      final finals = messages
          .skip(before)
          .where(
            (m) =>
                m['role'] == 'assistant' &&
                m['tool_calls'] == null &&
                (m['content'] as String).isNotEmpty,
          );
      result = finals.isNotEmpty ? finals.last['content'] as String : '';
      if (cancelledBeforeStart) {
        result = t('任务已停止，未开始执行。', 'Task stopped before execution started.');
      } else if (worker.error != null) {
        final detail = worker.errorDetail;
        final reason = reasonCopy(
          detail != null && hasReasonCopy(detail) ? detail : worker.error,
          language: language,
        );
        result =
            '$result\n${t('任务状态', 'Task status')}: ${t('未完成', 'not completed')} — $reason';
      }
      if (result.trim().isEmpty) {
        result = t(
          '任务已停止；没有可确认的完成结果。',
          'The task stopped without a confirmed completion result.',
        );
      }
      final status = cancelledBeforeStart
          ? 'cancelled'
          : worker.error ?? 'returned';
      await worker.store.finishDelegateTask(
        context,
        task,
        result: result,
        status: status,
        language: language,
        origin: conversation,
        finalTime: finals.isEmpty ? null : finals.last['time'] as String,
      );
      result = _summary(result, language);
      await primary.store.append(conversation, {
        'role': 'assistant',
        'content': result,
        'delegate_context': context,
        'delegate_id': task,
        'delegate_language': language,
        'delegate_status': status,
      }, external: true);
    } catch (_) {
      result = t(
        '任务结果保存失败，请核对现有操作；不会自动重试。',
        'The task result could not be saved. Check the existing action; it will not be retried automatically.',
      );
    } finally {
      id = null;
      conversationId = null;
      _taskConversationId = null;
      _updateConversationId = null;
      if (!_disposed) {
        _updates.add(
          VoiceDelegateUpdate(task, updateConversation, result, terminal: true),
        );
        notifyListeners();
      }
    }
  }

  void _progress() {
    if (_disposed || id == null || conversationId == null) {
      return;
    }
    notifyListeners();
    final text = worker.activeTool != null
        ? (_language == 'zh'
              ? '正在调用 ${worker.activeTool}'
              : 'Using ${worker.activeTool}')
        : worker.draft;
    if (text.isEmpty ||
        text == _lastProgress ||
        DateTime.now().difference(_lastSent) < const Duration(seconds: 3)) {
      return;
    }
    _lastProgress = text;
    _lastSent = DateTime.now();
    _updates.add(
      VoiceDelegateUpdate(
        id!,
        _updateConversationId ?? conversationId!,
        text,
        terminal: false,
      ),
    );
  }

  void cancel(String taskId) {
    if (id == taskId) {
      _cancelRequested = true;
      worker.cancel();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    worker.removeListener(_progress);
    worker.dispose();
    unawaited(_updates.close());
    super.dispose();
  }
}
