import 'dart:collection';
import 'dart:convert';

class OwnershipError implements Exception {
  final String code;
  const OwnershipError(this.code);
  @override
  String toString() => code;
}

class Ownership {
  final Map<String, dynamic> _data;
  Ownership.fromJson(Map<String, dynamic> json) : _data = Map.of(json);
  Map<String, dynamic> toJson() => Map.of(_data);
}

class SessionOwnership {
  final Map<String, dynamic> _data;
  SessionOwnership.fromJson(Map<String, dynamic> json) : _data = Map.of(json);
  Map<String, dynamic> toJson() => Map.of(_data);
}

class ReceiptState {
  final Map<String, dynamic> _data;
  ReceiptState.fromJson(Map<String, dynamic> json)
    : _data = {
        ...json,
        'receipts': [
          for (final receipt in json['receipts'] as List)
            Map<String, dynamic>.from(receipt as Map),
        ],
      };
  Map<String, dynamic> toJson() => {
    ..._data,
    'receipts': [
      for (final receipt in _data['receipts'] as List)
        Map<String, dynamic>.from(receipt as Map),
    ],
  };
}

bool _nonempty(Object? value) => value is String && value.isNotEmpty;
bool _int53(Object? value) =>
    value is num &&
    value.isFinite &&
    value >= 0 &&
    value <= 9007199254740991 &&
    value == value.truncateToDouble();

String encodeIdentity(Map<String, dynamic> identity) {
  final values = [
    identity['principal'],
    identity['device_id'],
    identity['request_id'],
  ];
  if (!values.every(_nonempty)) throw const OwnershipError('request_conflict');
  return jsonEncode(values);
}

Map<String, dynamic> decodeIdentity(String key) {
  dynamic values;
  try {
    values = jsonDecode(key);
  } catch (_) {
    throw const OwnershipError('request_conflict');
  }
  if (values is! List || values.length != 3 || !values.every(_nonempty)) {
    throw const OwnershipError('request_conflict');
  }
  final identity = <String, dynamic>{
    'principal': values[0],
    'device_id': values[1],
    'request_id': values[2],
  };
  if (encodeIdentity(identity) != key) {
    throw const OwnershipError('request_conflict');
  }
  return identity;
}

// The host hashes these canonical bytes; this module never generates digests.
String canonicalPayload(Object? value) {
  final ancestors = HashSet<Object>.identity();
  String encode(Object? item) {
    if (item == null || item is String || item is bool) return jsonEncode(item);
    if (item is num &&
        item.isFinite &&
        item.abs() <= 9007199254740991 &&
        item == item.truncateToDouble()) {
      return item.toInt().toString();
    }
    if (item is! List && item is! Map || !ancestors.add(item)) {
      throw const OwnershipError('request_conflict');
    }
    try {
      if (item is List) return '[${item.map(encode).join(',')}]';
      final record = item as Map;
      if (record.keys.any((key) => key is! String)) {
        throw const OwnershipError('request_conflict');
      }
      final keys = record.keys.cast<String>().toList()..sort();
      return '{${keys.map((key) => '${jsonEncode(key)}:${encode(record[key])}').join(',')}}';
    } finally {
      ancestors.remove(item);
    }
  }

  try {
    return encode(value);
  } catch (_) {
    throw const OwnershipError('request_conflict');
  }
}

Ownership expireLease(Ownership state) =>
    Ownership.fromJson({...state.toJson(), 'lease_expired': true});

void requireOwner(Ownership state, String deviceId) {
  if (!_nonempty(deviceId) || state._data['owner'] != deviceId) {
    throw const OwnershipError('owner_mismatch');
  }
}

SessionOwnership processInput(
  SessionOwnership state,
  String deviceId,
  num generation,
  num contextVersion,
) {
  if (!_nonempty(deviceId) || state._data['owner'] != deviceId) {
    throw const OwnershipError('owner_mismatch');
  }
  if (!_int53(generation) ||
      !_int53(contextVersion) ||
      state._data['generation'] != generation ||
      state._data['context_version'] != contextVersion ||
      contextVersion == 9007199254740991) {
    throw const OwnershipError('stale_fence');
  }
  return SessionOwnership.fromJson({
    ...state.toJson(),
    'context_version': contextVersion + 1,
  });
}

({ReceiptState state, Map<String, dynamic> receipt, bool replayed})
recordReceipt(
  ReceiptState state,
  Map<String, dynamic> identity,
  String payloadDigest,
  Map<String, dynamic> receipt,
) {
  final key = encodeIdentity(identity);
  final data = state.toJson();
  if (!_int53(data['capacity'])) throw const OwnershipError('dedup_capacity');
  if (!_nonempty(payloadDigest) ||
      !_nonempty(receipt['id']) ||
      !_nonempty(receipt['status'])) {
    throw const OwnershipError('request_conflict');
  }
  final receipts = data['receipts'] as List;
  for (final item in receipts.cast<Map<String, dynamic>>()) {
    if (item['request_key'] != key) continue;
    if (item['payload_digest'] != payloadDigest) {
      throw const OwnershipError('request_conflict');
    }
    return (state: state, receipt: item, replayed: true);
  }
  if (receipts.length >= (data['capacity'] as num)) {
    throw const OwnershipError('dedup_capacity');
  }
  final recorded = {
    ...receipt,
    'request_key': key,
    'payload_digest': payloadDigest,
  };
  return (
    state: ReceiptState.fromJson({
      ...data,
      'receipts': [...receipts, recorded],
    }),
    receipt: recorded,
    replayed: false,
  );
}
