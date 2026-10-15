import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/hub_transport.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'two real clients converge through the TypeScript Hub, with ACK loss and conversion aliasing',
    () async {
      final root = Directory.current.parent.parent.path;
      final process = await Process.start('node', [
        '--input-type=module',
        '-e',
        '''
      import {HubStore} from './runtime/dist/src/hub/store.js';
      import {createHubServer} from './runtime/dist/src/hub/server.js';
      const store=new HubStore(':memory:');
      const a=store.enroll('roundtrip','phone'),b=store.enroll('roundtrip','desktop'),other=store.enroll('other','phone');
      const server=createHubServer(store);
      server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,a:a.token,b:b.token,other:other.token})));
    ''',
      ], workingDirectory: root);
      addTearDown(() async {
        process.kill();
        await process.exitCode;
      });
      process.stderr.drain<void>();
      final line = await process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .first
          .timeout(const Duration(seconds: 10));
      final info = jsonDecode(line) as Map;
      final a = HttpLifeSync('http://127.0.0.1:${info['port']}', info['a']);
      final b = HttpLifeSync('http://127.0.0.1:${info['port']}', info['b']);
      final phone = LocalLife(MemoryLifePersistence()),
          desktop = LocalLife(MemoryLifePersistence());
      await phone.open();
      await desktop.open();
      final idea = (await phone.mutate({
        'op': 'create',
        'kind': 'idea',
        'title': 'Read a book',
      }))['id'];
      final lossy = LoseOneAcknowledgement(a);
      await expectLater(phone.sync(lossy), throwsA(isA<SocketException>()));
      expect(phone.pendingCount, 1);
      await phone.sync(a);
      await desktop.sync(b);
      expect(phone.pendingCount, 0);
      expect(desktop.life['ideas'].length, 1);
      final p = (await phone.mutate({
        'op': 'convert',
        'id': idea,
        'target': 'todo',
        'expected_version': 1,
      }))['id'];
      final d = (await desktop.mutate({
        'op': 'convert',
        'id': idea,
        'target': 'todo',
        'expected_version': 1,
      }))['id'];
      await desktop.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': d,
        'expected_version': 1,
        'note': 'Offline note',
      });
      await phone.sync(a);
      await desktop.sync(b);
      await phone.sync(a);
      expect(phone.life['todos'].length, 1);
      expect(phone.life['todos'][0]['id'], p);
      expect(phone.life['todos'][0]['note'], 'Offline note');
      await phone.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': p,
        'expected_version': 2,
        'title': 'Phone title',
      });
      await desktop.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': p,
        'expected_version': 2,
        'title': 'Desktop title',
      });
      await desktop.sync(b);
      await phone.sync(a);
      expect(phone.conflict, isNotNull);
      await phone.resolveConflict(
        useLocal: true,
        expectedConflict: phone.conflictToken!,
      );
      await phone.sync(a);
      await desktop.sync(b);
      expect(desktop.life['todos'][0]['title'], 'Phone title');
      final goal = await phone.mutate({
        'op': 'create',
        'kind': 'goal',
        'title': 'Temporary goal',
      });
      await phone.sync(a);
      await desktop.sync(b);
      final draft = await phone.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Offline linked todo',
        'goal_id': goal['id'],
      });
      await phone.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': draft['id'],
        'expected_version': 1,
        'status': 'doing',
      });
      await desktop.mutate({
        'op': 'update',
        'kind': 'goal',
        'id': goal['id'],
        'expected_version': 1,
        'status': 'archived',
      });
      await desktop.sync(b);
      await phone.sync(a);
      expect(phone.conflict?['code'], 'goal_not_found');
      await expectLater(
        phone.resolveConflict(
          useLocal: true,
          expectedConflict: phone.conflictToken!,
        ),
        throwsStateError,
      );
      await phone.resolveConflict(
        useLocal: true,
        expectedConflict: phone.conflictToken!,
        unlinkGoal: true,
      );
      await phone.sync(a);
      await desktop.sync(b);
      final independent = (desktop.life['todos'] as List).singleWhere(
        (row) => row['title'] == 'Offline linked todo',
      );
      expect(independent['goal_id'], isNull);
      expect(independent['status'], 'doing');
      expect(phone.pendingCount, 0);
      final wrong = HttpLifeSync(
        'http://127.0.0.1:${info['port']}',
        info['other'],
      );
      await expectLater(phone.sync(wrong), throwsStateError);
      expect((await wrong.snapshot())['state']['todos'], isEmpty);
    },
    skip: !const bool.fromEnvironment('NOVA_HUB_TEST'),
  );
}

class LoseOneAcknowledgement implements LifeSyncTransport {
  LoseOneAcknowledgement(this.inner);
  final LifeSyncTransport inner;
  bool lose = true;
  @override
  Future<Map<String, dynamic>> snapshot() => inner.snapshot();
  @override
  Future<Map<String, dynamic>> push(Map<String, dynamic> command) async {
    final result = await inner.push(command);
    if (lose) {
      lose = false;
      throw const SocketException('ACK lost');
    }
    return result;
  }
}
