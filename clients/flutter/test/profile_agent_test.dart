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
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/context/local_publication.dart';

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
  test('persisted failure codes never contain arbitrary provider text or observation details', () {
    expect(
      profileRunErrorCode(const AgentFailure('api-key-and-private-message')),
      'profile_run_failed',
    );
    expect(
      profileRunErrorCode(StateError('private source prose')),
      'profile_run_failed',
    );
    expect(
      profileRunErrorCode(const FormatException('private source prose')),
      'profile_run_failed',
    );
    expect(
      profileRunErrorCode(const AgentFailure('model_http_429')),
      'model_http_429',
    );
    expect(
      profileRunErrorCode(const AgentFailure('model_http_429 private')),
      'profile_run_failed',
    );
  });
  test('preflight failure replaces old receipt with a safe code and empty current coverage', () async {
    FlutterSecureStorage.setMockInitialValues({
      ProfileAgent.receiptKey:
          '{"status":"completed","coverage":{"eligible_records":999}}',
    });
    final host = FeishuHost();
    final publication = LocalPublicationContext(MemoryLifePersistence());
    final agent = ProfileAgent(host, publication, FailingModels());
    await expectLater(agent.run(), throwsStateError);
    final raw = await SecureContextPersistence(ProfileAgent.receiptKey)
        .read();
    final receipt = jsonDecode(raw!) as Map;
    expect(receipt['status'], 'interrupted');
    expect(receipt['error_code'], 'profile_run_failed');
    expect(receipt['coverage'], isEmpty);
    expect(raw, isNot(contains('private-api-key')));
    host.dispose();
  });
  for (final scenario in [
    'cancel',
    'deadline',
    'consent',
    'consent_deadline',
    'publication',
    'source',
    'model_error_cancel',
  ]) {
    final deadline = scenario == 'deadline' || scenario == 'consent_deadline';
    final paused = scenario == 'cancel' || scenario == 'deadline';
    final expectedCode = switch (scenario) {
      'cancel' => 'profile_cancelled',
      'deadline' => 'profile_deadline',
      'consent' || 'consent_deadline' => 'processing_consent_required',
      'publication' => 'local_host_required',
      'source' => 'stale_inputs',
      _ => 'invalid_model_settings',
    };
    test(
      'interruption during model settings read preserves reason and prevents transmission ($scenario)',
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
        final publication = LocalPublicationContext(MemoryLifePersistence());
        await publication.open();
        final host = FeishuHost(auth: auth, sources: sources);
        await host.open();
        final agent = ProfileAgent(
          host,
          publication,
          models,
          maxDuration: deadline
              ? const Duration(milliseconds: 20)
              : const Duration(minutes: 15),
        );
        final result = agent.run();
        final failed = expectLater(
          result,
          throwsA(
            predicate<Object>(
              (error) =>
                  profileRunErrorCode(error) == expectedCode &&
                  (error is ProfileRunFailure) == paused,
              'failure $expectedCode, paused=$paused',
            ),
          ),
        );
        await models.entered.future;
        if (scenario.startsWith('consent')) {
          await sources.grantProcessing(
            '${models.configuration.endpoint}|fixture',
            'profile',
            false,
          );
        } else if (scenario == 'publication') {
          publication.dispose();
        } else if (scenario == 'source') {
          await sources.setAllAccessible(false);
        } else if (!deadline) {
          agent.cancel();
        }
        if (deadline) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        if (scenario == 'model_error_cancel') {
          models.release.completeError(
            const AgentFailure('invalid_model_settings'),
          );
        } else {
          models.release.complete();
        }
        await failed;
        expect(requests, 0);
        expect(agent.repository.value, isNull);
        expect(agent.busy, false);
        final raw = await SecureContextPersistence(
          ProfileAgent.receiptKey,
        ).read();
        final receipt = jsonDecode(raw!) as Map;
        expect(receipt['status'], paused ? 'paused' : 'interrupted');
        expect(receipt['error_code'], expectedCode);
        expect(receipt['coverage'], isA<Map>());
        expect(receipt['coverage']['eligible_records'], 1);
        expect(raw, isNot(contains('synthetic project plan')));
        expect(raw, isNot(contains('synthetic')));
        host.dispose();
      },
    );
  }
}

class FailingModels extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async =>
      throw StateError('private-api-key and source prose');
}
