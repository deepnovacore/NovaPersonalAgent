import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import '../agent/hub_tasks.dart';
import '../agent/life_tool_bridge.dart';
import '../agent/local_agent.dart';
import 'hub_transport.dart';
import 'life_sync_scheduler.dart';
import 'local_life.dart';
import 'personal_store.dart';

abstract interface class LifeAccess {
  Map<String, dynamic> snapshot();
  Future<Map<String, dynamic>> mutate(
    Map<String, dynamic> input, {
    required String operationId,
  });
  bool get hasConflict;
  Listenable get changes;
}

/// One app-owned writer, independent of the selected page or computer session.
class LifeHost extends ChangeNotifier
    with WidgetsBindingObserver
    implements LifeAccess {
  LifeHost({LocalLife? repository}) : _provided = repository;
  final LocalLife? _provided;
  final _secrets = const FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  LocalLife? repo;
  PersonalStore? store;
  LifeSyncScheduler? _scheduler;
  LifeToolBridge? _bridge;
  HubTasks? _tasks;
  Future<void>? _opening;
  Future<void> _tail = Future.value();
  bool _disposed = false, busy = false;
  String? error, _url, _token;
  DateTime? lastSync;
  bool get hubConfigured => _url != null && _token != null;
  @override
  bool get hasConflict => repo?.conflict != null;
  @override
  Listenable get changes => this;

  void _checkActive() {
    if (_disposed) throw StateError('life_host_disposed');
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> open() {
    _checkActive();
    return _opening ??= _open();
  }

  Future<void> _open() async {
    try {
      final local =
          _provided ??
          LocalLife(
            FileLifePersistence(
              File(
                '${(await getApplicationSupportDirectory()).path}/local-life-v1.json',
              ),
            ),
          );
      if (_disposed) {
        local.dispose();
        return;
      }
      repo = local;
      if (!local.ready) await local.open();
      _checkActive();
      store = PersonalStore(send: (_) => false, local: local);
      local.addListener(_changed);
      if (Platform.isIOS) _bridge = LifeToolBridge(local)..attach();
      WidgetsBinding.instance.addObserver(this);
      final credentials = await _secrets.read(
        key: 'nova.local.hub.credentials',
      );
      if (credentials != null) {
        final pair = jsonDecode(credentials) as Map;
        _url = pair['url'] as String;
        _token = pair['token'] as String;
      } else {
        _url = await _secrets.read(key: 'nova.local.hub.url');
        _token = await _secrets.read(key: 'nova.local.hub.token');
      }
      _checkActive();
      _scheduler = LifeSyncScheduler(sync: sync, onError: (_) {});
      _scheduler!.setForeground(
        WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
      );
      _notify();
    } catch (_) {
      error = '本机事项暂不可用，请重试。';
      _notify();
      rethrow;
    }
  }

  void _changed() {
    _notify();
    if (repo!.pendingCount > 0 && !hasConflict) _scheduler?.changed();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      _scheduler?.setForeground(state == AppLifecycleState.resumed);

  LocalLife get _ready {
    _checkActive();
    final local = repo;
    if (local == null || !local.ready) {
      throw StateError('local_store_not_ready');
    }
    return local;
  }

  dynamic _readonly(dynamic value) {
    if (value is Map) {
      return Map<String, dynamic>.unmodifiable(
        value.map((key, item) => MapEntry(key as String, _readonly(item))),
      );
    }
    if (value is List) return List<dynamic>.unmodifiable(value.map(_readonly));
    return value;
  }

  @override
  Map<String, dynamic> snapshot() =>
      _readonly(_ready.life) as Map<String, dynamic>;

  @override
  Future<Map<String, dynamic>> mutate(
    Map<String, dynamic> input, {
    required String operationId,
  }) async => _ready.mutate(input, operationId: operationId);

  Future<T> _serial<T>(Future<T> Function() work) {
    final future = _tail.then((_) async {
      _checkActive();
      busy = true;
      _notify();
      try {
        final result = await work();
        error = null;
        return result;
      } catch (_) {
        // Do not surface transport text: a remote error may echo credentials.
        error = 'Hub 操作失败，请检查连接、账号和同步状态。';
        rethrow;
      } finally {
        busy = false;
        _notify();
      }
    });
    _tail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  Future<String?> readHubUrl() async {
    await open();
    return _url;
  }

  Future<void> configureHub({required String url, required String token}) =>
      _serial(() async {
        final local = _ready;
        final endpoint = url.trim(), credential = token.trim();
        if (credential.isEmpty) {
          throw const FormatException('device_token_required');
        }
        final transport = HttpLifeSync(endpoint, credential);
        local.validateSnapshot(await transport.snapshot());
        _checkActive();
        // Store the pair atomically so a failed write cannot mix two accounts.
        await _secrets.write(
          key: 'nova.local.hub.credentials',
          value: jsonEncode({'url': endpoint, 'token': credential}),
        );
        _checkActive();
        _url = endpoint;
        _token = credential;
        _tasks?.dispose();
        _tasks = null;
        _scheduler?.changed();
      });

  Future<void> sync() => _serial(() async {
    final local = _ready;
    if (!hubConfigured) return;
    await local.sync(HttpLifeSync(_url!, _token!));
    lastSync = DateTime.now();
  });

  Future<HubTasks?> getTasks() => _serial(() async {
    final local = _ready;
    if (!hubConfigured) return null;
    if (_tasks != null) return _tasks;
    final transport = HttpLifeSync(_url!, _token!);
    final remote = await transport.snapshot();
    local.validateSnapshot(remote);
    final directory = await getApplicationSupportDirectory();
    _checkActive();
    final candidate = HubTasks(
      request: transport.request,
      persistence: FileLifePersistence(
        File('${directory.path}/task-delivery-v1.json'),
      ),
      agent: const NativeLocalAgent(),
      hubId: remote['hub_id'],
      accountId: remote['account_id'],
    );
    try {
      await candidate.open();
      _checkActive();
      return _tasks = candidate;
    } catch (_) {
      candidate.dispose();
      rethrow;
    }
  });

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _scheduler?.dispose();
    _bridge?.detach();
    _tasks?.dispose();
    repo?.removeListener(_changed);
    store?.dispose();
    repo?.dispose();
    super.dispose();
  }
}
