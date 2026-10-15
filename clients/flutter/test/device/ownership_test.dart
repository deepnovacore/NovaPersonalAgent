import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/ownership.dart';

Matcher error(String code) =>
    throwsA(isA<OwnershipError>().having((e) => e.code, 'code', code));

void main() {
  final identity = <String, dynamic>{
    'principal': '人:a',
    'device_id': 'b:"',
    'request_id': 'c\\\n',
  };
  test(
    'canonical identity preserves opaque IDs and rejects alternate encodings',
    () {
      expect(decodeIdentity(encodeIdentity(identity)), identity);
      for (final key in [
        'a:b:c',
        '["a", "b","c"]',
        '["a","b",""]',
        '["a","b","c",0]',
        'null',
        '["a","b",3]',
      ]) {
        expect(() => decodeIdentity(key), error('request_conflict'));
      }
      expect(
        encodeIdentity(identity),
        isNot(encodeIdentity({...identity, 'device_id': 'other'})),
      );
      expect(
        () => encodeIdentity({...identity, 'principal': ''}),
        error('request_conflict'),
      );
    },
  );
  test('expired lease never grants takeover and survives serialization', () {
    final owner = expireLease(
      Ownership.fromJson({
        'task_id': 't',
        'owner': 'd',
        'lease_expired': false,
      }),
    );
    expect(owner.toJson()['owner'], 'd');
    expect(() => requireOwner(owner, 'other'), error('owner_mismatch'));
    requireOwner(owner, 'd');
    expect(
      Ownership.fromJson(
        jsonDecode(jsonEncode(owner.toJson())) as Map<String, dynamic>,
      ).toJson(),
      owner.toJson(),
    );
  });
  test(
    'session fences owner, generation, captured context and int53 overflow',
    () {
      final session = SessionOwnership.fromJson({
        'id': 's',
        'owner': 'd',
        'generation': 2,
        'context_version': 3,
      });
      expect(
        () => processInput(session, 'other', 2, 3),
        error('owner_mismatch'),
      );
      expect(() => processInput(session, 'd', 1, 3), error('stale_fence'));
      final next = processInput(session, 'd', 2, 3);
      expect(next.toJson()['context_version'], 4);
      expect(session.toJson()['context_version'], 3);
      expect(() => processInput(next, 'd', 2, 3), error('stale_fence'));
      for (final value in [
        -1,
        0.5,
        9007199254740991,
        9007199254740992,
        double.nan,
        double.infinity,
      ]) {
        final s = SessionOwnership.fromJson({
          ...session.toJson(),
          'context_version': value,
        });
        expect(() => processInput(s, 'd', 2, value), error('stale_fence'));
      }
      expect(SessionOwnership.fromJson(next.toJson()).toJson(), next.toJson());
    },
  );
  test(
    'receipt replay precedes full capacity, without eviction or mutation',
    () {
      final empty = ReceiptState.fromJson({
        'capacity': 1,
        'receipts': <dynamic>[],
      });
      final first = recordReceipt(empty, identity, 'digest', {
        'id': 'receipt',
        'status': 'accepted',
      });
      final replay = recordReceipt(first.state, identity, 'digest', {
        'id': 'ignored',
        'status': 'changed',
      });
      expect(replay.replayed, true);
      expect(replay.receipt, first.receipt);
      expect(
        () => recordReceipt(first.state, identity, 'other', {
          'id': 'x',
          'status': 'accepted',
        }),
        error('request_conflict'),
      );
      expect(
        () => recordReceipt(
          first.state,
          {...identity, 'request_id': 'new'},
          'digest',
          {'id': 'x', 'status': 'accepted'},
        ),
        error('dedup_capacity'),
      );
      expect(empty.toJson()['receipts'], isEmpty);
      expect(first.state.toJson()['receipts'], hasLength(1));
      expect(
        ReceiptState.fromJson(first.state.toJson()).toJson(),
        first.state.toJson(),
      );
      for (final capacity in [-1, 0.5, 9007199254740992]) {
        expect(
          () => recordReceipt(
            ReceiptState.fromJson({'capacity': capacity, 'receipts': []}),
            identity,
            'digest',
            {'id': 'x', 'status': 'accepted'},
          ),
          error('dedup_capacity'),
        );
      }
      expect(
        () => recordReceipt(empty, identity, '', {
          'id': 'x',
          'status': 'accepted',
        }),
        error('request_conflict'),
      );
    },
  );
  test(
    'canonical payload sorts map keys, preserves lists and rejects non JSON/int53/cycles',
    () {
      expect(
        canonicalPayload({
          'b': [1, 2],
          'a': 1,
        }),
        canonicalPayload({
          'a': 1,
          'b': [1, 2],
        }),
      );
      expect(canonicalPayload([1, 2]), isNot(canonicalPayload([2, 1])));
      final cycle = <String, dynamic>{};
      cycle['self'] = cycle;
      for (final value in [
        cycle,
        () => 1,
        double.nan,
        double.infinity,
        9007199254740992,
        0.5,
        {'nested': Object()},
        #value,
        BigInt.one,
        {1: 'bad'},
      ]) {
        expect(() => canonicalPayload(value), error('request_conflict'));
      }
      final shared = {'value': 1};
      expect(canonicalPayload([shared, shared]), '[{"value":1},{"value":1}]');
      expect(
        canonicalPayload([1.0, -0.0, -9007199254740991, null, true]),
        '[1,0,-9007199254740991,null,true]',
      );
      expect(canonicalPayload({'2': 2, '10': 10}), '{"10":10,"2":2}');
    },
  );
}
