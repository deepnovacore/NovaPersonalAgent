import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/ownership.dart';
import '../contract_fixture.dart';

String _id(dynamic value) {
  expect(value, isA<String>());
  expect(value as String, isNotEmpty);
  return value;
}

num _integer(dynamic value) {
  expect(value, isA<num>());
  final number = value as num;
  expect(
    number.isFinite &&
        number >= 0 &&
        number <= 9007199254740991 &&
        number == number.truncateToDouble(),
    isTrue,
  );
  return number;
}

Future<void> _run(ContractCase c) async {
  final g = c['given'] as Map<String, dynamic>;
  var owner = Ownership.fromJson({
    'task_id': g['task']['id'],
    'owner': g['task']['owner'],
    'lease_expired': false,
  });
  var session = SessionOwnership.fromJson(g['session'] as Map<String, dynamic>);
  String digest(Object? payload) =>
      'sha256:${sha256.convert(utf8.encode(canonicalPayload(payload)))}';
  var receipts = ReceiptState.fromJson({
    ...g['dedup'] as Map<String, dynamic>,
    'receipts': [
      for (final r in g['dedup']['receipts'] as List)
        {
          ...r as Map<String, dynamic>,
          'payload_digest': r['payload_digest'] == 'sha256:original'
              ? digest(g['input'])
              : r['payload_digest'],
        },
    ],
  });
  final actual = <String, dynamic>{
    'task_phase': g['task']['phase'],
    'attempt_status': g['attempt']['status'],
    'approval_status': g['approval']['status'],
    'effects': g['effects'],
  };
  for (final step in c['when'] as List) {
    final p = step['params'] as Map<String, dynamic>;
    try {
      switch (step['op']) {
        case 'expire_owner_lease':
          owner = expireLease(owner);
        case 'takeover':
          requireOwner(owner, _id(p['device_id']));
        case 'process_input':
          session = processInput(
            session,
            _id(p['device_id']),
            _integer(p['generation']),
            _integer(p['context_version']),
          );
        case 'delegate_new':
          receipts = recordReceipt(
            receipts,
            {
              ...g['identity'] as Map<String, dynamic>,
              'request_id': _id(p['request_id']),
            },
            digest(g['input']),
            {'id': 'new-receipt', 'status': 'accepted'},
          ).state;
        case 'replay_via_device':
          _id(p['transport_device']);
          final identity = p['identity'] as Map<String, dynamic>;
          expect(identity.keys.toSet(), {
            'principal',
            'device_id',
            'request_id',
          });
          for (final value in identity.values) {
            _id(value);
          }
          expect(
            encodeIdentity(g['identity'] as Map<String, dynamic>),
            g['request_key'],
          );
          receipts = recordReceipt(
            receipts,
            identity,
            digest({
              ...g['input'] as Map<String, dynamic>,
              'goal': _id(p['goal']),
            }),
            {'id': 'replayed-receipt', 'status': 'accepted'},
          ).state;
        default:
          fail('unsupported operation ${step['op']}');
      }
    } on OwnershipError catch (error) {
      actual['error'] = error.code;
    }
  }
  actual['owner'] = owner.toJson()['owner'];
  actual['retained_receipts'] = (receipts.toJson()['receipts'] as List)
      .map((r) => r['id'])
      .toList();
  for (final entry in (c['then'] as Map<String, dynamic>).entries) {
    expect(actual[entry.key], entry.value, reason: entry.key);
  }
}

final Map<String, ContractAdapter> adapters = {
  'owner-lease-expiry': _run,
  'session-owner-rule': _run,
  'dedup-capacity': _run,
  'cross-device-payload-conflict': _run,
};
