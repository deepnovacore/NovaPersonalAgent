import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
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
  SpaceFilePersistence(this.file);
  final File file;
  @override
  Future<String?> read() async =>
      await file.exists() ? file.readAsString() : null;
  @override
  Future<void> write(String value) async {
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.writing');
    await temporary.writeAsString(value, flush: true);
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
  });
  final String id, name;
  final SpaceMode mode;
  final String? remoteSpace, hostDevice, relay, device;
  final Map<String, dynamic>? hostSigningKey;
  final bool paired;
  factory SpaceRecord.fromJson(Map<String, dynamic> value) {
    final id = value['id'] as String;
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,200}$').hasMatch(id)) {
      throw const FormatException('invalid_space_id');
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

class SpaceCatalog extends ChangeNotifier {
  SpaceCatalog({SpacePersistence? persistence})
    : persistence =
          persistence ?? const SpaceSecurePersistence('nova.spaces.catalog.v1');
  final SpacePersistence persistence;
  final List<SpaceRecord> spaces = [];
  String? selectedId;
  bool ready = false;
  SpaceRecord? get selected =>
      spaces.where((s) => s.id == selectedId).firstOrNull;
  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final value = jsonDecode(raw) as Map;
      spaces.addAll(
        (value['spaces'] as List).map(
          (v) => SpaceRecord.fromJson(Map<String, dynamic>.from(v as Map)),
        ),
      );
      selectedId = value['selected'] as String?;
    }
    ready = true;
    SpaceStorage.active = selected;
    notifyListeners();
  }

  Future<void> _save() => persistence.write(
    jsonEncode({
      'v': 1,
      'selected': selectedId,
      'spaces': spaces.map((s) => s.toJson()).toList(),
    }),
  );
  Future<void> add(SpaceRecord space) async {
    if (spaces.any((v) => v.id == space.id)) throw StateError('space_exists');
    spaces.add(space);
    selectedId = space.id;
    await _save();
    SpaceStorage.active = space;
    notifyListeners();
  }

  Future<void> select(String? id) async {
    if (id != null && !spaces.any((s) => s.id == id)) {
      throw StateError('unknown_space');
    }
    selectedId = id;
    await _save();
    SpaceStorage.active = selected;
    notifyListeners();
  }
}
