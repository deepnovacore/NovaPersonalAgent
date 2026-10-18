import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/background_execution.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/collection.dart';
import 'package:nova_mobile/connectors/feishu/ingest.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class Lease extends BackgroundExecution {
  late void Function() expire;
  int starts = 0;
  @override
  Future<void> begin(void Function() onExpired) async {
    starts++;
    expire = onExpired;
  }

  @override
  Future<void> progress(int units, String phase) async {}
  @override
  Future<void> end({required bool success}) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final pause in ['none', 'system', 'user', 'restart', 'restart_stale']) {
    test('collection survives view detachment; pause=$pause', () async {
      final first = Completer<void>(), release = Completer<void>();
      final now = DateTime.utc(2026, 10, 18);
      var pages = 0;
      final auth = FeishuAuth(
        MemoryLifePersistence()
          ..value = jsonEncode({
            'version': 1,
            'generation': 1,
            'app': {
              'brand': 'feishu',
              'app_id': 'cli_fixture',
              'secret': 'synthetic',
            },
            'identity': {'open_id': 'person'},
            'credential': {
              'access_token': 'synthetic',
              'expires_at': now
                  .add(const Duration(days: 1))
                  .millisecondsSinceEpoch,
            },
          }),
        FeishuApi(
          transport: (m, u, h, b) async {
            pages++;
            if (pages == 1) {
              first.complete();
              await release.future;
            }
            return FeishuResponse(200, {
              'code': 0,
              'data': {
                'items': [],
                'has_more': pages == 1,
                if (pages == 1) 'page_token': 'next',
              },
            });
          },
        ),
        now: () => now,
      );
      await auth.open();
      final sources = SourceStore(MemoryLifePersistence(), now: () => now);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.setAllAccessible(false);
      await sources.select('chat', now.subtract(const Duration(days: 1)));
      final lease = Lease();
      final intent = MemoryLifePersistence();
      final collection = FeishuCollection(
        FeishuIngest(auth, sources, now: () => now),
        execution: lease,
        intent: intent,
      );
      void viewListener() {}
      collection.addListener(viewListener);
      final run = collection.start();
      await first.future;
      collection.removeListener(viewListener);
      expect(identical(run, collection.start()), isTrue);
      collection.didChangeAppLifecycleState(AppLifecycleState.paused);
      if (pause == 'system') lease.expire();
      if (pause == 'user') collection.pause();
      if (pause.startsWith('restart')) collection.dispose();
      release.complete();
      await run;
      expect(pages, pause == 'none' ? 2 : 1);
      if (pause == 'system') {
        expect(sources.checkpoint('chat')['page_token'], 'next');
        collection.didChangeAppLifecycleState(AppLifecycleState.resumed);
        await collection.start();
        expect(pages, 2);
        expect(lease.starts, 2);
      } else if (pause == 'user') {
        collection.didChangeAppLifecycleState(AppLifecycleState.resumed);
        expect(lease.starts, 1);
      }
      if (pause.startsWith('restart')) {
        expect(intent.value, isNot('null'));
        if (pause == 'restart_stale') await auth.disconnect();
        final restored = FeishuCollection(
          FeishuIngest(auth, sources, now: () => now),
          execution: lease,
          intent: intent,
        );
        await restored.restore();
        if (pause == 'restart') {
          await restored.start();
          expect(pages, 2);
        } else {
          expect(pages, 1);
        }
        expect(intent.value, 'null');
        restored.dispose();
      } else {
        collection.dispose();
      }
      sources.dispose();
      auth.dispose();
    });
  }
}
