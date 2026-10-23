import 'dart:async';
import 'dart:io';

import '../context/local_publication.dart';
import '../space/space_storage.dart';
import '../context/secure_persistence.dart';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/preferences.dart';
import '../agent/life_tool_bridge.dart';
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
  final _spaceScope = SpaceStorage.active;
  late final publication = LocalPublicationContext(
    SecureContextPersistence('nova.local.publication.v1'),
    spaceId: _spaceScope?.id,
    permitsPublication: () =>
        _provided != null ||
        (SpaceStorage.allowsLocalRuntime && SpaceStorage.active == _spaceScope),
  );
  bool publicationReady = false;
  LocalLife? repo;
  PersonalStore? store;
  LifeToolBridge? _bridge;
  Future<void>? _opening;
  bool _disposed = false;
  String? error;
  @override
  bool get hasConflict => false;
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
                '${(await SpaceStorage.directory(space: _spaceScope)).path}/local-life-v2.json',
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
                  '${(await SpaceStorage.directory(space: _spaceScope)).path}/local-news-v1.json',
                ),
              ),
              language: newsLanguage,
            );
        await news!.open();
        _checkActive();
      }
      store = PersonalStore(send: (_) => false, local: local, news: news);
      await publication.open();
      publicationReady = true;
      publication.addListener(_notify);
      local.addListener(_changed);
      if (Platform.isIOS && !backgroundReader) {
        _bridge = LifeToolBridge(local)..attach();
      }
      WidgetsBinding.instance.addObserver(this);
      unawaited(
        news?.setForeground(
          WidgetsBinding.instance.lifecycleState == null ||
              WidgetsBinding.instance.lifecycleState ==
                  AppLifecycleState.resumed,
        ),
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
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
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
    publication.requireCurrent();
    return _ready.mutate(input, operationId: operationId);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _bridge?.detach();
    repo?.removeListener(_changed);
    store?.dispose();
    news?.dispose();
    publication.removeListener(_notify);
    publication.dispose();
    repo?.dispose();
    super.dispose();
  }
}
