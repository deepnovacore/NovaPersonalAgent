import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import '../protocol/request_id.dart';

/// Relationship state is durable; network presence never elects a primary.
class SpaceAuthorityRepository extends ChangeNotifier {
  SpaceAuthorityRepository(this.persistence);
  final LifePersistence persistence;
  Map<String, dynamic>? _data;
  Future<void> _tail = Future.value();
  bool _disposed = false;
  String get deviceId => _data!['device_id'] as String;
  String get localDeviceId => _data!['local_device_id'] as String;
  String? get hubId => _data?['hub_id'] as String?;
  Map<String, dynamic> get record => copyJson(_data!['record']);
  String get primaryDeviceId => record['primary_device_id'] as String;
  int get epoch => record['authority_epoch'] as int;
  bool get canPublish =>
      _data != null &&
      _data!['publication_blocked'] != true &&
      record['pending'] == null &&
      primaryDeviceId == deviceId;
  int get publicationGeneration =>
      _data?['publication_generation'] as int? ?? 0;
  String get status =>
      _data?['publication_blocked'] == true || record['pending'] != null
      ? 'transitioning'
      : record['mode'] == 'pc_primary'
      ? 'pc_primary'
      : primaryDeviceId == deviceId
      ? 'mobile_primary'
      : 'mobile_replica';

  Future<T> _serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) {
      if (_disposed) throw StateError('authority_disposed');
      return action();
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  static Map<String, dynamic> validate(Map<String, dynamic> raw) {
    final data = copyJson(raw);
    const fields = {
      'protocol_version',
      'space_id',
      'authority_epoch',
      'membership_revision',
      'primary_device_id',
      'mode',
      'pending',
    };
    final id = RegExp(r'^[A-Za-z0-9_-]{1,200}$');
    if (data.keys.toSet().difference(fields).isNotEmpty ||
        fields.difference(data.keys.toSet()).isNotEmpty ||
        data['protocol_version'] != 1 ||
        !['mobile_primary', 'pc_primary'].contains(data['mode']) ||
        ![
          'space_id',
          'primary_device_id',
        ].every((key) => data[key] is String && id.hasMatch(data[key])) ||
        !['authority_epoch', 'membership_revision'].every(
          (key) =>
              data[key] is int &&
              data[key] > 0 &&
              data[key] <= 9007199254740991,
        )) {
      throw const FormatException('invalid_authority');
    }
    final pending = data['pending'];
    if (pending != null &&
        (pending is! Map ||
            !['transition_id', 'from_device_id', 'target_device_id'].every(
              (key) => pending[key] is String && id.hasMatch(pending[key]),
            ) ||
            pending['from_device_id'] != data['primary_device_id'] ||
            pending['expected_epoch'] != data['authority_epoch'] ||
            pending['acknowledged'] is! List ||
            !(pending['acknowledged'] as List).every(
              (value) => value is String && id.hasMatch(value),
            ))) {
      throw const FormatException('invalid_transition');
    }
    return data;
  }

  Future<void> open() => _serial(() async {
    if (_data != null) return;
    final text = await persistence.read();
    if (text != null) {
      final data = jsonDecode(text) as Map<String, dynamic>;
      if (data['schema_version'] != 1 ||
          data['device_id'] is! String ||
          data['local_device_id'] is! String) {
        throw const FormatException('invalid_authority_store');
      }
      validate(Map<String, dynamic>.from(data['record'] as Map));
      _data = data;
    } else {
      final id = requestId();
      await _save({
        'schema_version': 1,
        'device_id': id,
        'local_device_id': id,
        'hub_id': null,
        'record': {
          'protocol_version': 1,
          'space_id': requestId(),
          'authority_epoch': 1,
          'membership_revision': 1,
          'primary_device_id': id,
          'mode': 'mobile_primary',
          'pending': null,
        },
      });
    }
  });
  Future<void> _save(Map<String, dynamic> value) async {
    await persistence.write(jsonEncode(value));
    _data = value;
    if (!_disposed) notifyListeners();
  }

  /// Called only by the explicit join/accept UI, after authenticated Hub identity.
  Future<void> bind({
    required String hubId,
    required String deviceId,
    required Map<String, dynamic> record,
  }) => _serial(() async {
    if (_data == null) throw StateError('authority_not_ready');
    if (hubId.isEmpty || deviceId.isEmpty) throw StateError('invalid_identity');
    if (this.hubId != null &&
        (this.hubId != hubId ||
            this.deviceId != deviceId ||
            this.record['space_id'] != record['space_id'])) {
      throw StateError('space_already_bound');
    }
    final validated = validate(record);
    if (this.hubId != null) _checkRevision(validated);
    await _save({
      ..._data!,
      'hub_id': hubId,
      'device_id': deviceId,
      'record': validated,
      'publication_blocked': false,
      'publication_generation': publicationGeneration + 1,
    });
  });
  void _checkRevision(Map<String, dynamic> next) {
    final old = record;
    if (next['space_id'] != old['space_id']) throw StateError('space_mismatch');
    if (next['authority_epoch'] < old['authority_epoch'] ||
        next['membership_revision'] < old['membership_revision']) {
      throw StateError('stale_authority');
    }
    if (next['membership_revision'] == old['membership_revision'] &&
        lifeFingerprint(next) != lifeFingerprint(old)) {
      throw StateError('authority_conflict');
    }
    if (next['authority_epoch'] == old['authority_epoch'] &&
        (next['primary_device_id'] != old['primary_device_id'] ||
            next['mode'] != old['mode'])) {
      throw StateError('authority_conflict');
    }
  }

  Future<void> accept(Map<String, dynamic> value) => _serial(() async {
    final next = validate(value);
    _checkRevision(next);
    await _save({
      ..._data!,
      'record': next,
      'publication_blocked': false,
      'publication_generation': lifeFingerprint(next) == lifeFingerprint(record)
          ? publicationGeneration
          : publicationGeneration + 1,
    });
  });
  Future<void> freezePublication() => _serial(
    () => _save({
      ..._data!,
      'publication_blocked': true,
      'publication_generation': publicationGeneration + 1,
    }),
  );
  void validatePublish(int expectedEpoch) {
    if (epoch != expectedEpoch) throw StateError('stale_authority');
    if (record['pending'] != null) throw StateError('authority_transition');
    if (!canPublish) throw StateError('publisher_required');
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
