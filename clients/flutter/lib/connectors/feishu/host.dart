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
          );
  static Future<void> Function() _scopedInvalidator() {
    final scope = SpaceStorage.scope;
    return () =>
        SpaceStorage.runScoped(scope, () => invalidateDerivedProfile());
  }

  final _spaceScope = SpaceStorage.scope;
  static Future<void> invalidateDerivedProfile({
    bool clearPublished = false,
  }) async {
    // Input changes invalidate paid working checkpoints, not successful history.
    if (clearPublished) {
      await SecureContextPersistence('nova.profile.local.v1').write('null');
    }
    await ProfileObservationCheckpoint.invalidate(
      SecureContextPersistence(ProfileObservationCheckpoint.storageKey),
    );
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
  Future<void> open() =>
      SpaceStorage.runScoped(_spaceScope, () => _opening ??= _open());
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
    auth.addListener(_authChanged);
    sources.addListener(_notify);
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
    auth.removeListener(_authChanged);
    sources.removeListener(_notify);
    auth.dispose();
    sources.dispose();
    super.dispose();
  }
}
