import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_pipeline_checkpoint.dart';
import 'package:nova_mobile/personal/local_life.dart';

class CheckpointDisk implements LifePersistence {
  String? value;
  Future<void> Function()? onRead;
  Future<void> Function(String)? onWrite;
  @override
  Future<String?> read() async {
    final snapshot = value;
    await onRead?.call();
    return snapshot;
  }

  @override
  Future<void> write(String next) async {
    value = next;
    await onWrite?.call(next);
  }
}

void main() {
  final start = DateTime.utc(2026, 10, 19);
  final expiry = start.add(const Duration(hours: 1));
  ProfilePipelineCheckpoint cache(
    CheckpointDisk disk, {
    String scope = 'scope-a',
    DateTime? expiresAt,
    DateTime Function()? now,
    Future<void> Function()? authorize,
    int maxBytes = 4 * 1024 * 1024,
  }) => ProfilePipelineCheckpoint(
    disk,
    scope: scope,
    expiresAt: expiresAt ?? expiry,
    now: now ?? () => start,
    authorize: authorize ?? () async {},
    maxBytes: maxBytes,
  );
  final response = <String, dynamic>{
    'facts': [
      {
        'text': 'complete step',
        'refs': ['e1'],
      },
    ],
  };

  test(
    'persists independent stages and empty responses across reopening',
    () async {
      final disk = CheckpointDisk();
      expect(await cache(disk).load('missing'), isNull);
      await cache(disk).save('selection', response);
      await cache(disk).save('review', {});
      expect(await cache(disk).load('selection'), response);
      expect(await cache(disk).load('review'), isEmpty);
      await cache(disk).clear();
      expect(disk.value, 'null');
    },
  );

  test('scope or expiry mismatch discards stale data', () async {
    for (final changedExpiry in [false, true]) {
      final disk = CheckpointDisk();
      await cache(disk).save('stage', response);
      expect(
        await cache(
          disk,
          scope: changedExpiry ? 'scope-a' : 'scope-b',
          expiresAt: changedExpiry
              ? expiry.add(const Duration(seconds: 1))
              : expiry,
        ).load('stage'),
        isNull,
      );
      expect(disk.value, 'null');
    }
  });

  test('expiry or revoked access fails closed before reading', () async {
    for (final expired in [true, false]) {
      final disk = CheckpointDisk();
      await cache(disk).save('stage', response);
      await expectLater(
        cache(
          disk,
          now: () => expired ? expiry : start,
          authorize: () async {
            if (!expired) throw StateError('revoked');
          },
        ).load('stage'),
        throwsStateError,
      );
      expect(disk.value, 'null');
    }
  });

  test('revocation while read or write is in progress erases data', () async {
    for (final duringRead in [true, false]) {
      final disk = CheckpointDisk();
      await cache(disk).save('stage', response);
      var allowed = true;
      final checkpoint = cache(
        disk,
        authorize: () async {
          if (!allowed) throw StateError('revoked');
        },
      );
      if (duringRead) {
        disk.onRead = () async {
          allowed = false;
        };
        await expectLater(checkpoint.load('stage'), throwsStateError);
      } else {
        disk.onWrite = (value) async {
          if (value != 'null') allowed = false;
        };
        await expectLater(checkpoint.save('new', response), throwsStateError);
      }
      expect(disk.value, 'null');
    }
  });

  test(
    'concurrent instances preserve stages and ordered invalidation wins',
    () async {
      final disk = CheckpointDisk();
      await Future.wait([
        cache(disk).save('a', response),
        cache(disk).save('b', {'value': 2}),
      ]);
      expect(await cache(disk).load('a'), response);
      expect(await cache(disk).load('b'), {'value': 2});
      final entered = Completer<void>(), release = Completer<void>();
      disk.onWrite = (value) async {
        if (value != 'null') {
          entered.complete();
          await release.future;
        }
      };
      final saving = cache(disk).save('c', response);
      await entered.future;
      final invalidating = ProfilePipelineCheckpoint.invalidate(disk);
      release.complete();
      await Future.wait([saving, invalidating]);
      expect(disk.value, 'null');
      disk.onWrite = null;
      await cache(disk).save('fresh', {});
      expect(await cache(disk).load('fresh'), isEmpty);
    },
  );

  test('quota rejection preserves all previously successful entries', () async {
    final disk = CheckpointDisk();
    await cache(disk, maxBytes: 512).save('small', response);
    final before = disk.value;
    await expectLater(
      cache(disk, maxBytes: 512).save('huge', {'text': 'x' * 1000}),
      throwsStateError,
    );
    expect(disk.value, before);
    await expectLater(
      cache(disk, maxBytes: 10).save('tiny', {}),
      throwsStateError,
    );
    expect(disk.value, before);
    expect(await cache(disk).load('small'), response);
  });

  test('damaged or non-map cached stage fails closed', () async {
    final disk = CheckpointDisk();
    for (final raw in ['{broken', '[]', '{"version":1}']) {
      disk.value = raw;
      expect(await cache(disk).load('stage'), isNull);
      expect(disk.value, 'null');
    }
    await cache(disk).save('stage', response);
    final data = jsonDecode(disk.value!) as Map;
    (data['entries'] as Map)['stage'] = ['not a map'];
    disk.value = jsonEncode(data);
    expect(await cache(disk).load('stage'), isNull);
    expect(disk.value, 'null');
  });

  test(
    'save snapshots arguments before queued work and load returns a copy',
    () async {
      final disk = CheckpointDisk();
      final entered = Completer<void>(), release = Completer<void>();
      var checks = 0;
      final blocked = cache(
        disk,
        authorize: () async {
          if (++checks == 1) {
            entered.complete();
            await release.future;
          }
        },
      );
      final first = blocked.save('block', {});
      await entered.future;
      final input = <String, dynamic>{
        'nested': <dynamic>[
          <String, dynamic>{'value': 1},
        ],
      };
      final saving = cache(disk).save('stage', input);
      ((input['nested'] as List).first as Map)['value'] = 99;
      release.complete();
      await Future.wait([first, saving]);
      final loaded = (await cache(disk).load('stage'))!;
      expect(((loaded['nested'] as List).first as Map)['value'], 1);
      ((loaded['nested'] as List).first as Map)['value'] = 50;
      expect(
        (((await cache(disk).load('stage'))!['nested'] as List).first
            as Map)['value'],
        1,
      );
    },
  );

  test(
    'non-finite, cyclic and non-JSON values cannot damage prior stages',
    () async {
      final disk = CheckpointDisk();
      await cache(disk).save('good', response);
      final before = disk.value;
      final cycle = <String, dynamic>{};
      cycle['self'] = cycle;
      for (final bad in [
        <String, dynamic>{'number': double.nan},
        <String, dynamic>{'number': double.infinity},
        <String, dynamic>{'object': Object()},
        <String, dynamic>{
          'map': {1: 'non-string key'},
        },
        cycle,
      ]) {
        await expectLater(cache(disk).save('bad', bad), throwsStateError);
        expect(disk.value, before);
      }
    },
  );
}
