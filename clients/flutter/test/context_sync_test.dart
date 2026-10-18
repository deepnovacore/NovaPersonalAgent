import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/context_sync.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'expired offline originals are scrubbed before any network request',
    () async {
      var now = DateTime.utc(2026, 10, 17);
      final disk = MemoryLifePersistence();
      var repo = ContextSync(
        disk,
        (m, p, [b]) async => throw StateError('offline'),
        now: () => now,
      );
      await repo.open();
      await repo.bind(hub: 'hub', space: 'space', device: 'phone');
      await repo.exportSource('source', 'provider', [
        {
          'message_id': 'm',
          'text': 'expired private text',
          'created_at': now.millisecondsSinceEpoch,
        },
      ]);
      now = now.add(const Duration(days: 31));
      repo = ContextSync(disk, (m, p, [b]) async {
        expect(jsonEncode(b), isNot(contains('expired private text')));
        throw StateError('offline');
      }, now: () => now);
      await repo.open();
      expect(disk.value, isNot(contains('expired private text')));
      expect(disk.value, contains('payload_hash'));
      await expectLater(repo.sync(), throwsStateError);
    },
  );
  test(
    'lost ACK reuses exact event and sequence after restart; never executes received projections',
    () async {
      final disk = MemoryLifePersistence();
      var lost = true;
      final received = <String, dynamic>{};
      Future<dynamic> request(
        String method,
        String path, [
        Object? body,
      ]) async {
        if (path == 'identity') {
          return {'hub_id': 'hub', 'account_id': 'space', 'device_id': 'phone'};
        }
        if (path == 'context') {
          return {'cursor': received.length, 'tombstones': {}, 'derived': null};
        }
        if (path == 'context/events') {
          final event = (body as List).single as Map<String, dynamic>;
          if (received.containsKey(event['event_id'])) {
            expect(jsonEncode(event), received[event['event_id']]);
          }
          received[event['event_id']] = jsonEncode(event);
          if (lost) {
            lost = false;
            throw StateError('lost_ack');
          }
          return {
            'cursor': received.length,
            'receipts': [
              {'event_id': event['event_id'], 'cursor': received.length},
            ],
          };
        }
        return {};
      }

      var repo = ContextSync(disk, request);
      await repo.open();
      await repo.bind(hub: 'hub', space: 'space', device: 'phone');
      await repo.correct('style', 'concise');
      await expectLater(repo.sync(), throwsStateError);
      expect(repo.pending, 1);
      repo = ContextSync(disk, request);
      await repo.open();
      await repo.sync();
      expect(received.length, 1);
      expect(repo.pending, 0);
    },
  );
  test(
    'forget scrubs pending original text before networking and keeps a durable delete request',
    () async {
      final disk = MemoryLifePersistence();
      final repo = ContextSync(
        disk,
        (m, p, [b]) async => throw StateError('offline'),
      );
      await repo.open();
      await repo.bind(hub: 'hub', space: 'space', device: 'phone');
      await repo.exportSource('source', 'provider', [
        {
          'message_id': 'm',
          'text': 'private fixture',
          'created_at': 1792195200000,
        },
      ]);
      expect(disk.value, contains('private fixture'));
      await repo.forget('source');
      expect(disk.value, isNot(contains('private fixture')));
      expect(repo.pendingDeletes, ['source']);
    },
  );
}
