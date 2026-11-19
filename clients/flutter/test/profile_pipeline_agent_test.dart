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
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'package:nova_mobile/context/profile_pipeline_checkpoint.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class _Models extends ModelSettings {
  _Models(this.configuration);
  final ModelConfiguration configuration;
  @override
  Future<ModelConfiguration?> read() async => configuration;
}

class _Fixture {
  final counts = <String, int>{};
  final bodies = <String, List<Map<String, dynamic>>>{};
  late HttpServer server;
  late FeishuHost host;
  late SourceStore sources;
  late LocalPublicationContext publication;
  late _Models models;
  bool failSecondCompose = true;
  bool retitle = false;
  bool replacedSecond = false;
  bool failProfileDraft = false;
  bool failProfileReview = false;
  bool failSelection = false;
  bool revokeDuringProfileReview = false;
  String? profileAtRevocation;
  bool revokeDuringReview = false;
  bool revoked = false;
  final now = DateTime.now().toUtc().subtract(const Duration(minutes: 1));
  String get provider => '${models.configuration.endpoint}|fixture';
  ProfileAgent createAgent() => ProfileAgent(host, publication, models);

  Future<void> open() async {
    FlutterSecureStorage.setMockInitialValues({});
    final previous = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = previous);
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
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
    sources = SourceStore(MemoryLifePersistence(), now: () => now);
    await sources.bind(auth.identityKey, auth.generation);
    await sources.select('c', now.subtract(const Duration(days: 1)));
    await sources.ingestPage(
      sources.fence('c'),
      List.generate(
        6,
        (i) => {
          'message_id': 'm$i',
          'sender': {'id_type': 'open_id', 'id': 'self'},
          'create_time': '${now.millisecondsSinceEpoch + i}',
          'msg_type': 'text',
          'body': {
            'content': jsonEncode({
              'text': '本人关注项目核验；本人完成项目核验 $i ${'甲' * 13000}',
            }),
          },
        },
      ),
      nextPage: null,
      windowEnd: now.add(const Duration(minutes: 1)),
    );
    models = _Models(
      ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}/v1',
        model: 'fixture',
        key: 'synthetic',
      ),
    );
    await sources.grantProcessing(provider, 'profile', true);
    publication = LocalPublicationContext(MemoryLifePersistence());
    await publication.open();
    host = FeishuHost(auth: auth, sources: sources);
    addTearDown(host.dispose);
    server.listen((request) async {
      try {
        final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map;
        final messages = body['messages'] as List;
        final input = Map<String, dynamic>.from(
          jsonDecode(messages.last['content'] as String) as Map,
        );
        final instructions = messages.first['content'] as String;
        final stage = input.containsKey('allowed_evidence_ids')
            ? 'observations'
            : input.containsKey('allowed_indices')
            ? 'timeline_select'
            : input.containsKey('topics') && !input.containsKey('messages')
            ? 'timeline_reconcile'
            : input.containsKey('history_complete') &&
                  input.containsKey('messages')
            ? (input.containsKey('draft')
                  ? 'timeline_review'
                  : 'timeline_compose')
            : instructions.contains('独立审查草稿')
            ? 'profile_review'
            : input.containsKey('review_notes')
            ? 'profile_edit'
            : 'profile_draft';
        counts[stage] = (counts[stage] ?? 0) + 1;
        bodies.putIfAbsent(stage, () => []).add(input);
        if (stage == 'profile_review' && revokeDuringProfileReview) {
          revoked = true;
          profileAtRevocation = await SecureContextPersistence(
            'nova.profile.local.v1',
          ).read();
          await sources.grantProcessing(provider, 'profile', false);
        }
        if (stage == 'profile_draft' && failProfileDraft ||
            stage == 'timeline_select' && failSelection) {
          request.response.statusCode = 503;
          await request.response.close();
          return;
        }
        Map<String, dynamic> response;
        if (stage == 'observations') {
          response = {
            'facts': [
              for (final id in input['allowed_evidence_ids'] as List)
                {
                  'text': '【事】本人完成项目核验',
                  'relevance': 'ongoing_work',
                  'refs': [id],
                },
            ],
          };
        } else if (stage == 'timeline_select') {
          final rows = input['records'] as List;
          // Full 13k originals pack three per raw screening batch without truncation.
          expect(rows, hasLength(3));
          expect(
            rows.every((row) => (row['text'] as String).length > 13000),
            true,
          );
          final indices = rows.map((row) => row['key']).toList();
          expect(input['allowed_indices'], indices);
          response = {
            'topics': [
              {'title': '项目核验${indices.first}', 'observation_indices': indices},
            ],
          };
        } else if (stage == 'timeline_reconcile') {
          final topics = input['topics'] as List;
          expect(topics, hasLength(2));
          response = {
            'groups': [
              for (final topic in topics)
                {
                  'members': [topic['id']],
                },
            ],
          };
        } else if (stage == 'timeline_compose' || stage == 'timeline_review') {
          final originals = input['messages'] as List;
          expect(originals.length, 3);
          expect(
            originals.every((r) => (r['text'] as String).length > 13000),
            true,
          );
          final second = originals.any((r) => r['evidence_id'] == 'e4');
          if (stage == 'timeline_compose' && second && failSecondCompose) {
            request.response.statusCode = 503;
            await request.response.close();
            return;
          }
          if (stage == 'timeline_review' && revokeDuringReview && !revoked) {
            revoked = true;
            profileAtRevocation = await SecureContextPersistence(
              'nova.profile.local.v1',
            ).read();
            await sources.grantProcessing(provider, 'profile', false);
          }
          final id = originals.last['evidence_id'];
          final quote = (originals.last['text'] as String)
              .split(' ')
              .take(2)
              .join(' ');
          response = {
            'timeline': [
              {
                'evidence_ids': [id],
                'time_ref': id,
                'brief': {
                  'title':
                      '${second ? (replacedSecond ? '丙事项已完成核验' : '乙事项已完成核验') : '甲事项已完成核验'}${retitle ? '（复核）' : ''}',
                  'status_label': '已核验',
                  'facts': [
                    {'text': '本人完成了这项项目核验。', 'ref': id, 'quote': quote},
                  ],
                  'why_now': second
                      ? (replacedSecond ? '丙专属背景已经明确。' : '乙专属背景已经明确。')
                      : '本人关注的核验结果已经明确。',
                  'next_steps': [],
                  'uncertainty': '',
                  'temporal': {'kind': 'unknown', 'dates': []},
                },
              },
            ],
          };
        } else if (stage == 'profile_review') {
          response = {'review_notes': failProfileReview ? 'invalid' : []};
        } else {
          response = {
            'timeline': [],
            'profile': {
              'work': {
                'text': '本人完成项目核验，关注交付的核验结果。',
                'evidence_ids': [
                  (input['messages'] as List).first['evidence_id'],
                ],
              },
            },
            'todos': [],
          };
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
                  'delta': {'content': jsonEncode(response)},
                },
              ],
            })}\n\ndata: [DONE]\n\n',
          ),
        );
        await request.response.close();
      } on HttpException {
        if (!revoked) rethrow;
      } on SocketException {
        if (!revoked) rethrow;
      }
    });
  }

  Future<void> seedProfile(ProfileAgent agent) async {
    await agent.repository.open();
    final original = sources.readAuthorizedEvidence(provider, 'profile').first;
    await agent.repository.publish(
      jsonEncode([
        {
          'kind': 'profile',
          'key': 'about',
          'text': '本人关注项目核验。',
          'evidence_ids': [original['evidence_id']],
        },
      ]),

      sourceRevision: sources.revision,
      consentRevision: sources.processingRevision,
      provider: provider,
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final upgradedCache in [false, true]) {
    test(
      'coordinator collects after ${upgradedCache ? 'upgraded' : 'empty'} observation cache miss',
      () async {
        final fixture = _Fixture()..failSecondCompose = false;
        await fixture.open();
        final agent = fixture.createAgent();
        addTearDown(agent.dispose);
        if (upgradedCache) {
          await agent.run(maxNewBatches: 1);
          final storage = SecureContextPersistence(
            ProfileObservationCheckpoint.incrementalStorageKey,
          );
          final legacy = jsonDecode((await storage.read())!) as Map;
          expect(legacy['batches'], isNotEmpty);
          legacy['scope'] = 'profile-observations-v3-author';
          for (final batch in (legacy['batches'] as Map).values) {
            for (final fact in batch as List) {
              (fact as Map).remove('relevance');
            }
          }
          await storage.write(jsonEncode(legacy));
        }
        final observationsBefore = fixture.counts['observations'] ?? 0;
        final disk = MemoryLifePersistence();
        var time = DateTime.now();
        final calls = <bool>[];
        final coordinator = ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          now: () => time,
          inspect: agent.inspectGeneration,
          generate:
              ({required savedObservationsOnly, required maxNewBatches}) async {
                calls.add(savedObservationsOnly);
                await agent.run(
                  savedObservationsOnly: savedObservationsOnly,
                  maxNewBatches: maxNewBatches,
                );
              },
          processedRecords: () =>
              agent.lastCoverage['validated_observation_records'] ?? 0,
          cancel: agent.cancel,
          failureCode: profileRunErrorCode,
        );
        addTearDown(coordinator.dispose);
        await coordinator.start();
        await coordinator.poll();
        expect(calls, [true]);
        expect(coordinator.phase, ProfileGenerationPhase.continuing);
        expect(coordinator.code, isNull);
        expect(jsonDecode(disk.value!)['stage'], 'collect');
        expect(
          (agent.repository.value!['entries'] as List).where(
            (e) => e['kind'] == 'timeline',
          ),
          isNotEmpty,
        );
        time = time.add(const Duration(seconds: 5));
        await coordinator.poll();
        expect(calls, [true, false]);
        expect(fixture.counts['observations'], greaterThan(observationsBefore));
        expect(coordinator.phase, isNot(ProfileGenerationPhase.failed));
      },
    );
  }

  for (final metadata in ['links', 'sender']) {
    test('Timeline reconsiders $metadata-only source refresh', () async {
      final fixture = _Fixture()..failSecondCompose = false;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      Future<void> refresh(String sender, {bool forwarded = false}) =>
          fixture.sources.ingestPage(
            fixture.sources.fence('c'),
            [
              {
                'message_id': 'm5',
                'sender': {'id_type': 'open_id', 'id': sender},
                'create_time': '${fixture.now.millisecondsSinceEpoch + 5}',
                'msg_type': 'text',
                if (forwarded) 'upper_message_id': 'm4',
                'body': {
                  'content': jsonEncode({
                    'text': '本人关注项目核验；本人完成项目核验 5 ${'甲' * 13000}',
                  }),
                },
              },
            ],
            nextPage: null,
            windowEnd: fixture.now.add(const Duration(minutes: 1)),
          );
      if (metadata == 'sender') await refresh('other-before');
      await agent.run();
      final before = fixture.counts['timeline_compose']!;
      await refresh(
        metadata == 'sender' ? 'other-after' : 'self',
        forwarded: metadata == 'links',
      );
      await agent.run();
      expect(fixture.counts['timeline_compose'], greaterThan(before));
      expect(
        fixture.bodies['timeline_compose']!.last['context']['new_input_ids'],
        ['e6'],
      );
    });
  }

  test(
    'Timeline input basis detects edits and does not cross consent scopes',
    () async {
      final fixture = _Fixture()..failSecondCompose = false;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      await agent.run();
      expect(agent.repository.value!['timeline_input_basis'], hasLength(6));
      for (final input in fixture.bodies['timeline_compose']!) {
        expect(input['context'].containsKey('prior_cards'), false);
        expect(input['context'].containsKey('new_input_ids'), false);
      }
      final before = Map<String, int>.from(fixture.counts);
      await agent.run();
      expect(fixture.counts, before);
      final firstKeys = (agent.repository.value!['entries'] as List)
          .where((e) => e['kind'] == 'timeline')
          .map((e) => e['key'])
          .toSet();
      await fixture.sources.ingestPage(
        fixture.sources.fence('c'),
        [
          {
            'message_id': 'm0',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${fixture.now.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {
              'content': jsonEncode({
                'text': '本人关注项目核验；本人完成项目核验 0 已复核 ${'甲' * 13000}',
              }),
            },
          },
        ],
        nextPage: null,
        windowEnd: fixture.now.add(const Duration(minutes: 1)),
      );
      await agent.run();
      final context =
          fixture.bodies['timeline_compose']!.last['context'] as Map;
      expect(context['new_input_ids'], ['e1']);
      expect(
        (context['prior_cards'] as List).map((c) => c['id']).toSet(),
        firstKeys,
      );
      expect(agent.repository.value!['timeline_input_basis'], hasLength(6));
      fixture.retitle = true;
      final beforeCorrection = fixture.counts['timeline_compose']!;
      await agent.corrections.correct(
        agent.repository.correctionScope,
        'interests',
        '本人更关注已复核的交付结果。',
        fixture.provider,
      );
      await agent.run();
      expect(fixture.counts['timeline_compose'], greaterThan(beforeCorrection));
      final revised = (agent.repository.value!['entries'] as List)
          .where((e) => e['kind'] == 'timeline')
          .toList();
      expect(revised, hasLength(2));
      expect(revised.map((e) => e['key']).toSet(), firstKeys);
      expect(
        revised.every((e) => (e['brief']['title'] as String).contains('复核')),
        true,
      );
      expect(
        fixture.bodies['timeline_compose']!.last['context']['prior_cards'],
        hasLength(2),
      );
      expect(
        fixture.bodies['timeline_compose']!.last['context'].containsKey(
          'new_input_ids',
        ),
        false,
      );
      await fixture.sources.grantProcessing(fixture.provider, 'profile', false);
      await fixture.sources.grantProcessing(fixture.provider, 'profile', true);
      await agent.run();
      expect(
        fixture.bodies['timeline_compose']!.last['context'].containsKey(
          'prior_cards',
        ),
        true,
      );
      final afterConsentCycle = (agent.repository.value!['entries'] as List)
          .where((e) => e['kind'] == 'timeline')
          .toList();
      expect(afterConsentCycle, hasLength(2));
      expect(afterConsentCycle.map((e) => e['key']).toSet(), firstKeys);
      expect(
        fixture.bodies['timeline_compose']!.last['context'].containsKey(
          'new_input_ids',
        ),
        false,
      );
    },
  );

  test(
    'profile failure preserves all Timeline batches and cached restart completes once',
    () async {
      final fixture = _Fixture()
        ..failSecondCompose = false
        ..failProfileReview = true;
      await fixture.open();
      final first = fixture.createAgent();
      await expectLater(
        first.run(),
        throwsA(isA<ProfileGenerationTerminalFailure>()),
      );
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 2,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 2,
        'profile_draft': 1,
        'profile_review': 1,
      });
      final partial = first.repository.value!;
      expect(
        (partial['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .length,
        2,
      );
      expect(partial['coverage']['timeline_completed_batches'], 2);
      expect(partial['coverage']['timeline_pending_batches'], 0);
      expect(partial['coverage']['profile_pending'], 1);
      final failedReceipt = jsonDecode(
        (await SecureContextPersistence(ProfileAgent.receiptKey).read())!,
      );
      expect(failedReceipt['error_code'], 'profile_output_invalid');
      expect(
        failedReceipt['profile_validation_error'],
        'invalid_profile_review',
      );
      final pending = await first.inspectGeneration();
      expect(pending!.pendingOutput, true);
      expect(pending.complete, false);
      first.dispose();
      fixture.failProfileReview = false;
      final next = fixture.createAgent();
      addTearDown(next.dispose);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 2,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 2,
        'profile_draft': 2,
        'profile_review': 2,
        'profile_edit': 1,
      });
      final completed = next.repository.value!;
      expect(
        (completed['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .length,
        2,
      );
      expect(
        (completed['entries'] as List).singleWhere(
          (e) => e['key'] == 'work',
        )['text'],
        contains('项目核验'),
      );
      expect(completed['coverage']['profile_pending'], 0);
      expect((await next.inspectGeneration())!.complete, true);
      final beforeReplay = Map<String, int>.from(fixture.counts);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts, beforeReplay);
      expect((await next.inspectGeneration())!.complete, true);
      expect(
        (next.repository.value!['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .length,
        2,
      );
    },
  );

  test(
    'production pipeline preserves first reviewed batch and resumes only unfinished paid stages',
    () async {
      final fixture = _Fixture();
      await fixture.open();
      final first = fixture.createAgent();
      await fixture.seedProfile(first);
      await expectLater(first.run(), throwsA(isA<AgentFailure>()));
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 2,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 1,
        'profile_draft': 1,
        'profile_review': 1,
        'profile_edit': 1,
      });
      final partial = first.repository.value!;
      expect(
        (partial['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .length,
        1,
      );
      expect(
        (partial['entries'] as List).singleWhere(
          (e) => e['key'] == 'about',
        )['text'],
        '本人关注项目核验。',
      );
      expect(partial['partial'], true);
      expect(partial['timeline_input_basis'], hasLength(3));
      expect(partial['coverage']['timeline_completed_batches'], 1);
      expect(partial['coverage']['timeline_pending_batches'], 1);
      expect(partial['coverage']['final_original_records'], 4);
      final state = await first.inspectGeneration();
      expect(state!.pendingOutput, true);
      expect(state.complete, false);
      final savedObservations = await SecureContextPersistence(
        ProfileObservationCheckpoint.storageKey,
      ).read();
      expect(savedObservations, isNot('null'));
      final savedStages = await SecureContextPersistence(
        ProfilePipelineCheckpoint.storageKey,
      ).read();
      expect((jsonDecode(savedStages!)['entries'] as Map).length, 6);
      first.dispose();
      fixture.failSecondCompose = false;
      final next = fixture.createAgent();
      addTearDown(next.dispose);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 2,
        'timeline_reconcile': 1,
        'timeline_compose': 3,
        'timeline_review': 2,
        'profile_draft': 1,
        'profile_review': 1,
        'profile_edit': 1,
      });
      final completed = next.repository.value!;
      expect(
        (completed['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .length,
        2,
      );
      expect(
        (completed['entries'] as List).singleWhere(
          (e) => e['key'] == 'about',
        )['text'],
        '本人关注项目核验。',
      );
      expect(
        (completed['entries'] as List).singleWhere(
          (e) => e['key'] == 'work',
        )['text'],
        contains('项目核验'),
      );
      expect(completed['coverage']['timeline_completed_batches'], 2);
      expect(completed['coverage']['timeline_pending_batches'], 0);
      expect(completed['coverage']['profile_pending'], 0);
      expect(completed['coverage']['final_original_records'], 6);
      expect(completed['partial'], false);
      final finalState = await next.inspectGeneration();
      expect(finalState!.pendingOutput, false);
      expect(finalState.complete, true);
      final receipt = jsonDecode(
        (await SecureContextPersistence(ProfileAgent.receiptKey).read())!,
      );
      expect(receipt['status'], 'completed');
      expect(receipt['coverage']['timeline_pending_batches'], 0);
    },
  );

  test(
    'first Timeline selection failure leaves fresh Profile durable and cached',
    () async {
      final fixture = _Fixture()
        ..failSelection = true
        ..failSecondCompose = false;
      await fixture.open();
      final first = fixture.createAgent();
      await expectLater(first.run(), throwsA(isA<AgentFailure>()));
      final partial = first.repository.value!;
      expect((partial['entries'] as List).single['key'], 'work');
      expect(partial['partial'], true);
      expect(partial['coverage']['profile_pending'], 0);
      expect(partial['coverage']['timeline_pending'], 1);
      expect(partial['coverage']['timeline_pending_batches'], isNull);
      expect((await first.inspectGeneration())!.pendingOutput, true);
      first.dispose();
      fixture.failSelection = false;
      final next = fixture.createAgent();
      addTearDown(next.dispose);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts['profile_draft'], 1);
      expect(fixture.counts['profile_review'], 1);
      expect(fixture.counts['profile_edit'], 1);
      expect(next.repository.value!['coverage']['timeline_pending'], 0);
      expect(next.repository.value!['partial'], false);
    },
  );

  test(
    'invalid Profile followed by Timeline network failure keeps primary cause and retry boundary',
    () async {
      final fixture = _Fixture()..failProfileReview = true;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      await expectLater(
        agent.run(),
        throwsA(
          isA<ProfileGenerationTerminalFailure>().having(
            profileRunErrorCode,
            'underlying code',
            'model_http_503',
          ),
        ),
      );
      final receipt = jsonDecode(
        (await SecureContextPersistence(ProfileAgent.receiptKey).read())!,
      );
      expect(receipt['error_code'], 'model_http_503');
      expect(receipt['profile_validation_error'], 'invalid_profile_review');
      expect(agent.repository.value!['coverage']['profile_pending'], 1);
      expect(agent.repository.value!['coverage']['timeline_pending'], 1);
    },
  );

  test(
    'revocation during Profile review prevents early publication and Timeline',
    () async {
      final fixture = _Fixture()..revokeDuringProfileReview = true;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      await fixture.seedProfile(agent);
      await expectLater(
        agent.run(),
        throwsA(anyOf(isA<AgentFailure>(), isA<StateError>())),
      );
      expect(fixture.revoked, true);
      expect(fixture.counts['timeline_select'], isNull);
      expect(fixture.counts['profile_edit'], isNull);
      expect(
        await SecureContextPersistence('nova.profile.local.v1').read(),
        fixture.profileAtRevocation,
      );
      expect(
        await SecureContextPersistence(
          ProfilePipelineCheckpoint.storageKey,
        ).read(),
        'null',
      );
    },
  );

  test(
    'production revocation blocks cached processing and unpublished review output',
    () async {
      final fixture = _Fixture()..revokeDuringReview = true;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      await fixture.seedProfile(agent);
      await expectLater(
        agent.run(),
        throwsA(anyOf(isA<AgentFailure>(), isA<StateError>())),
      );
      expect(fixture.revoked, true);
      expect(fixture.counts['timeline_compose'], 1);
      expect(fixture.counts['timeline_review'], 1);
      expect(
        await SecureContextPersistence('nova.profile.local.v1').read(),
        fixture.profileAtRevocation,
      );
      expect(
        await SecureContextPersistence(
          ProfilePipelineCheckpoint.storageKey,
        ).read(),
        'null',
      );
      final previous = Map<String, int>.from(fixture.counts);
      await expectLater(
        agent.run(savedObservationsOnly: true),
        throwsA(isA<StateError>()),
      );
      expect(fixture.counts, previous);
    },
  );

  test(
    'removed chat evidence never reaches model input as prior cards',
    () async {
      final fixture = _Fixture()..failSecondCompose = false;
      await fixture.open();
      final agent = fixture.createAgent();
      addTearDown(agent.dispose);
      await agent.run();
      final cards = (agent.repository.value!['entries'] as List)
          .where((e) => e['kind'] == 'timeline')
          .toList();
      expect(cards, hasLength(2));
      final removed = cards.singleWhere(
        (e) => (e['brief']['title'] as String).startsWith('乙'),
      );
      final removedRefs = (removed['evidence_ids'] as List).toSet();
      final before = {
        for (final entry in fixture.bodies.entries)
          entry.key: entry.value.length,
      };
      // Deleting the source messages makes only that card's evidence unavailable.
      await fixture.sources.ingestPage(
        fixture.sources.fence('c'),
        [
          for (var i = 3; i < 6; i++)
            {
              'message_id': 'm$i',
              'deleted': true,
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${fixture.now.millisecondsSinceEpoch + i}',
              'msg_type': 'text',
            },
        ],
        nextPage: null,
        windowEnd: fixture.now.add(const Duration(minutes: 1)),
      );
      fixture.replacedSecond = true;
      await fixture.sources.ingestPage(
        fixture.sources.fence('c'),
        [
          for (var i = 6; i < 9; i++)
            {
              'message_id': 'm$i',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${fixture.now.millisecondsSinceEpoch + i}',
              'msg_type': 'text',
              'body': {
                'content': jsonEncode({
                  'text': '本人关注项目核验；本人完成项目核验 $i ${'甲' * 13000}',
                }),
              },
            },
        ],
        nextPage: null,
        windowEnd: fixture.now.add(const Duration(minutes: 2)),
      );
      expect(
        fixture.sources
            .messagesByEvidenceIds(removedRefs)
            .where((m) => m['status'] == 'available'),
        isEmpty,
      );
      await agent.run();
      final later = [
        for (final entry in fixture.bodies.entries)
          ...entry.value.skip(before[entry.key] ?? 0),
      ];
      expect(
        fixture.counts['timeline_compose'],
        greaterThan(before['timeline_compose']!),
      );
      final priors = later
          .map((input) => (input['context'] as Map?)?['prior_cards'])
          .whereType<List>();
      expect(priors, isNotEmpty);
      final wire = jsonEncode(later);
      expect(wire, isNot(contains(removed['brief']['title'])));
      expect(wire, isNot(contains('乙专属背景')));
      expect(wire, isNot(contains(removed['key'])));
      final offered = later
          .map((input) => (input['context'] as Map?)?['prior_cards'])
          .whereType<List>()
          .expand((cards) => cards)
          .map((card) => card['id']);
      expect(offered, isNot(contains(removed['key'])));
    },
  );
}
