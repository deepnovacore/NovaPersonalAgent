import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/tool_registry.dart';
import '../conversation/local_conversation_store.dart';
import '../personal/local_life.dart';
import '../protocol/request_id.dart';

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

/// One backbrain lane, isolated durable tool context, shared execution journal.
/// The call owns listening; this application-owned lane owns delegated work.
class VoiceDelegateBridge extends ChangeNotifier {
  VoiceDelegateBridge({required this.primary, required this.worker}) {
    worker.addListener(_progress);
  }
  final AgentCoreHost primary, worker;
  final _updates = StreamController<VoiceDelegateUpdate>.broadcast();
  Stream<VoiceDelegateUpdate> get updates => _updates.stream;
  String? id, conversationId;
  String _lastProgress = '';
  String _language = 'zh';
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);
  bool _disposed = false;
  bool get busy => id != null;
  String get draft => worker.draft;
  String? get activeTool => worker.activeTool;

  static Future<VoiceDelegateBridge> open(AgentCoreHost primary) async {
    final directory = await getApplicationSupportDirectory();
    final store = ConversationStore(
      FileLifePersistence(
        File('${directory.path}/voice-delegate-contexts-v1.json'),
      ),
    );
    await store.open();
    final bridge = VoiceDelegateBridge(
      primary: primary,
      worker: AgentCoreHost(
        store: store,
        settings: primary.settings,
        tools: primary.tools,
        // A separate Dart HTTP client avoids the iOS singleton stream handler.
      ),
    );
    await bridge.reconcile();
    return bridge;
  }

  /// Repair the public projection from durable worker context without execution.
  Future<void> reconcile() async {
    for (final conversation in primary.store.conversations) {
      final messages = conversation['messages'] as List;
      for (final intent in messages.where(
        (m) => m['delegate_status'] == 'dispatched',
      )) {
        final task = intent['delegate_id'];
        if (messages.any(
          (m) =>
              m['delegate_id'] == task && m['delegate_status'] != 'dispatched',
        )) {
          continue;
        }
        final contexts = worker.store.conversations.where(
          (c) => c['id'] == intent['delegate_context'],
        );
        final workerMessages = contexts.isEmpty
            ? <dynamic>[]
            : contexts.first['messages'] as List;
        final saved = workerMessages
            .where((m) => m['delegate_result'] == task)
            .toList();
        final last = workerMessages.isEmpty ? null : workerMessages.last;
        // Earlier assistant prose may precede a tool whose outcome is unknown.
        // Only an explicit result or a final trailing assistant can be recovered.
        final result = saved.isNotEmpty
            ? saved.last
            : last != null &&
                  last['role'] == 'assistant' &&
                  last['tool_calls'] == null &&
                  last['interrupted'] != true &&
                  (last['content'] as String).isNotEmpty
            ? last
            : null;
        await primary.store.append(conversation['id'] as String, {
          'role': 'assistant',
          'content':
              result?['content'] ??
              (intent['delegate_language'] == 'en'
                  ? 'The app exited before the task finished. Its outcome is unknown; it will not be retried automatically.'
                  : '任务因应用退出而中断，操作结果未知；不会自动重试。'),
          'delegate_id': task,
          'delegate_context': intent['delegate_context'],
          if (intent['delegate_language'] != null)
            'delegate_language': intent['delegate_language'],
          'delegate_status': result == null
              ? 'process_interrupted_unknown'
              : result['delegate_status'] ?? 'returned',
        });
      }
    }
  }

  Future<String> start({
    required String conversation,
    required String callId,
    required String request,
    String language = 'zh',
  }) async {
    if (_disposed || busy || primary.busy) throw StateError('delegate_busy');
    if (request.trim().isEmpty || request.length > 8000) {
      throw ArgumentError('invalid_delegate');
    }
    final existing =
        (primary.store.conversation(conversation)['messages'] as List)
            .where((m) => m['voice_delegate_call'] == callId)
            .firstOrNull;
    if (existing != null) throw StateError('delegate_already_dispatched');
    // Capture the call language for this task, including background completion.
    final taskLanguage = language == 'zh' ? 'zh' : 'en';
    _language = taskLanguage;
    final task = id = requestId();
    conversationId = conversation;
    _lastProgress = '';
    notifyListeners();
    try {
      final history =
          primary.store.conversation(conversation)['messages'] as List;
      final previous = history.reversed
          .map((message) => message['delegate_context'])
          .whereType<String>()
          .firstOrNull;
      // Follow-ups need the same tool receipts; other chats keep separate contexts.
      final context =
          previous != null &&
              worker.store.conversations.any((c) => c['id'] == previous)
          ? previous
          : await worker.store.create();
      // Durable association before execution. Recovered intents are never replayed.
      await primary.store.append(conversation, {
        'role': 'assistant',
        'content': '',
        'voice_delegate_call': callId,
        'delegate_id': task,
        'delegate_status': 'dispatched',
        'delegate_context': context,
        'request': request,
        'delegate_language': taskLanguage,
      });
      unawaited(_run(task, conversation, context, request, taskLanguage));
      return task;
    } catch (_) {
      id = null;
      conversationId = null;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> _run(
    String task,
    String conversation,
    String context,
    String request,
    String language,
  ) async {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    String result;
    try {
      final before =
          (worker.store.conversation(context)['messages'] as List).length;
      // The same registered tool policy controls writes; no blanket bypass.
      await worker.send(
        context,
        request,
        language: language,
        approve: (ApprovalOffer _) async =>
            worker.tools?.registry.automaticExecution == true,
      );
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
      if (worker.error != null) {
        result = '$result\n${t('任务状态', 'Task status')}: ${worker.error}';
      }
      if (result.trim().isEmpty) {
        result = t(
          '任务已停止；没有可确认的完成结果。',
          'The task stopped without a confirmed completion result.',
        );
      }
      await worker.store.append(context, {
        'role': 'assistant',
        'content': result,
        'delegate_result': task,
        'delegate_language': language,
        'delegate_status': worker.error ?? 'returned',
        'delegate_origin': conversation,
      });
      await primary.store.append(conversation, {
        'role': 'assistant',
        'content': result,
        'delegate_context': context,
        'delegate_id': task,
        'delegate_language': language,
        'delegate_status': worker.error ?? 'returned',
      });
    } catch (_) {
      result = t(
        '任务结果保存失败，请核对现有操作；不会自动重试。',
        'The task result could not be saved. Check the existing action; it will not be retried automatically.',
      );
    }
    if (!_disposed) {
      _updates.add(
        VoiceDelegateUpdate(task, conversation, result, terminal: true),
      );
    }
    id = null;
    conversationId = null;
    if (!_disposed) notifyListeners();
  }

  void _progress() {
    if (_disposed || id == null || conversationId == null) return;
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
      VoiceDelegateUpdate(id!, conversationId!, text, terminal: false),
    );
  }

  void cancel(String taskId) {
    if (id == taskId) worker.cancel();
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
