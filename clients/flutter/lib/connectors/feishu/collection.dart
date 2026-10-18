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

  bool? _allAccessible;
  List<String> _selected = [];
  bool get _sameAuthorization =>
      ingest.auth.authorized &&
      ingest.auth.identityKey == _identity &&
      ingest.auth.generation == _generation &&
      ingest.sources.allAccessible == _allAccessible &&
      (_allAccessible == true ||
          ingest.sources.sources.join('|') == _selected.join('|'));

  Future<void> restore() async {
    final raw = await intent?.read();
    if (raw == null || raw == 'null') return;
    final value = jsonDecode(raw) as Map;
    _identity = value['identity'] as String?;
    _generation = value['generation'] as int?;
    _single = value['chat'] as String?;
    _allAccessible = value['all'] as bool?;
    _selected = (value['selected'] as List).cast<String>();
    if (!_sameAuthorization) {
      await _saveIntent(null);
      return;
    }
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
  Future<void>? _flight;
  Object? error;
  int pages = 0, completed = 0, total = 0, failures = 0;
  bool discovering = false;
  String? _single;
  String? _identity;
  int? _generation;

  String get status => discovering
      ? '正在查找可访问的对话…'
      : total == 0
      ? '准备好后，继续同步最近的消息。'
      : '本次完成 $completed / $total 个对话 · 已保存 $pages 页'
            '${failures > 0 ? ' · $failures 个读取失败' : ''}'
            '${pausedBySystem ? ' · 等待回到前台继续' : ''}';

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start({String? chat}) {
    if (_disposed) return Future.value();
    if (_flight != null) return _flight!;
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
    _single = chat;
    _identity = ingest.auth.identityKey;
    _generation = ingest.auth.generation;
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

  bool get _valid =>
      !_disposed &&
      !_stop &&
      ingest.auth.identityKey == _identity &&
      ingest.auth.generation == _generation;

  Future<void> _run(String? chat) async {
    _resumeQueued = false;
    running = true;
    _stop = false;
    pausedBySystem = false;
    error = null;
    pages = 0;
    completed = 0;
    failures = 0;
    _notify();
    try {
      await _saveIntent({
        'identity': _identity,
        'generation': _generation,
        'chat': chat,
        'all': _allAccessible,
        'selected': _selected,
      });
      await execution.begin(() {
        if (!_disposed && running && !_stop) {
          pausedBySystem = true;
          _stop = true;
          _notify();
        }
      });
      if (!_valid) return;
      if (chat == null && ingest.sources.allAccessible) {
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
      final pending = chat == null
          ? ingest.sources.sources
                .where((id) => ingest.sources.checkpoint(id)['paused'] != true)
                .toList()
          : [chat];
      total = pending.length;
      while (pending.isNotEmpty && _valid) {
        final id = pending.removeAt(0);
        try {
          final more = await ingest.page(id);
          pages++;
          if (more) {
            pending.add(id);
          } else {
            completed++;
          }
          await execution.progress(pages, 'feishu');
        } on FeishuFailure catch (e) {
          if (e.code != 'resource_unavailable') rethrow;
          failures++;
        }
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
      await execution.end(
        success: !_stop && error == null && completed == total && failures == 0,
      );
      running = false;
      if (!pausedBySystem && !_disposed) {
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
