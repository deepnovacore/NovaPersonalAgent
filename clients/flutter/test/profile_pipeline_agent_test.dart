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
import 'package:nova_mobile/context/profile_pipeline_checkpoint.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
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
  late SpaceAuthorityRepository authority;
  late _Models models;
  bool failSecondCompose = true;
  bool failProfileDraft = false;
  bool revokeDuringReview = false;
  bool revoked = false;
  final now = DateTime.utc(2026, 10, 19);
  String get provider => '${models.configuration.endpoint}|fixture';
  ProfileAgent createAgent() => ProfileAgent(host, authority, models);

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
    authority = SpaceAuthorityRepository(MemoryLifePersistence());
    await authority.open();
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
        if (stage == 'profile_draft' && failProfileDraft) {
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
                  'refs': [id],
                },
            ],
          };
        } else if (stage == 'timeline_select') {
          final indices = (input['allowed_indices'] as List).cast<int>();
          response = {
            'topics': [
              {
                'title': '甲事项已完成核验',
                'observation_indices': indices.take(3).toList(),
              },
              {
                'title': '乙事项已完成核验',
                'observation_indices': indices.skip(3).toList(),
              },
            ],
          };
        } else if (stage == 'timeline_reconcile') {
          response = {
            'groups': [
              for (final topic in input['topics'] as List)
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
                  'title': second ? '乙事项已完成核验' : '甲事项已完成核验',
                  'status_label': '已核验',
                  'facts': [
                    {'text': '本人完成了这项项目核验。', 'ref': id, 'quote': quote},
                  ],
                  'why_now': '本人关注的核验结果已经明确。',
                  'next_steps': [],
                  'uncertainty': '',
                },
              },
            ],
          };
        } else if (stage == 'profile_review') {
          response = {'review_notes': []};
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
      epoch: authority.epoch,
      sourceRevision: sources.revision,
      consentRevision: sources.processingRevision,
      provider: provider,
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'profile failure preserves all Timeline batches and cached restart completes once',
    () async {
      final fixture = _Fixture()
        ..failSecondCompose = false
        ..failProfileDraft = true;
      await fixture.open();
      final first = fixture.createAgent();
      await expectLater(first.run(), throwsA(isA<AgentFailure>()));
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 1,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 2,
        'profile_draft': 1,
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
      final pending = await first.inspectGeneration();
      expect(pending!.pendingOutput, true);
      expect(pending.complete, false);
      first.dispose();
      fixture.failProfileDraft = false;
      final next = fixture.createAgent();
      addTearDown(next.dispose);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 1,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 2,
        'profile_draft': 2,
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
        'timeline_select': 1,
        'timeline_reconcile': 1,
        'timeline_compose': 2,
        'timeline_review': 1,
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
      expect(partial['coverage']['timeline_completed_batches'], 1);
      expect(partial['coverage']['timeline_pending_batches'], 1);
      expect(partial['coverage']['final_original_records'], 3);
      final state = await first.inspectGeneration();
      expect(state!.pendingOutput, true);
      expect(state.complete, false);
      final savedObservations = await const SecureContextPersistence(
        ProfileObservationCheckpoint.storageKey,
      ).read();
      expect(savedObservations, isNot('null'));
      final savedStages = await const SecureContextPersistence(
        ProfilePipelineCheckpoint.storageKey,
      ).read();
      expect((jsonDecode(savedStages!)['entries'] as Map).length, 4);
      first.dispose();
      fixture.failSecondCompose = false;
      final next = fixture.createAgent();
      addTearDown(next.dispose);
      await next.run(savedObservationsOnly: true);
      expect(fixture.counts, {
        'observations': 6,
        'timeline_select': 1,
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
        (await const SecureContextPersistence(ProfileAgent.receiptKey).read())!,
      );
      expect(receipt['status'], 'completed');
      expect(receipt['coverage']['timeline_pending_batches'], 0);
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
      final before = await const SecureContextPersistence(
        'nova.profile.local.v1',
      ).read();
      await expectLater(
        agent.run(),
        throwsA(anyOf(isA<AgentFailure>(), isA<StateError>())),
      );
      expect(fixture.revoked, true);
      expect(fixture.counts['timeline_compose'], 1);
      expect(fixture.counts['timeline_review'], 1);
      expect(
        await const SecureContextPersistence('nova.profile.local.v1').read(),
        before,
      );
      expect(
        await const SecureContextPersistence(
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
}
