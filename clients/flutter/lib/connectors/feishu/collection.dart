import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';
import '../../personal/local_life.dart';
import '../../agent_core/background_execution.dart';
import 'api.dart';
import 'ingest.dart';

/// App-owned collection; routes only observe it. Every page commits its cursor.
class FeishuCollection extends ChangeNotifier with WidgetsBindingObserver {
  FeishuCollection(this.ingest, {BackgroundExecution? execution, this.intent})
    : execution = execution ?? BackgroundExecution();
  final FeishuIngest ingest;
  final BackgroundExecution execution;
  final LifePersistence? intent;
  Future<void> _intentTail = Future.value();
  Future<void> _saveIntent(Object? value) {
    final result = _intentTail.then(
      (_) async => intent?.write(jsonEncode(value)),
    );
    _intentTail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  Future<void> _saveScan() => _saveIntent({
    'identity': _identity,
    'generation': _generation,
    'authorization_epoch': _authorizationEpoch,
    'chat': _single,
    'all': _allAccessible,
    'selected': _selected,
    'pending': _pending == null ? null : List<String>.from(_pending!),
    'head_pending': _headPending == null
        ? null
        : List<String>.from(_headPending!),
    'head_checked_at': _headCheckedAt?.toUtc().toIso8601String(),
    'pages': pages,
    'completed': completed,
    'total': total,
    'failures': failures,
  });

  bool? _allAccessible;
  List<String> _selected = [];
  bool get _sameAuthorization =>
      ingest.auth.authorized &&
      ingest.auth.identityKey == _identity &&
      ingest.auth.generation == _generation &&
      ingest.auth.authorizationEpoch == _authorizationEpoch &&
      ingest.sources.allAccessible == _allAccessible &&
      (_allAccessible == true ||
          ingest.sources.sources.join('|') == _selected.join('|'));

  Future<void> restore() async {
    final raw = await intent?.read();
    if (raw == null || raw == 'null') return;
    final value = jsonDecode(raw) as Map;
    _identity = value['identity'] as String?;
    _generation = value['generation'] as int?;
    _authorizationEpoch =
        value['authorization_epoch'] as int? ?? ingest.auth.authorizationEpoch;
    _single = value['chat'] as String?;
    _allAccessible = value['all'] as bool?;
    _selected = (value['selected'] as List).cast<String>();
    if (!_sameAuthorization) {
      await _saveIntent(null);
      return;
    }
    if (value['pending'] is List) {
      _pending = (value['pending'] as List).cast<String>();
      pages = value['pages'] as int? ?? 0;
      completed = value['completed'] as int? ?? 0;
      total = value['total'] as int? ?? 0;
      failures = value['failures'] as int? ?? 0;
    }
    _headPending = (value['head_pending'] as List?)?.cast<String>();
    _headCheckedAt = DateTime.tryParse(
      value['head_checked_at'] as String? ?? '',
    );
    pausedBySystem = true;
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
    if (WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
      unawaited(start(chat: _single));
    }
  }

  final List<Map<String, dynamic>> chats = [];
  bool running = false, pausedBySystem = false;
  bool _stop = false, _disposed = false, _observing = false;
  bool _resumeQueued = false;
  List<String>? _pending;
  List<String>? _headPending;
  DateTime? _headCheckedAt;
  Future<void>? _flight;
  Object? error;
  int pages = 0, completed = 0, total = 0, failures = 0;
  bool discovering = false;
  String? _single;
  String? _identity;
  int? _generation;
  int? _authorizationEpoch;

  String get status => discovering
      ? '正在查找可访问的对话…'
      : total == 0
      ? '准备好后，读取可访问的历史消息。'
      : '本次完成 $completed / $total 个对话 · 已保存 $pages 页'
            '${failures > 0 ? ' · $failures 个读取失败' : ''}'
            '${pausedBySystem ? ' · 等待回到前台继续' : ''}';

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start({String? chat}) {
    if (_disposed) return Future.value();
    if (_flight != null) return _flight!;
    if (!_sameAuthorization || _single != chat) {
      _pending = null;
      _headPending = null;
      _headCheckedAt = null;
    }
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
    _single = chat;
    _identity = ingest.auth.identityKey;
    _generation = ingest.auth.generation;
    _authorizationEpoch = ingest.auth.authorizationEpoch;
    _allAccessible = ingest.sources.allAccessible;
    _selected = ingest.sources.sources;
    return _flight = _run(chat).whenComplete(() {
      _flight = null;
      if (_resumeQueued &&
          _sameAuthorization &&
          pausedBySystem &&
          !_disposed &&
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        unawaited(start(chat: _single));
      }
    });
  }

  void pause() {
    _stop = true;
    pausedBySystem = false;
    unawaited(_saveIntent(null).catchError((Object _) {}));
    _notify();
  }

  bool get _valid => !_disposed && !_stop && _sameAuthorization;

  Future<void> _readHeads(String? chat, {bool resume = false}) async {
    final due =
        _headCheckedAt == null ||
        ingest.now().difference(_headCheckedAt!) >= const Duration(seconds: 61);
    if (!due && (!resume || _headPending == null)) return;
    if (due) {
      _headPending ??= [];
      for (final id in chat == null ? ingest.sources.sources : [chat]) {
        final saved = ingest.sources.checkpoint(id);
        if (saved['paused'] != true &&
            (saved['read_through'] != null || saved['window_end'] != null) &&
            !_headPending!.contains(id)) {
          _headPending!.add(id);
        }
      }
      await _saveScan();
    }
    final readPages = <String, int>{};
    while (_headPending?.isNotEmpty == true && _valid) {
      final index = _headPending!.indexWhere((id) => (readPages[id] ?? 0) < 2);
      if (index < 0) break;
      final id = _headPending![index];
      try {
        final more = await ingest.page(id, head: true);
        _headPending!.removeAt(index);
        readPages[id] = (readPages[id] ?? 0) + 1;
        pages++;
        if (more) _headPending!.add(id);
        await execution.progress(pages, 'feishu');
      } on FeishuFailure catch (e) {
        if (e.code != 'resource_unavailable') rethrow;
        _headPending!.removeAt(index);
        failures++;
      }
      if (!_stop || pausedBySystem || _disposed) await _saveScan();
      _notify();
    }
    if (_headPending?.isEmpty == true) _headPending = null;
    _headCheckedAt = ingest.now();
    if (!_stop || pausedBySystem || _disposed) await _saveScan();
  }

  Future<void> _run(String? chat) async {
    _resumeQueued = false;
    running = true;
    _stop = false;
    pausedBySystem = false;
    error = null;
    if (_pending == null) {
      pages = 0;
      completed = 0;
      failures = 0;
      _headPending = null;
      _headCheckedAt = null;
    }
    _notify();
    try {
      await _saveScan();
      await execution.begin(() {
        if (!_disposed && running && !_stop) {
          pausedBySystem = true;
          _stop = true;
          _notify();
        }
      });
      if (!_valid) return;
      await ingest.sources.prune();
      if (!_valid) return;
      if (_pending == null && chat == null && ingest.sources.allAccessible) {
        discovering = true;
        _notify();
        final found = await ingest.discoverAll(stopped: () => !_valid);
        if (!_valid) return;
        await ingest.selectAccessible(found);
        chats
          ..clear()
          ..addAll(found.chats);
      }
      discovering = false;
      final pending =
          _pending ??
          (chat == null
              ? ingest.sources.sources
                    .where(
                      (id) => ingest.sources.checkpoint(id)['paused'] != true,
                    )
                    .toList()
              : [chat]);
      if (_pending == null) {
        // Legacy intents lack a queue: reach unfinished history before polling
        // chats whose previous windows already completed.
        int priority(String id) {
          final saved = ingest.sources.checkpoint(id);
          return saved['page_token'] != null
              ? 0
              : saved['read_through'] == null
              ? 1
              : 2;
        }

        pending.sort((a, b) => priority(a).compareTo(priority(b)));
        total = pending.length;
      }
      _pending = pending;
      await _saveScan();
      await _readHeads(chat, resume: true);
      // Bound live pages, then let history progress; long foreground scans
      // revisit completed chats too instead of waiting for all history to end.
      while ((pending.isNotEmpty || _headPending?.isNotEmpty == true) &&
          _valid) {
        await _readHeads(chat, resume: pending.isEmpty);
        if (!_valid) break;
        if (pending.isEmpty) continue;
        final id = pending.first;
        try {
          final more = await ingest.page(id);
          pending.removeAt(0);
          pages++;
          if (more) {
            pending.add(id);
          } else {
            completed++;
          }
          await execution.progress(pages, 'feishu');
        } on FeishuFailure catch (e) {
          if (e.code != 'resource_unavailable') rethrow;
          pending.removeAt(0);
          failures++;
        }
        // SourceStore committed this page before the scan advances its queue.
        // A crash between writes can replay one cursor, never skip a page.
        if (!_stop || pausedBySystem || _disposed) await _saveScan();
        _notify();
      }
    } catch (e) {
      if (!_stop) error = e;
      if (!_stop &&
          !_disposed &&
          _sameAuthorization &&
          WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed &&
          (e is PlatformException ||
              e is FeishuFailure &&
                  [
                    'network_timeout',
                    'network_unreachable',
                    'http_transport_failed',
                    'network_or_response_error',
                  ].contains(e.code))) {
        pausedBySystem = true;
      }
    } finally {
      discovering = false;
      if (_pending?.isEmpty == true && _headPending == null && error == null) {
        _pending = null;
        pausedBySystem = false;
      }
      await execution.end(
        success:
            error == null &&
            _headPending == null &&
            completed == total &&
            failures == 0,
      );
      running = false;
      if (!pausedBySystem &&
          !_disposed &&
          (error == null || !_sameAuthorization)) {
        await _saveIntent(null).catchError((Object _) {});
      }
      _notify();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed &&
        pausedBySystem &&
        !_disposed &&
        _sameAuthorization) {
      if (_flight == null) {
        unawaited(start(chat: _single));
      } else {
        _resumeQueued = true;
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _stop = true;
    if (_observing) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
