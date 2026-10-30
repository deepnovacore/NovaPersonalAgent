import '../../space/space_storage.dart';
import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../context/source_store.dart';
import '../../context/secure_persistence.dart';
import '../../context/profile_observation_checkpoint.dart';
import '../../context/profile_pipeline_checkpoint.dart';
import '../../personal/life_reducer.dart';
import 'api.dart';
import 'auth.dart';
import 'credentials.dart';
import 'ingest.dart';
import 'collection.dart';

/// App-owned connector. Opening a settings page never starts collection.
class FeishuHost extends ChangeNotifier {
  FeishuHost({FeishuAuth? auth, SourceStore? sources})
    : auth = auth ?? FeishuAuth(FeishuCredentialPersistence(), FeishuApi()),
      sources =
          sources ??
          SourceStore(
            SecureContextPersistence('nova.feishu.sources.v1'),
            onInvalidated: _scopedInvalidator(),
            onContentChanged: _scopedInvalidator(preserveObservations: true),
          );
  static Future<void> Function() _scopedInvalidator({
    bool preserveObservations = false,
  }) {
    final scope = SpaceStorage.scope;
    return () => SpaceStorage.runScoped(
      scope,
      () =>
          invalidateDerivedProfile(preserveObservations: preserveObservations),
    );
  }

  final _spaceScope = SpaceStorage.scope;
  static Future<void> invalidateDerivedProfile({
    bool clearPublished = false,
    bool preserveObservations = false,
  }) async {
    // Content changes retain context batches for current-record revalidation.
    if (clearPublished) {
      await SecureContextPersistence('nova.profile.local.v1').write('null');
    }
    if (!preserveObservations) {
      for (final key in [
        ProfileObservationCheckpoint.storageKey,
        ProfileObservationCheckpoint.incrementalStorageKey,
      ]) {
        await ProfileObservationCheckpoint.invalidate(
          SecureContextPersistence(key),
        );
      }
    }
    await ProfilePipelineCheckpoint.invalidate(
      SecureContextPersistence(ProfilePipelineCheckpoint.storageKey),
    );
  }

  final FeishuAuth auth;
  final SourceStore sources;
  late final ingest = FeishuIngest(auth, sources);
  late final collection = FeishuCollection(
    ingest,
    intent: SecureContextPersistence('nova.feishu.collection.v1'),
  )..addListener(_notify);
  Future<void>? _opening;
  Future<void> _identityTail = Future.value();
  bool _disposed = false;
  bool _restored = false, _listening = false;
  Future<void> open() => SpaceStorage.runScoped(_spaceScope, _openOnce);

  /// A failed setup is retryable: drop the cached future but keep its error for
  /// every caller that was already waiting on it.
  Future<void> _openOnce() async {
    final opening = _opening;
    if (opening != null) return opening;
    final result = _open();
    _opening = result;
    try {
      await result;
    } catch (_) {
      if (identical(_opening, result)) _opening = null;
      rethrow;
    }
  }

  Future<void> _open() async {
    // Working model copies from an interrupted process are never resumed.
    await SecureContextPersistence(
      'nova.profile.task.context.v1',
    ).write('{"schema_version":1,"conversations":[]}');
    await SecureContextPersistence(
      'nova.profile.task.tools.v1',
    ).write('{"schema_version":1,"records":{}}');
    await auth.open();
    await sources.open();
    await synchronizeIdentity();
    // Local data is usable even without Feishu authorization; only the
    // connector-dependent states need [ready].
    if (!_restored) {
      _restored = true;
      _notify();
    }
    if (!_listening) {
      _listening = true;
      auth.addListener(_authChanged);
      sources.addListener(_notify);
    }
    await collection.restore();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _authChanged() {
    _notify();
    unawaited(synchronizeIdentity().catchError((Object _) {}));
  }

  Future<void> synchronizeIdentity() =>
      SpaceStorage.runScoped(_spaceScope, _synchronizeIdentity);
  Future<void> _synchronizeIdentity() {
    final result = _identityTail.then((_) async {
      if (_disposed) return;
      final identity = auth.identityKey, generation = auth.generation;
      if (sources.identity != identity || sources.generation != generation) {
        await sources.bind(identity, generation);
        await invalidateDerivedProfile();
      }
    });
    _identityTail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  /// Whether local persisted state (auth, sources, identity) has been opened.
  /// Deliberately independent of [ready]: saved results stay readable while the
  /// Feishu connector is unconfigured or unauthorized.
  bool get restored => _restored;
  bool get ready =>
      auth.authorized &&
      sources.identity == auth.identityKey &&
      sources.generation == auth.generation;
  String remoteSource(String hub, String chat) =>
      lifeFingerprint({'hub': hub, 'identity': auth.identityKey, 'chat': chat});
  Future<void> applyTombstones(String hub, Set<String> ids) =>
      SpaceStorage.runScoped(_spaceScope, () => _applyTombstones(hub, ids));
  Future<void> _applyTombstones(String hub, Set<String> ids) async {
    await open();
    for (final chat in sources.sources) {
      if (ids.contains(remoteSource(hub, chat))) await sources.remove(chat);
    }
    await invalidateDerivedProfile();
  }

  Future<void> disconnect({bool revoke = false}) async {
    collection.pause();
    try {
      await auth.disconnect(revoke: revoke);
    } finally {
      await synchronizeIdentity();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    collection.dispose();
    if (_listening) {
      _listening = false;
      auth.removeListener(_authChanged);
      sources.removeListener(_notify);
    }
    auth.dispose();
    sources.dispose();
    super.dispose();
  }
}
