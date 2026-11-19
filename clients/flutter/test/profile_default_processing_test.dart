import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class _Models extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => ModelConfiguration(
    endpoint: 'https://example.com/v1',
    model: 'fixture',
    key: 'synthetic',
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const provider = 'https://example.com/v1|fixture';
  for (final stopped in [false, true]) {
    test(
      'default processing survives restart; explicit stop=$stopped',
      () async {
        FlutterSecureStorage.setMockInitialValues({});
        final now = DateTime.utc(2026, 10, 20);
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
        final disk = MemoryLifePersistence();
        final original = SourceStore(disk, now: () => now);
        await original.bind(auth.identityKey, auth.generation);
        await original.select('chat', DateTime.utc(1970));
        if (stopped) await original.grantProcessing(provider, 'profile', false);
        original.dispose();
        final source = SourceStore(disk, now: () => now);
        final host = FeishuHost(auth: auth, sources: source);
        await host.open();
        // Adding a source must not undo an explicit stop.
        await source.select('new-chat', DateTime.utc(1970));
        await source.ingestPage(
          source.fence('chat'),
          [
            {
              'message_id': 'message',
              'create_time': '${now.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {'content': '{"text":"synthetic plan"}'},
            },
          ],
          nextPage: null,
          windowEnd: now,
        );
        final publication = LocalPublicationContext(MemoryLifePersistence());
        await publication.open();
        final agent = ProfileAgent(host, publication, _Models());
        addTearDown(() {
          agent.dispose();
          host.dispose();
        });
        if (stopped) {
          await expectLater(agent.inspectGeneration(), throwsStateError);
          expect(
            () => source.readAuthorizedEvidence(provider, 'profile'),
            throwsStateError,
          );
        } else {
          final snapshot = await agent.inspectGeneration();
          expect(snapshot?.total, 1);
          expect(
            source.readAuthorizedEvidence(provider, 'profile'),
            hasLength(1),
          );
          expect(
            () =>
                source.readAuthorizedEvidence('unconfigured-model', 'profile'),
            throwsStateError,
          );
          final revision = source.processingRevision;
          final sourceRevision = source.revision;
          var notifications = 0;
          source.addListener(() => notifications++);
          // Even with source storage unavailable, a stable poll must neither
          // persist a redundant grant nor wake the coordinator via a listener.
          disk.fail = true;
          await agent.inspectGeneration();
          expect(source.processingRevision, revision);
          expect(source.revision, sourceRevision);
          expect(notifications, 0);
        }
      },
    );
  }
}
