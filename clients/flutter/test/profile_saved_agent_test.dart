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
import 'package:nova_mobile/context/profile_evidence.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class _Models extends ModelSettings {
  _Models(this.configuration);
  final ModelConfiguration configuration;
  @override
  Future<ModelConfiguration?> read() async => configuration;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'saved progress reruns after recipe upgrade and resumes untouched remaining batches',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final previous = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = previous);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var observationCalls = 0, finalCalls = 0, failMissing = true;
      var malformedSelection = false;
      server.listen((request) async {
        final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map;
        final messages = body['messages'] as List;
        final input = jsonDecode(messages.last['content'] as String) as Map;
        Map<String, dynamic> response;
        if (input.containsKey('allowed_evidence_ids')) {
          observationCalls++;
          final id = (input['allowed_evidence_ids'] as List).first;
          if (id == 'e2' && failMissing) {
            await Future<void>.delayed(const Duration(milliseconds: 150));
            request.response.statusCode = 503;
            await request.response.close();
            return;
          }
          response = {
            'facts': [
              {
                'text': '【事】提出项目计划',
                'refs': [id],
              },
            ],
          };
        } else {
          finalCalls++;
          if (input.containsKey('history_complete')) {
            response = {
              'topics': [
                for (final observation in input['observations'] as List)
                  {
                    'observation_indices': [observation['index']],
                  },
              ],
            };
          } else if ((messages.first['content'] as String).contains('独立审查草稿')) {
            response = {'review_notes': []};
          } else {
            response = {
              'timeline': [
                {
                  'brief': {
                    'title': '提出项目计划',
                    'status_label': '已提出',
                    'facts': [
                      {'text': '提出项目计划。', 'ref': 'e1', 'quote': '项目计划 0'},
                    ],
                    'why_now': '这是本人正在协调的项目安排。',
                    'next_steps': [],
                    'uncertainty': '',
                  },
                  'evidence_ids': ['e1'],
                  'time_ref': 'e1',
                },
              ],
              'profile': {},
              'todos': [],
            };
          }
        }
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        request.response.add(
          utf8.encode(
            'data: ${jsonEncode({
              'choices': [
                {
                  'delta': {'content': malformedSelection && input.containsKey('history_complete') ? '{not json' : jsonEncode(response)},
                },
              ],
            })}\n\ndata: [DONE]\n\n',
          ),
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
        List.generate(
          2,
          (i) => {
            'message_id': 'm$i',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${now.millisecondsSinceEpoch + i}',
            'msg_type': 'text',
            'body': {
              'content': jsonEncode({'text': '项目计划 $i ${'甲' * 13000}'}),
            },
          },
        ),
        nextPage: null,
        windowEnd: now.add(const Duration(minutes: 1)),
      );
      final models = _Models(
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
      addTearDown(host.dispose);
      final agent = ProfileAgent(
        host,
        authority,
        models,
        useTimelinePipeline: false,
      );
      await expectLater(agent.run(), throwsA(isA<AgentFailure>()));
      expect(observationCalls, 2);
      expect(finalCalls, 0);
      const checkpoint = SecureContextPersistence(
        ProfileObservationCheckpoint.storageKey,
      );
      final saved = await checkpoint.read();
      expect((jsonDecode(saved!)['batches'] as Map).length, 1);
      await agent.run(savedObservationsOnly: true);
      expect(observationCalls, 2);
      expect(finalCalls, 4);
      expect(await checkpoint.read(), saved);
      expect(agent.repository.value?['partial'], true);
      expect(agent.repository.value?['coverage']['eligible_records'], 2);
      expect(
        agent.repository.value?['coverage']['validated_observation_records'],
        1,
      );
      final receipt = jsonDecode(
        (await const SecureContextPersistence(ProfileAgent.receiptKey).read())!,
      );
      expect(receipt['status'], 'partial');
      expect(receipt['coverage']['unobserved_records'], 1);
      // Invalid JSON has no safe parsed selection to repair. It must not
      // trigger transport retries or erase the saved result/checkpoint.
      final beforeMalformed = await const SecureContextPersistence(
        'nova.profile.local.v1',
      ).read();
      malformedSelection = true;
      await expectLater(
        agent.run(savedObservationsOnly: true),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'profile_selection_invalid',
          ),
        ),
      );
      expect(finalCalls, 5);
      expect(observationCalls, 2);
      expect(await checkpoint.read(), saved);
      expect(
        await const SecureContextPersistence('nova.profile.local.v1').read(),
        beforeMalformed,
      );
      malformedSelection = false;

      // Simulate a result from the previous shipped recipe while preserving
      // exactly the current sources, model, correction context and checkpoint.
      final provider = '${models.configuration.endpoint}|fixture';
      final evidence = ProfileEvidence(
        sources.readAuthorizedEvidence(provider, 'profile'),
        validThrough: sources.now().add(agent.maxDuration),
      );
      final legacyScope = ProfileObservationCheckpoint.digest({
        'result_recipe': 'timeline-brief-v3',
        'provider': provider,
        'protocol': models.configuration.protocol.name,
        'account': sources.identity,
        'auth_generation': auth.generation,
        'source_generation': sources.generation,
        'source_revision': sources.revision,
        'consent_revision': sources.processingRevision,
        'authority': authority.record,
        'publication_generation': authority.publicationGeneration,
        'corrections': agent.corrections.context(
          agent.repository.correctionScope,
          provider,
        ),
        'evidence': evidence.checkpointDigest,
      });
      final legacyEntries = jsonEncode(agent.repository.value!['entries']);
      final legacyCoverage = Map<String, int>.from(
        agent.repository.value!['coverage'] as Map,
      );
      await agent.repository.publish(
        legacyEntries,
        epoch: authority.epoch,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: provider,
        partial: true,
        coverage: legacyCoverage,
        generationScope: legacyScope,
      );
      final sourceRevisionBeforeUpgrade = sources.revision;
      final recipeScope = await agent.inspectGeneration();
      expect(recipeScope!.scope, isNot(legacyScope));
      expect(recipeScope.hasResult, false);
      expect(recipeScope.covered, 0);
      // The previous result remains readable until replacement is validated.
      expect(jsonEncode(agent.repository.value!['entries']), legacyEntries);
      await agent.run(savedObservationsOnly: true);
      expect(observationCalls, 2); // Only cached observations were used.
      expect(finalCalls, 9); // Selection, draft, review and edit reran once.
      expect(await checkpoint.read(), saved);
      expect(sources.revision, sourceRevisionBeforeUpgrade);
      expect(agent.repository.value!['generation_scope'], recipeScope.scope);
      expect(
        agent.repository.value!['coverage']['validated_observation_records'],
        legacyCoverage['validated_observation_records'],
      );
      expect(
        agent.repository.value!['coverage']['final_original_records'],
        legacyCoverage['final_original_records'],
      );
      failMissing = false;
      await agent.run(maxNewBatches: 4);
      expect(observationCalls, 3);
      expect(finalCalls, 13);
      expect(agent.repository.value?['partial'], false);
      final completedScope = await agent.inspectGeneration();
      expect(completedScope?.complete, true);
      expect(
        agent.repository.value?['generation_scope'],
        completedScope!.scope,
      );

      expect(await checkpoint.read(), 'null');
      final completeProjection = await const SecureContextPersistence(
        'nova.profile.local.v1',
      ).read();
      final completeRevision = agent.repository.value!['revision'];
      failMissing = true;
      await expectLater(agent.run(), throwsA(isA<AgentFailure>()));
      final smallerCheckpoint = await checkpoint.read();
      expect(observationCalls, 5);
      await expectLater(
        agent.run(savedObservationsOnly: true),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'profile_result_more_complete',
          ),
        ),
      );
      expect(finalCalls, 13); // Reject before spending on another draft.
      expect(await checkpoint.read(), smallerCheckpoint);
      expect(
        await const SecureContextPersistence('nova.profile.local.v1').read(),
        completeProjection,
      );
      expect(agent.repository.value!['revision'], completeRevision);
      await agent.corrections.correct(
        agent.repository.correctionScope,
        'work',
        '用户确认的工作',
        '${models.configuration.endpoint}|fixture',
      );
      final changedScope = await agent.inspectGeneration();
      expect(changedScope?.complete, false);
      expect(changedScope?.covered, 0);
      expect(changedScope?.scope, isNot(completedScope.scope));
      expect(agent.repository.value!['revision'], completeRevision);
      // New assumptions form a separate generation; old results remain until
      // a newly validated projection is ready, even if it is initially partial.
      await agent.repository.publish(
        jsonEncode(
          agent.repository.value!['entries']
              .where((e) => e['explicit'] != true)
              .toList(),
        ),
        epoch: authority.epoch,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: '${models.configuration.endpoint}|fixture',
        partial: true,
        coverage: {
          'eligible_records': 2,
          'validated_observation_records': 1,
          'final_original_records': 1,
          'unobserved_records': 1,
        },
        generationScope: changedScope!.scope,
      );
      expect(agent.repository.value?['partial'], true);
      expect(agent.repository.value?['generation_scope'], changedScope.scope);
    },
  );
}
