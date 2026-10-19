import 'dart:async';
import 'dart:io';
import 'dart:convert';
import '../device/space_authority.dart';
import '../context/secure_persistence.dart';
import '../context/context_sync.dart';
import '../protocol/request_id.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/preferences.dart';
import '../agent/hub_tasks.dart';
import '../agent/life_tool_bridge.dart';
import '../agent/local_agent.dart';
import 'hub_transport.dart';
import 'hub_errors.dart';
import 'life_sync_scheduler.dart';
import 'local_life.dart';
import 'local_news.dart';
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
  LifeHost({
    LocalLife? repository,
    LocalNews? newsRepository,
    this.backgroundReader = false,
  }) : _provided = repository,
       _providedNews = newsRepository;
  final bool backgroundReader;
  final LocalLife? _provided;
  final LocalNews? _providedNews;
  LocalNews? news;
  final authority = SpaceAuthorityRepository(
    const SecureContextPersistence('nova.space.authority.v1'),
  );
  bool authorityReady = false;
  ContextSync? contextSync;
  Future<void> Function(Set<String>)? applyContextTombstones;
  Future<ContextSync>? _contextOpening;
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
      // Injected Life repositories may omit News (e.g. background/test hosts).
      if (!backgroundReader && (_provided == null || _providedNews != null)) {
        var newsLanguage = WidgetsBinding.instance.platformDispatcher.locale
            .toLanguageTag();
        if (_providedNews == null) {
          try {
            newsLanguage = Preferences(
              await SharedPreferences.getInstance(),
            ).language(newsLanguage);
          } catch (_) {
            /* Use system language when preferences are unavailable. */
          }
        }
        news =
            _providedNews ??
            LocalNews(
              FileLifePersistence(
                File(
                  '${(await getApplicationSupportDirectory()).path}/local-news-v1.json',
                ),
              ),
              language: newsLanguage,
            );
        await news!.open();
        _checkActive();
      }
      store = PersonalStore(send: (_) => false, local: local, news: news);
      await authority.open();
      authorityReady = true;
      authority.addListener(_notify);
      local.addListener(_changed);
      if (Platform.isIOS && !backgroundReader) {
        _bridge = LifeToolBridge(local)..attach();
      }
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
      if (backgroundReader) {
        _notify();
        return;
      }
      _scheduler = LifeSyncScheduler(sync: sync, onError: (_) {});
      unawaited(
        news?.setForeground(
          WidgetsBinding.instance.lifecycleState == null ||
              WidgetsBinding.instance.lifecycleState ==
                  AppLifecycleState.resumed,
        ),
      );
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
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _scheduler?.setForeground(state == AppLifecycleState.resumed);
    unawaited(news?.setForeground(state == AppLifecycleState.resumed));
  }

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
  }) async {
    if (backgroundReader) throw StateError('foreground_required');
    return _ready.mutate(input, operationId: operationId);
  }

  Future<T> _serial<T>(Future<T> Function() work) {
    final future = _tail.then((_) async {
      _checkActive();
      busy = true;
      _notify();
      try {
        final result = await work();
        error = null;
        return result;
      } catch (failure) {
        // Only allowlisted local error codes are exposed to the UI.
        error = hubErrorMessage(failure);
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

  Future<void> configureHub({
    required String url,
    required String token,
    String? expectedHubId,
    String? expectedAccountId,
  }) => _serial(() async {
    final local = _ready;
    final endpoint = url.trim(), credential = token.trim();
    if (credential.isEmpty) {
      throw const FormatException('device_token_required');
    }
    final transport = HttpLifeSync(endpoint, credential);
    final snapshot = await transport.snapshot();
    if (expectedHubId != null && snapshot['hub_id'] != expectedHubId) {
      throw StateError('hub_identity_changed');
    }
    if (expectedAccountId != null &&
        snapshot['account_id'] != expectedAccountId) {
      throw StateError('account_mismatch');
    }
    local.validateSnapshot(snapshot);
    _checkActive();
    // Store the pair atomically so a failed write cannot mix two accounts.
    try {
      await _secrets.write(
        key: 'nova.local.hub.credentials',
        value: jsonEncode({'url': endpoint, 'token': credential}),
      );
    } catch (_) {
      throw const HubPairingException('save_failed');
    }
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
    if (authority.hubId != null) await _refreshAuthority();
    if (authority.hubId != null) await (await getContextSync()).sync();
    lastSync = DateTime.now();
  });

  Future<ContextSync> getContextSync() async {
    if (!hubConfigured || authority.hubId == null) {
      throw StateError('authority_not_joined');
    }
    if (contextSync != null) return contextSync!;
    return _contextOpening ??= _openContextSync().catchError((
      Object error,
      StackTrace stack,
    ) {
      _contextOpening = null;
      Error.throwWithStackTrace(error, stack);
    });
  }

  Future<ContextSync> _openContextSync() async {
    final repository = ContextSync(
      const SecureContextPersistence('nova.context.sync.v1'),
      (method, path, [body]) =>
          HttpLifeSync(_url!, _token!).request(method, path, body),
      applyTombstones: (ids) async {
        if (applyContextTombstones == null) {
          throw StateError('deletion_handler_required');
        }
        await applyContextTombstones!(ids);
      },
    );
    await repository.open();
    await repository.bind(
      hub: authority.hubId!,
      space: authority.record['space_id'],
      device: authority.deviceId,
    );
    _checkActive();
    contextSync = repository..addListener(_notify);
    return repository;
  }

  Future<void> _refreshAuthority() async {
    final transport = HttpLifeSync(_url!, _token!);
    final identity = await transport.request('GET', 'identity') as Map;
    if (identity['hub_id'] != authority.hubId ||
        identity['device_id'] != authority.deviceId) {
      throw StateError('authority_identity_mismatch');
    }
    final record = await transport.request('GET', 'authority');
    if (record is! Map) throw StateError('authority_uninitialized');
    await authority.accept(Map<String, dynamic>.from(record));
  }

  /// Separate explicit opt-in from existing Life sync, which remains compatible
  /// with older Hub servers and does not imply accepting a primary computer.
  Future<void> joinAuthority() => _serial(() async {
    if (!hubConfigured) throw StateError('hub_required');
    await authority.freezePublication();
    final transport = HttpLifeSync(_url!, _token!);
    final identity = await transport.request('GET', 'identity') as Map;
    final record =
        await transport.request('POST', 'authority/initialize', {}) as Map;
    await authority.bind(
      hubId: identity['hub_id'],
      deviceId: identity['device_id'],
      record: Map<String, dynamic>.from(record),
    );
  });
  Future<List<Map<String, dynamic>>> authorityMembers() => _serial(() async {
    if (!hubConfigured) throw StateError('hub_required');
    final values =
        await HttpLifeSync(_url!, _token!).request('GET', 'authority/members')
            as List;
    return values.map((e) => Map<String, dynamic>.from(e as Map)).toList();
  });
  Future<void> transferAuthority(String target) => _serial(() async {
    if (!hubConfigured || authority.hubId == null) {
      throw StateError('authority_not_joined');
    }
    await authority.freezePublication();
    final record = await HttpLifeSync(_url!, _token!)
        .request('POST', 'authority/prepare', {
          'transition_id': requestId(),
          'target_device_id': target,
          'expected_epoch': authority.epoch,
        });
    await authority.accept(Map<String, dynamic>.from(record as Map));
  });
  Future<void> authorityTransition(String action) => _serial(() async {
    if (!['ack', 'commit', 'cancel'].contains(action) || !hubConfigured) {
      throw StateError('invalid_transition');
    }
    await _refreshAuthority();
    final pending = authority.record['pending'];
    if (pending == null) throw StateError('transition_not_found');
    final record = await HttpLifeSync(_url!, _token!).request(
      'POST',
      'authority/$action',
      {'transition_id': pending['transition_id']},
    );
    await authority.accept(Map<String, dynamic>.from(record as Map));
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
    news?.dispose();
    authority.removeListener(_notify);
    authority.dispose();
    contextSync?.dispose();
    repo?.dispose();
    super.dispose();
  }
}
