import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import '../protocol/request_id.dart';

typedef ContextRequest =
    Future<dynamic> Function(String method, String path, [Object? body]);

class ContextSync extends ChangeNotifier {
  ContextSync(
    this.persistence,
    this.request, {
    this.applyTombstones,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;
  final DateTime Function() now;
  final Future<void> Function(Set<String>)? applyTombstones;
  final LifePersistence persistence;
  final ContextRequest request;
  Map<String, dynamic> _data = {
    'version': 1,
    'hub': null,
    'space': null,
    'device': null,
    'seq': 0,
    'cursor': 0,
    'outbox': [],
    'sources': {},
    'deletes': {},
    'derived': null,
    'tombstones': {},
  };
  Future<void> _tail = Future.value();
  bool _syncing = false, _disposed = false;
  int get pending => (_data['outbox'] as List).length;
  bool get bound => _data['hub'] != null;
  List<String> get exportedSources =>
      (_data['sources'] as Map).keys.cast<String>().toList();
  List<String> get pendingDeletes =>
      (_data['deletes'] as Map).keys.cast<String>().toList();
  List<String> get pendingDeviceAcks =>
      (_data['pending_devices'] as List? ?? []).cast<String>();
  Map<String, dynamic> get corrections =>
      copyJson(_data['corrections'] as Map<String, dynamic>? ?? {});
  Map<String, dynamic>? get derived =>
      _data['derived'] == null ? null : copyJson(_data['derived']);
  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final value = jsonDecode(raw) as Map<String, dynamic>;
      if (value['version'] != 1) throw StateError('context_schema');
      _data = value;
    }
    await _prune();
  }

  Future<void> _prune() => _write((data) {
    final cutoff = now().subtract(const Duration(days: 30));
    for (var n = 0; n < (data['outbox'] as List).length; n++) {
      final event = data['outbox'][n], payload = event['payload'];
      if (payload is Map && payload['kind'] == 'source_fact') {
        final observed = DateTime.tryParse(
          payload['occurred_at'] as String? ?? '',
        );
        if (observed == null || !observed.isAfter(cutoff)) {
          data['outbox'][n] = {
            'discard': true,
            'event_id': event['event_id'],
            'producer_seq': event['producer_seq'],
            'payload_hash': lifeFingerprint(event),
          };
        }
      }
    }
  });

  Future<void> _write(void Function(Map<String, dynamic>) change) {
    final result = _tail.then((_) async {
      if (_disposed) throw StateError('context_disposed');
      final next = copyJson(_data);
      change(next);
      final text = jsonEncode(next);
      if (utf8.encode(text).length > 1000000) {
        throw StateError('context_capacity');
      }
      await persistence.write(text);
      _data = next;
      if (!_disposed) notifyListeners();
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> bind({
    required String hub,
    required String space,
    required String device,
  }) => _write((data) {
    if (bound &&
        (data['hub'] != hub ||
            data['space'] != space ||
            data['device'] != device)) {
      throw StateError('context_identity_mismatch');
    }
    data['hub'] = hub;
    data['space'] = space;
    data['device'] = device;
  });
  void _enqueue(Map<String, dynamic> data, Map<String, dynamic> payload) {
    if (data['hub'] == null) throw StateError('context_not_bound');
    data['seq'] = (data['seq'] as int) + 1;
    (data['outbox'] as List).add({
      'protocol_version': 1,
      'space_id': data['space'],
      'producer_device_id': data['device'],
      'producer_seq': data['seq'],
      'event_id': requestId(),
      'payload': payload,
    });
  }

  Map<String, String> modelCorrections(String provider) => {
    for (final entry in corrections.entries)
      if ((_data['correction_providers'] as Map? ?? {})[entry.key] == provider)
        entry.key: entry.value as String,
  };
  Map<String, String> get correctionTimes =>
      Map<String, String>.from(_data['correction_times'] as Map? ?? {});
  Future<void> correct(String key, String value, {String? provider}) => _write((
    data,
  ) {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(key) ||
        value.isEmpty ||
        value.length > 4000) {
      throw StateError('invalid_correction');
    }
    final updatedAt = now().toUtc().toIso8601String();
    _enqueue(data, {
      'kind': 'correction',
      'key': key,
      'value': value,
      'provider': ?provider,
      'updated_at': updatedAt,
    });
    (data.putIfAbsent('corrections', () => <String, dynamic>{}) as Map)[key] =
        value;
    (data.putIfAbsent('correction_providers', () => <String, dynamic>{})
            as Map)[key] =
        provider;
    (data.putIfAbsent('correction_times', () => <String, dynamic>{})
            as Map)[key] =
        updatedAt;
  });

  /// Called only after the separate upload + remote-provider consent dialog.
  Future<void> exportSource(
    String source,
    String provider,
    List<Map<String, dynamic>> messages,
  ) => _write((data) {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(source) ||
        provider.isEmpty ||
        provider.length > 2048 ||
        data['deletes'][source] != null ||
        data['tombstones'][source] != null) {
      throw StateError('source_deleted_or_invalid');
    }
    var grant = data['sources'][source] as Map?;
    if (grant == null || grant['provider'] != provider) {
      final revision = (grant?['revision'] as int? ?? 0) + 1;
      grant = {'revision': revision, 'provider': provider, 'items': {}};
      data['sources'][source] = grant;
      _enqueue(data, {
        'kind': 'grant',
        'source_id': source,
        'revision': revision,
        'provider': provider,
        'purpose': 'profile',
        'allow_upload': true,
        'allow_processing': true,
      });
    }
    for (final message in messages) {
      if (message['text'] is! String ||
          (message['text'] as String).isEmpty ||
          (message['text'] as String).length > 16000 ||
          message['message_id'] is! String ||
          message['created_at'] is! int) {
        continue;
      }
      final version = lifeFingerprint({
        'text': message['text'],
        'relation': message['relation'] ?? 'unknown',
        'sender_id': message['sender_id'],
      });
      final evidence = lifeFingerprint({
        'source': source,
        'message': message['message_id'],
        'version': version,
      });
      if (grant['items'][evidence] == true) continue;
      _enqueue(data, {
        'kind': 'source_fact',
        'source_id': source,
        'grant_revision': grant['revision'],
        'evidence_id': evidence,
        'resource_id': message['message_id'],
        'source_version': version,
        'text': message['text'],
        'relation': message['relation'] ?? 'unknown',
        'occurred_at': DateTime.fromMillisecondsSinceEpoch(
          message['created_at'],
          isUtc: true,
        ).toIso8601String(),
      });
      grant['items'][evidence] = true;
    }
  });
  Future<void> forget(String source) => _write((data) {
    data['deletes'].putIfAbsent(source, () => requestId());
    for (var i = 0; i < (data['outbox'] as List).length; i++) {
      final event = data['outbox'][i];
      if (event['payload']?['source_id'] == source) {
        data['outbox'][i] = {
          'discard': true,
          'event_id': event['event_id'],
          'producer_seq': event['producer_seq'],
          'payload_hash': lifeFingerprint(event),
        };
      }
    }
    (data['sources'] as Map).remove(source);
    data['derived'] = null;
  });
  Future<void> sync() async {
    if (_syncing || !bound) return;
    _syncing = true;
    try {
      await _prune();
      final identity = await request('GET', 'identity');
      if (identity is! Map ||
          identity['hub_id'] != _data['hub'] ||
          identity['account_id'] != _data['space'] ||
          identity['device_id'] != _data['device']) {
        throw StateError('context_identity_mismatch');
      }
      while (pendingDeletes.isNotEmpty) {
        final source = pendingDeletes.first, id = _data['deletes'][source];
        final result = await request('POST', 'context/delete', {
          'source_id': source,
          'request_id': id,
        });
        if (result is! Map ||
            result['source_id'] != source ||
            result['deleted'] != true) {
          throw StateError('invalid_delete_ack');
        }
        await _write((data) {
          (data['deletes'] as Map).remove(source);
          data['tombstones'][source] = result['revision'];
        });
      }
      final remote = await request('GET', 'context');
      if (remote is! Map ||
          remote['cursor'] is! int ||
          remote['tombstones'] is! Map ||
          (remote['cursor'] as int) < (_data['cursor'] as int)) {
        throw StateError('invalid_context_snapshot');
      }
      final tombstones = Map<String, dynamic>.from(remote['tombstones']);
      if (tombstones.entries.any(
        (e) =>
            !RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(e.key) ||
            e.value is! int ||
            e.value < 0,
      )) {
        throw StateError('invalid_tombstones');
      }
      final projection = remote['derived'];
      final remoteCorrections = remote['corrections'] as Map? ?? {};
      if (remoteCorrections.length > 200 ||
          remoteCorrections.entries.any(
            (e) =>
                e.key is! String ||
                e.value is! Map ||
                e.value['value'] is! String ||
                (e.value['value'] as String).length > 4000 ||
                (e.value['provider'] != null && e.value['provider'] is! String),
          )) {
        throw StateError('invalid_corrections');
      }
      if (projection != null &&
          (projection is! Map ||
              projection['authority_epoch'] is! int ||
              projection['revision'] is! int ||
              projection['publisher_device_id'] is! String ||
              projection['entries'] is! List ||
              (projection['entries'] as List).length > 200 ||
              !(projection['entries'] as List).every(
                (e) =>
                    e is Map &&
                    e['key'] is String &&
                    e['text'] is String &&
                    (e['text'] as String).length <= 4000 &&
                    e['evidence_ids'] is List &&
                    (e['evidence_ids'] as List).every((id) => id is String),
              ))) {
        throw StateError('invalid_projection');
      }
      if (tombstones.isNotEmpty) {
        if (applyTombstones == null) {
          throw StateError('deletion_handler_required');
        }
        await applyTombstones!(tombstones.keys.toSet());
      }
      await _write((data) {
        data['cursor'] = remote['cursor'];
        data['tombstones'] = Map<String, dynamic>.from(remote['tombstones']);
        data['derived'] = remote['derived'];
        data['corrections'] = {
          for (final entry in remoteCorrections.entries)
            entry.key: entry.value['value'],
        };
        data['correction_providers'] = {
          for (final entry in remoteCorrections.entries)
            entry.key: entry.value['provider'],
        };
        data['correction_times'] = {
          for (final entry in remoteCorrections.entries)
            if (entry.value['updated_at'] is String)
              entry.key: entry.value['updated_at'],
        };
        for (final event in data['outbox'] as List) {
          final payload = event['payload'];
          if (payload is Map && payload['kind'] == 'correction') {
            data['corrections'][payload['key']] = payload['value'];
            data['correction_providers'][payload['key']] = payload['provider'];
            if (payload['updated_at'] is String) {
              data['correction_times'][payload['key']] = payload['updated_at'];
            }
          }
        }
        (data['sources'] as Map).removeWhere(
          (key, _) => tombstones.containsKey(key),
        );
        for (var i = 0; i < (data['outbox'] as List).length; i++) {
          final event = data['outbox'][i],
              source = event['payload']?['source_id'];
          if (source != null && data['tombstones'][source] != null) {
            data['outbox'][i] = {
              'discard': true,
              'event_id': event['event_id'],
              'producer_seq': event['producer_seq'],
              'payload_hash': lifeFingerprint(event),
            };
          }
        }
      });
      // One bounded event per request keeps large pages below the Hub HTTP cap.
      for (var n = 0; n < 200 && pending > 0; n++) {
        if (pendingDeletes.isNotEmpty) break;
        final event = copyJson((_data['outbox'] as List).first);
        final result = event['discard'] == true
            ? await request('POST', 'context/discard', {
                'event_id': event['event_id'],
                'producer_seq': event['producer_seq'],
                'payload_hash': event['payload_hash'],
              })
            : await request('POST', 'context/events', [event]);
        if (result is! Map ||
            result['receipts'] is! List ||
            !(result['receipts'] as List).any(
              (r) => r is Map && r['event_id'] == event['event_id'],
            )) {
          throw StateError('invalid_event_ack');
        }
        await _write((data) {
          (data['outbox'] as List).removeWhere(
            (e) => e['event_id'] == event['event_id'],
          );
        });
      }
      await request('POST', 'context/ack', {'cursor': _data['cursor']});
      final status = await request('GET', 'context/deletions');
      if (status is Map &&
          status['pending_devices'] is List &&
          (status['pending_devices'] as List).every((id) => id is String)) {
        await _write((data) {
          data['pending_devices'] = status['pending_devices'];
        });
      }
    } finally {
      _syncing = false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
