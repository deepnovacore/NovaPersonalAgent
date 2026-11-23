import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

String newSpaceId() => List.generate(
  24,
  (_) => Random.secure().nextInt(256),
).map((v) => v.toRadixString(16).padLeft(2, '0')).join();

abstract interface class SpacePersistence {
  Future<String?> read();
  Future<void> write(String value);
}

class SpaceFilePersistence implements SpacePersistence {
  SpaceFilePersistence(this.file, this.keyStorage);
  final File file;
  final SpacePersistence keyStorage;
  static final cipher = AesGcm.with256bits();
  @override
  Future<String?> read() async {
    if (!await file.exists()) return null;
    final key = await keyStorage.read();
    if (key == null) throw StateError('missing_client_storage_key');
    final box = SecretBox.fromConcatenation(
      await file.readAsBytes(),
      nonceLength: 12,
      macLength: 16,
    );
    return utf8.decode(
      await cipher.decrypt(box, secretKey: SecretKey(base64Decode(key))),
    );
  }

  @override
  Future<void> write(String value) async {
    var encoded = await keyStorage.read();
    if (encoded == null) {
      // Never replace an existing encrypted store when its key is unavailable.
      if (await file.exists()) throw StateError('missing_client_storage_key');
      encoded = base64Encode(
        await (await cipher.newSecretKey()).extractBytes(),
      );
      await keyStorage.write(encoded);
    }
    final box = await cipher.encrypt(
      utf8.encode(value),
      secretKey: SecretKey(base64Decode(encoded)),
    );
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.writing');
    await temporary.writeAsBytes(box.concatenation(), flush: true);
    await temporary.rename(file.path);
  }
}

class SpaceSecurePersistence implements SpacePersistence {
  const SpaceSecurePersistence(this.key);
  final String key;
  static const storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  @override
  Future<String?> read() => storage.read(key: key);
  @override
  Future<void> write(String value) => storage.write(key: key, value: value);
}

enum SpaceMode { standalone, client }

@immutable
class SpaceRecord {
  const SpaceRecord({
    required this.id,
    required this.name,
    required this.mode,
    this.remoteSpace,
    this.hostDevice,
    this.hostSigningKey,
    this.relay,
    this.device,
    this.paired = false,
    this.personaId,
    this.experienceSeededAt,
  });
  final String id, name;
  final SpaceMode mode;
  final String? remoteSpace, hostDevice, relay, device;
  final Map<String, dynamic>? hostSigningKey;
  final bool paired;
  final String? personaId;
  final DateTime? experienceSeededAt;
  factory SpaceRecord.fromJson(Map<String, dynamic> value) {
    final id = value['id'] as String;
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,200}$').hasMatch(id)) {
      throw const FormatException('invalid_space_id');
    }
    final persona = value['persona_id'];
    final anchor = DateTime.tryParse(
      value['experience_seeded_at'] as String? ?? '',
    );
    if (persona != null &&
        (persona is! String ||
            !RegExp(r'^[a-z0-9][a-z0-9_-]{0,63}$').hasMatch(persona) ||
            value['mode'] != 'standalone' ||
            anchor == null)) {
      throw const FormatException('invalid_experience_space');
    }
    return SpaceRecord(
      id: id,
      name: value['name'] as String,
      mode: SpaceMode.values.byName(value['mode'] as String),
      remoteSpace: value['remote_space'] as String?,
      hostDevice: value['host_device'] as String?,
      hostSigningKey: (value['host_signing_key'] as Map?)
          ?.cast<String, dynamic>(),
      relay: value['relay'] as String?,
      device: value['device'] as String?,
      paired: value['paired'] == true,
      personaId: persona as String?,
      experienceSeededAt: anchor,
    );
  }
  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'mode': mode.name,
    'remote_space': remoteSpace,
    'host_device': hostDevice,
    'host_signing_key': hostSigningKey,
    'relay': relay,
    'device': device,
    'paired': paired,
    if (personaId != null) 'persona_id': personaId,
    if (experienceSeededAt != null)
      'experience_seeded_at': experienceSeededAt!.toIso8601String(),
  };
}

/// Scope is fixed before any local engine is constructed. Client UI never opens
/// LifeHost, AgentCoreHost, ProfileGenerationCoordinator or a scheduler.
class SpaceStorage {
  static SpaceRecord? active;
  static SpaceRecord? get scope =>
      Zone.current[#novaSpace] as SpaceRecord? ?? active;
  static T runScoped<T>(SpaceRecord? space, T Function() body) =>
      runZoned(body, zoneValues: {#novaSpace: space});
  static bool get allowsLocalRuntime => active?.mode == SpaceMode.standalone;
  static String secureKey(String key) =>
      scope == null ? key : '$key.space.${scope!.id}';
  static Future<Directory> directory({SpaceRecord? space}) async {
    final selected = space ?? scope;
    if (selected != null && defaultTargetPlatform == TargetPlatform.iOS) {
      // Native excludes/protects the containing directory before any Dart file
      // or atomic temporary snapshot can be created. Fail closed if unavailable.
      final path = await const MethodChannel(
        'nova/space_scope',
      ).invokeMethod<String>('prepareSpaceDirectory', {'spaceId': selected.id});
      if (path == null) throw StateError('space_privacy_unavailable');
      return Directory(path);
    }
    final root = await getApplicationSupportDirectory();
    if (selected == null) return root; // Injected legacy unit fixtures only.
    final directory = Directory('${root.path}/spaces/${selected.id}');
    await directory.create(recursive: true);
    return directory;
  }

  static Future<SpaceRecord?> readActive() async {
    final catalog = SpaceCatalog();
    await catalog.open();
    return active = catalog.selected;
  }
}

bool sameClientHost(SpaceRecord a, SpaceRecord b) {
  if (a.mode != SpaceMode.client ||
      b.mode != SpaceMode.client ||
      a.remoteSpace == null ||
      a.hostSigningKey == null ||
      b.hostSigningKey == null) {
    return false;
  }
  return a.remoteSpace == b.remoteSpace &&
      a.hostDevice == b.hostDevice &&
      [
        'kty',
        'crv',
        'x',
        'y',
      ].every((k) => a.hostSigningKey![k] == b.hostSigningKey![k]);
}

class SpaceCatalog extends ChangeNotifier {
  SpaceCatalog({SpacePersistence? persistence})
    : persistence =
          persistence ?? const SpaceSecurePersistence('nova.spaces.catalog.v1');
  final SpacePersistence persistence;
  final List<SpaceRecord> spaces = [];
  String? selectedId;
  bool ready = false;
  bool _pairing = false;
  final List<SpaceRecord> retired = [];
  Future<SpaceRecord> pairOnce(Future<SpaceRecord> Function() work) async {
    if (_pairing) throw StateError('pairing_in_progress');
    _pairing = true;
    try {
      return await work();
    } finally {
      _pairing = false;
    }
  }

  List<SpaceRecord> bindings(SpaceRecord space) => spaces
      .where((v) => v.id == space.id || sameClientHost(v, space))
      .toList();

  /// Binding ids in the order they were last selected (most recent last),
  /// persisted so the chooser stays stable across restarts.
  final List<String> recent = [];

  /// One entry per Host: the selected binding, else the most recently
  /// selected one, else the first. A re-pair selects its fresh binding, so the
  /// chooser keeps showing it instead of an old revoked or needs-repair one.
  List<SpaceRecord> get visibleSpaces {
    int rank(SpaceRecord space) =>
        space.id == selectedId ? recent.length : recent.indexOf(space.id);
    final result = <SpaceRecord>[];
    for (final space in spaces) {
      final index = result.indexWhere((v) => sameClientHost(v, space));
      if (index < 0) {
        result.add(space);
      } else if (rank(space) > rank(result[index])) {
        result[index] = space;
      }
    }
    return result;
  }

  Future<void> _mutations = Future.value();

  Future<T> _serial<T>(Future<T> Function() change) {
    final result = _mutations.then((_) => change());
    _mutations = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  Future<void> retireBindings(SpaceRecord keep) => _serial(() async {
    final obsolete = bindings(keep).where((v) => v.id != keep.id).toList();
    await _commit(
      selectedId,
      nextSpaces: spaces.where((v) => !obsolete.contains(v)).toList(),
      nextRetired: [...retired, ...obsolete],
    );
  });

  Future<List<SpaceRecord>> removeSpace(String id) => _serial(() async {
    final space = spaces.where((v) => v.id == id).firstOrNull;
    if (space == null) return const [];
    final removed = bindings(space);
    await _commit(
      removed.any((v) => v.id == selectedId) ? null : selectedId,
      nextSpaces: spaces.where((v) => !removed.contains(v)).toList(),
      nextRetired: [...retired, ...removed],
    );
    return removed;
  });

  Future<void>? _opening;
  SpaceRecord? get selected =>
      spaces.where((s) => s.id == selectedId).firstOrNull;
  Future<void> open() {
    if (ready) return Future.value();
    return _opening ??= _load().whenComplete(() => _opening = null);
  }

  Future<void> _load() async {
    final raw = await persistence.read();
    if (raw != null) {
      final value = jsonDecode(raw) as Map;
      spaces.addAll(
        (value['spaces'] as List).map(
          (v) => SpaceRecord.fromJson(Map<String, dynamic>.from(v as Map)),
        ),
      );
      retired.addAll(
        (value['retired'] as List? ?? []).map(
          (v) => SpaceRecord.fromJson(Map<String, dynamic>.from(v as Map)),
        ),
      );
      selectedId = value['selected'] as String?;
      final saved = value['recent'];
      if (saved is List) {
        recent.addAll(saved.whereType<String>());
      } else if (selectedId != null) {
        // Catalogs written before `recent` existed: the current selection is
        // the most recent; other Hosts keep the first-binding fallback.
        recent.add(selectedId!);
      }
    }
    ready = true;
    SpaceStorage.active = selected;
    notifyListeners();
  }

  Future<void> _commit(
    String? selection, {
    List<SpaceRecord>? nextSpaces,
    List<SpaceRecord>? nextRetired,
  }) async {
    final known = {...(nextSpaces ?? spaces).map((s) => s.id)};
    final nextRecent = [
      ...recent.where((id) => id != selection && known.contains(id)),
      ?selection,
    ];
    await persistence.write(
      jsonEncode({
        'v': 1,
        'selected': selection,
        'recent': nextRecent,
        'retired': (nextRetired ?? retired).map((s) => s.toJson()).toList(),
        'spaces': (nextSpaces ?? spaces).map((s) => s.toJson()).toList(),
      }),
    );
    if (nextSpaces != null) {
      spaces
        ..clear()
        ..addAll(nextSpaces);
    }
    if (nextRetired != null) {
      retired
        ..clear()
        ..addAll(nextRetired);
    }
    selectedId = selection;
    recent
      ..clear()
      ..addAll(nextRecent);
    SpaceStorage.active = selected;
    notifyListeners();
  }

  Future<void> add(SpaceRecord space) => _serial(() async {
    if (spaces.any((v) => sameClientHost(v, space))) {
      throw StateError('client_binding_exists');
    }
    if (spaces.any((v) => v.id == space.id)) throw StateError('space_exists');
    await _commit(space.id, nextSpaces: [...spaces, space]);
  });

  Future<void> updateBinding(SpaceRecord record) => _serial(() async {
    final index = spaces.indexWhere((v) => v.id == record.id);
    if (index < 0 || !sameClientHost(spaces[index], record)) {
      throw StateError('binding_identity_changed');
    }
    final next = List<SpaceRecord>.of(spaces)..[index] = record;
    await _commit(record.id, nextSpaces: next);
  });

  /// Add a fresh device binding next to the existing ones for the same Host
  /// and select it. Older bindings are never retired automatically: a relay
  /// can forge "inactive", so only the Host-confirmed cleanup flow removes them.
  Future<void> addBinding(SpaceRecord next) => _serial(() async {
    if (!spaces.any((v) => sameClientHost(v, next)) ||
        spaces.any((v) => v.id == next.id || v.device == next.device)) {
      throw StateError('binding_identity_changed');
    }
    await _commit(next.id, nextSpaces: [...spaces, next]);
  });

  Future<void> select(String? id, {bool ignoreMissing = false}) =>
      _serial(() async {
        if (id != null && !spaces.any((s) => s.id == id)) {
          if (ignoreMissing) return;
          throw StateError('unknown_space');
        }
        await _commit(id);
      });
}
