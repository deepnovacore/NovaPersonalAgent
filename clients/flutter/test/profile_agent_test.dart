import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class DelayedModels extends ModelSettings {
  DelayedModels(this.configuration);
  final ModelConfiguration configuration;
  final entered = Completer<void>(), release = Completer<void>();
  int reads = 0;
  @override
  Future<ModelConfiguration?> read() async {
    if (++reads == 2) {
      entered.complete();
      await release.future;
    }
    return configuration;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final deadline in [false, true]) {
    test(
      'cancel during model settings read prevents transmission (deadline: $deadline)',
      () async {
        FlutterSecureStorage.setMockInitialValues({});
        final previousHttp = HttpOverrides.current;
        HttpOverrides.global = null;
        addTearDown(() => HttpOverrides.global = previousHttp);
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        var requests = 0;
        server.listen((request) async {
          requests++;
          await request.drain<void>();
          request.response.headers.contentType = ContentType(
            'text',
            'event-stream',
          );
          request.response.write(
            'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n',
          );
          await request.response.close();
        });
        final now = DateTime.utc(2026, 10, 18);
        final auth = FeishuAuth(
          MemoryLifePersistence()
            ..value = jsonEncode({
              'version': 1,
              'generation': 1,
              'app': {
                'brand': 'feishu',
                'app_id': 'fixture',
                'secret': 'synthetic',
              },
              'identity': {'open_id': 'self'},
              'credential': {
                'access_token': 'synthetic',
                'expires_at': now
                    .add(const Duration(days: 1))
                    .millisecondsSinceEpoch,
              },
            }),
          FeishuApi(),
          now: () => now,
        );
        await auth.open();
        final sources = SourceStore(MemoryLifePersistence(), now: () => now);
        await sources.bind(auth.identityKey, auth.generation);
        await sources.select('c', now.subtract(const Duration(days: 1)));
        await sources.ingestPage(
          sources.fence('c'),
          [
            {
              'message_id': 'm',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${now.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {'content': '{"text":"synthetic project plan"}'},
            },
          ],
          nextPage: null,
          windowEnd: now,
        );
        final models = DelayedModels(
          ModelConfiguration(
            endpoint: 'http://127.0.0.1:${server.port}/v1',
            model: 'fixture',
            key: 'synthetic',
          ),
        );
        await sources.grantProcessing(
          '${models.configuration.endpoint}|fixture',
          'profile',
          true,
        );
        final authority = SpaceAuthorityRepository(MemoryLifePersistence());
        await authority.open();
        final host = FeishuHost(auth: auth, sources: sources);
        final agent = ProfileAgent(
          host,
          authority,
          models,
          maxDuration: deadline
              ? const Duration(milliseconds: 20)
              : const Duration(minutes: 15),
        );
        final result = agent.run();
        final failed = expectLater(
          result,
          throwsA(
            isA<AgentFailure>().having((e) => e.code, 'code', 'cancelled'),
          ),
        );
        await models.entered.future;
        if (deadline) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        } else {
          agent.cancel();
        }
        models.release.complete();
        await failed;
        expect(requests, 0);
        expect(agent.repository.value, isNull);
        expect(agent.busy, false);
        host.dispose();
      },
    );
  }
}
