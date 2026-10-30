import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'package:nova_mobile/personal/life_reducer.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

Future<({SourceStore store, int bytes})> largeSourceFixture() async {
  final now = DateTime.utc(2026, 10, 29);
  final body = 'x' * 500;
  final value = <String, dynamic>{
    'version': 1,
    'history_policy': 'fetch-v1',
    'identity': 'fixture:person',
    'generation': 1,
    'revision': 1,
    'processing_revision': 1,
    'sources': {
      for (var i = 0; i < 155; i++)
        'c$i': {
          'scope_revision': 1,
          'paused': false,
          'from': DateTime.utc(1970).toIso8601String(),
          'history_from': DateTime.utc(1970).toIso8601String(),
          'full_history': true,
          'seen_pages': <String>[],
          'page_token': null,
          'window_end': null,
          'read_through': null,
        },
    },
    'tombstones': {},
    'grants': {
      lifeFingerprint({'provider': 'fixture', 'purpose': 'profile'}): {
        'provider': 'fixture',
        'purpose': 'profile',
      },
    },
    'messages': {
      for (var i = 0; i < 16800; i++)
        'e${i.toString().padLeft(63, '0')}': {
          'evidence_id': 'e${i.toString().padLeft(63, '0')}',
          'identity': 'fixture:person',
          'chat_id': 'c${i % 155}',
          'message_id': 'm$i',
          'created_at': now.millisecondsSinceEpoch - i * 1000,
          'fetched_at': now.millisecondsSinceEpoch,
          'text': '$i $body',
          'sender_id': 'person',
          'relation': 'self',
          'status': 'available',
        },
    },
  };
  final raw = jsonEncode(value);
  final disk = MemoryLifePersistence()..value = raw;
  final store = SourceStore(disk, now: () => now);
  await store.open();
  return (store: store, bytes: utf8.encode(raw).length);
}

Future<Map<String, int>> measureSourceWork(Future<void> Function() work) async {
  final clock = Stopwatch()..start();
  var last = 0, lag = 0;
  final heartbeat = Timer.periodic(const Duration(milliseconds: 5), (_) {
    final current = clock.elapsedMicroseconds;
    if (last != 0) lag = max(lag, current - last - 5000);
    last = current;
  });
  await Future<void>.delayed(const Duration(milliseconds: 20));
  final elapsed = Stopwatch()..start();
  try {
    await work();
  } finally {
    elapsed.stop();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    heartbeat.cancel();
  }
  return {
    'elapsed_ms': elapsed.elapsedMilliseconds,
    'heartbeat_lag_ms': (lag / 1000).ceil(),
  };
}

void main() {
  test(
    'large source cursor commits keep the host event loop responsive',
    () async {
      final data = await largeSourceFixture();
      addTearDown(data.store.dispose);
      expect(data.bytes, lessThan(16 * 1024 * 1024));
      final measured = await measureSourceWork(() async {
        await data.store.prepareWindow('c0', DateTime.utc(2026, 10, 29));
        await data.store.ingestPage(
          data.store.fence('c0'),
          [],
          nextPage: null,
          windowEnd: DateTime.utc(2026, 10, 29),
        );
      });
      debugPrint(
        'synthetic_source_cursor bytes=${data.bytes} records=16800 chats=155 metrics=$measured',
      );
      expect(data.store.revision, 1);
      expect(measured['heartbeat_lag_ms'], lessThan(150));
    },
  );
  test(
    'large source statistics and evidence reads avoid repeated full cache work',
    () async {
      final data = await largeSourceFixture();
      addTearDown(data.store.dispose);
      var statsMilliseconds = 0;
      Map<String, int> evidenceMetrics = {}, projectionMetrics = {};
      final measured = await measureSourceWork(() async {
        final stats = Stopwatch()..start();
        for (var i = 0; i < 5; i++) {
          expect(data.store.statusCounts['available'], 16800);
        }
        statsMilliseconds = stats.elapsedMilliseconds;
        late List<Map<String, dynamic>> originals;
        evidenceMetrics = await measureSourceWork(() async {
          originals = await data.store.readAuthorizedEvidenceAsync(
            'fixture',
            'profile',
          );
          expect(originals, hasLength(16800));
        });
        projectionMetrics = await measureSourceWork(() async {
          final evidence = await ProfileEvidence.build(originals);
          expect(evidence.records, hasLength(16800));
          expect(evidence.checkpointDigest.length, 64);
        });
      });
      debugPrint(
        'synthetic_source_reads bytes=${data.bytes} records=16800 chats=155 stats5_sync_ms=$statsMilliseconds evidence_async=$evidenceMetrics projection_async=$projectionMetrics overall=$measured',
      );
      expect(measured['heartbeat_lag_ms'], lessThan(150));
    },
  );
}
