import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/context/profile_tool.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/experience/persona_sources.dart';
import 'package:nova_mobile/experience/experience_session.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/memory/local_memory_store.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class Bundle extends CachingAssetBundle {
  final Map<String, Uint8List> files = {};
  void json(String file, Object data) =>
      files[file] = Uint8List.fromList(utf8.encode(jsonEncode(data)));
  @override
  Future<ByteData> load(String key) async {
    final bytes = files[key];
    if (bytes == null) throw FlutterError('Unable to load asset: $key');
    return ByteData.sublistView(bytes);
  }
}

Bundle fixture() {
  final b = Bundle();
  const base = 'assets/experience/';
  b.json('${base}sample.json', {
    'name': 'Sample Person',
    'occupation': 'Designer',
    'about': 'A fictional designer.',
    'interests': ['tea'],
    'goals': [
      {'title': 'Sketch a garden'},
    ],
    'ideas': ['Read a book'],
    'todos': [
      {'title': 'Draft an outline', 'days': 1},
    ],
    'source_todos': [],
    'timeline': [
      {'title': 'A new idea', 'summary': 'Planning a garden', 'days': 0},
    ],
  });
  b.json('${base}sample.sources.json', {
    'records': [
      {
        'id': 'r0001',
        'kind': 'im',
        'locator': 'synthetic://sample/one',
        'observed_at': '2026-01-01T02:00:00Z',
        'text': 'I prefer tea.',
        'metadata': {'sender_name': 'Sample'},
      },
      {
        'id': 'r0002',
        'kind': 'calendar',
        'locator': 'synthetic://sample/two',
        'observed_at': '2026-01-01T03:00:00Z',
        'text': 'Sketch review tomorrow.',
        'metadata': {'start_at': '2026-01-02T02:00:00Z'},
      },
    ],
  });
  b.json('${base}sample.memory.json', {
    'as_of': '2026-01-01T00:00:00Z',
    'entries': [
      {
        'key': 'tea',
        'kind': 'preference',
        'text': 'Prefers tea',
        'quote': 'I prefer tea.',
        'source': 'r0001',
      },
    ],
  });
  b.json('${base}sample.snapshot.json', {
    'source_version': sha256
        .convert(b.files['${base}sample.sources.json']!)
        .toString(),
    'profile': [
      {
        'title': 'Preference',
        'text': 'Tea',
        'refs': ['r0001'],
      },
    ],
    'timeline': [
      {
        'title': 'Review',
        'summary': 'Review tomorrow',
        'refs': ['r0002'],
      },
    ],
  });
  b.files['${base}sample.png'] = Uint8List.fromList([1, 2, 3]);
  final files = {
    'profile': 'sample.json',
    'sources': 'sample.sources.json',
    'memory': 'sample.memory.json',
    'snapshot': 'sample.snapshot.json',
    'avatar': 'sample.png',
  };
  b.json('${base}manifest.json', {
    'version': 1,
    'personas': [
      {
        'id': 'sample',
        'name': 'Sample Person',
        'occupation': 'Designer',
        ...files,
        'sha256': {
          for (final entry in files.entries)
            entry.key: sha256
                .convert(b.files['$base${entry.value}']!)
                .toString(),
        },
      },
    ],
  });
  return b;
}

class _ShortGrantToolModel extends ModelClient {
  final keys = <String>[];
  final prompts = <List<Map<String, dynamic>>>[];
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    keys.add(configuration.key);
    prompts.add(messages);
    if (keys.length == 1) {
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'sample-create',
            'function': {
              'name': 'life_create',
              'arguments': jsonEncode({'kind': 'todo', 'title': 'Sample task'}),
            },
          },
        ],
      };
    } else {
      if (keys.last == keys.first) throw const AgentFailure('model_http_401');
      yield {'content': 'Saved once.'};
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });
  tearDown(() {
    ExperiencePersona.choices = const [];
    SpaceStorage.active = null;
    rootBundle.clear();
  });

  test(
    'missing manifest is a normal public package; unsafe paths and hashes fail closed',
    () async {
      expect(await ExperiencePersona.loadManifest(bundle: Bundle()), isEmpty);
      final b = fixture();
      expect(
        (await ExperiencePersona.loadManifest(bundle: b)).single.id,
        'sample',
      );
      b.files['assets/experience/sample.png'] = Uint8List.fromList([9]);
      await expectLater(
        ExperiencePersona.loadManifest(bundle: b),
        throwsFormatException,
      );
      final manifest = jsonDecode(
        utf8.decode(b.files['assets/experience/manifest.json']!),
      );
      manifest['personas'][0]['avatar'] = '../private.png';
      b.json('assets/experience/manifest.json', manifest);
      await expectLater(
        ExperiencePersona.loadManifest(bundle: b),
        throwsFormatException,
      );
    },
  );

  test(
    'offline sources, relative dates, life and memory import are idempotent',
    () async {
      final b = fixture();
      await ExperiencePersona.loadManifest(bundle: b);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMessageHandler('flutter/assets', (message) async {
            final key = utf8.decode(message!.buffer.asUint8List());
            final bytes = b.files[key];
            return bytes == null ? null : ByteData.sublistView(bytes);
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMessageHandler('flutter/assets', null),
      );
      final life = LocalLife(MemoryPersistence());
      addTearDown(life.dispose);
      await ExperiencePersona.seedInto(
        life,
        'sample',
        DateTime.utc(2026, 2, 3),
      );
      await ExperiencePersona.seedInto(
        life,
        'sample',
        DateTime.utc(2030, 2, 3),
      );
      expect(life.life['todos'], hasLength(1));
      expect(life.life['todos'][0]['due'], '2026-02-04');
      final sources = await ExperiencePersonaSources.load('sample');
      addTearDown(sources.snapshot.dispose);
      final storage = MemoryPersistence();
      await sources.restoreSnapshot(storage);
      final tools = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) => throw StateError('forbidden'),
        readEvidence: (args) async => sources.read(args),
        allowedNames: const {'source.read'},
      );
      final query = {'offset': 0, 'query': 'tea'};
      final definition = tools.resolve('source_read', query);
      expect(
        (await tools.execute(definition, query, 'sample-read'))['records'],
        hasLength(1),
      );
      expect(
        () => tools.resolve('source_read', {'offset': -1}),
        throwsA(isA<AgentFailure>()),
      );
      expect(sources.timelineTime(['r0002'])['scheduled_on'], '2026-01-02');
      expect(
        () => sources.validateSnapshot({
          'profile': [
            {
              'title': 'Wrong',
              'text': 'Wrong',
              'refs': ['foreign'],
            },
          ],
          'timeline': [],
        }),
        throwsFormatException,
      );
      final memory = LocalMemoryStore(MemoryPersistence());
      await memory.open();
      addTearDown(memory.close);
      await sources.seedMemory(memory);
      await sources.seedMemory(memory);
      expect(memory.recall('tea'), hasLength(1));
      await memory.forget(memory.recall('tea').single.id);
      await sources.seedMemory(memory);
      expect(memory.recall('tea'), isEmpty);
      await sources.replaceSnapshot(
        sources.snapshot.value!,
        storage,
        () => false,
      );
      expect(await storage.read(), isNull);
    },
  );

  test(
    'quality snapshot accepts bounded detail and owned references only',
    () async {
      final b = fixture();
      const base = 'assets/experience/';
      final refs = List.generate(65, (i) => 'r${i.toString().padLeft(4, '0')}');
      b.json('${base}sample.sources.json', {
        'records': [
          for (final ref in refs)
            {
              'id': ref,
              'kind': 'im',
              'locator': 'synthetic://sample/$ref',
              'observed_at': '2026-01-01T02:00:00Z',
              'text': 'Generic source $ref',
            },
        ],
      });
      final manifest = jsonDecode(
        utf8.decode(b.files['${base}manifest.json']!),
      );
      manifest['personas'][0]['sha256']['sources'] = sha256
          .convert(b.files['${base}sample.sources.json']!)
          .toString();
      b.json('${base}manifest.json', manifest);
      await ExperiencePersona.loadManifest(bundle: b);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMessageHandler('flutter/assets', (message) async {
            final bytes = b.files[utf8.decode(message!.buffer.asUint8List())];
            return bytes == null ? null : ByteData.sublistView(bytes);
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMessageHandler('flutter/assets', null),
      );
      final sources = await ExperiencePersonaSources.load('sample');
      addTearDown(sources.snapshot.dispose);
      Map<String, dynamic> row(
        String body, {
        int length = 2600,
        int count = 64,
      }) => {
        'title': 'Generic detail',
        body: '字' * length,
        'refs': refs.take(count).toList(),
      };
      Map<String, dynamic> snapshot() => {
        'source_version': sources.version,
        'profile': List.generate(40, (_) => row('text')),
        'timeline': List.generate(200, (_) => row('summary')),
      };
      expect(sources.validateSnapshot(snapshot())['timeline'], hasLength(200));
      final time = <String, dynamic>{
        'kind': 'deadline',
        'anchor_date': '2026-01-05',
        'anchor_basis': 'deadline',
        'occurred_on': null,
        'started_on': null,
        'due_on': '2026-01-05',
        'scheduled_on': null,
        'last_reported_on': '2026-01-01',
        'evidence_from': '2026-01-01',
        'evidence_to': '2026-01-01',
        'as_of': '2026-01-06',
      };
      Map<String, dynamic> withTime(Object? value) => {
        ...snapshot(),
        'timeline': [
          {...row('summary'), 'time': value},
        ],
      };
      final timed = sources.validateSnapshot(withTime(time));
      expect(timed['timeline'][0]['time'], time);
      sources.snapshot.value = timed;
      final timeline = ExperiencePersonaTimeline(
        personaId: 'sample',
        sources: sources,
      );
      expect(timeline.todayBriefCount(DateTime(2026, 1, 5)), 1);
      expect(timeline.todayBriefCount(DateTime(2026, 1, 1)), 0);
      sources.snapshot.value = {
        ...snapshot(),
        'timeline': [row('summary')],
      };
      expect(timeline.todayBriefCount(DateTime(2026, 1, 1)), 1);
      for (final invalid in [
        null,
        {...time, 'kind': 'invalid'},
        {...time, 'anchor_basis': 'invalid'},
        {...time, 'due_on': '2026-02-30'},
        {...time, 'anchor_date': '2026-1-5'},
        {...time, 'as_of': null},
        {...time, 'unexpected': true},
        Map.of(time)..remove('started_on'),
      ]) {
        expect(
          () => sources.validateSnapshot(withTime(invalid)),
          throwsFormatException,
        );
      }
      expect(
        () => sources.validateSnapshot({
          ...snapshot(),
          'profile': [
            {...row('text'), 'time': time},
          ],
        }),
        throwsFormatException,
      );

      for (final section in ['profile', 'timeline']) {
        final body = section == 'profile' ? 'text' : 'summary';
        for (final invalid in [
          row(body, length: 2601),
          row(body, count: 65),
          {...row(body), 'unexpected': true},
          {
            ...row(body),
            'refs': ['foreign'],
          },
          {
            ...row(body),
            'refs': [refs.first, refs.first],
          },
        ]) {
          final data = snapshot();
          data[section] = [invalid];
          expect(() => sources.validateSnapshot(data), throwsFormatException);
        }
        final data = snapshot();
        (data[section] as List).add(row(body));
        expect(() => sources.validateSnapshot(data), throwsFormatException);
      }
      expect(
        () => sources.validateSnapshot({
          ...snapshot(),
          'source_version': 'wrong',
        }),
        throwsFormatException,
      );
      expect(
        () => sources.validateSnapshot({...snapshot(), 'unexpected': true}),
        throwsFormatException,
      );
    },
  );

  test(
    'profile grants reserve full request duration and text retains short margin',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'novacore.experience.installation.v1': 's' * 43,
        'novacore.experience.tester.v1': 'tester_sample',
      });
      expect(
        ExperienceSession.profileRequestTimeout,
        const Duration(seconds: 245),
      );
      final calls = <String>[];
      final session = ExperienceSession(
        request: (uri, body, bearer) async {
          calls.add(body!['scope'] as String);
          return Uint8List.fromList(
            utf8.encode(
              jsonEncode({
                'tester_id': 'tester_sample',
                'token': 'a' * 43,
                'expires_at': DateTime.now().millisecondsSinceEpoch + 240000,
              }),
            ),
          );
        },
      );
      addTearDown(session.dispose);
      for (final scope in ['profile', 'text']) {
        await session.token('tester_sample', scope);
        await session.token('tester_sample', scope);
      }
      expect(calls, ['profile', 'profile', 'text']);
    },
  );

  test(
    'profile response accepts large quality output and keeps a finite cap',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'novacore.experience.installation.v1': 's' * 43,
        'novacore.experience.tester.v1': 'tester_sample',
      });
      var length = 128 * 1024;
      final session = ExperienceSession(
        request: (uri, body, bearer) async {
          return Uint8List.fromList(
            utf8.encode(
              jsonEncode(
                uri.path.endsWith('/token')
                    ? {
                        'tester_id': 'tester_sample',
                        'token': 'a' * 43,
                        'expires_at':
                            DateTime.now().millisecondsSinceEpoch + 300000,
                      }
                    : {'detail': 'x' * length},
              ),
            ),
          );
        },
      );
      addTearDown(session.dispose);
      expect(
        (await session.refreshPersona('sample', 'b' * 64))['detail'],
        hasLength(length),
      );
      length = 1024 * 1024;
      await expectLater(
        session.refreshPersona('sample', 'b' * 64),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test('space switch rejects the atomic profile write', () async {
    final dir = await Directory.systemTemp.createTemp('experience-snapshot-');
    addTearDown(() => dir.delete(recursive: true));
    final storage = PersonaSnapshotPersistence(
      File('${dir.path}/snapshot.json'),
      isCurrent: () => false,
    );
    await expectLater(storage.write('late result'), throwsStateError);
    expect(await storage.file.exists(), isFalse);
    expect(await dir.list().toList(), isEmpty);
  });

  test('device enrollment grants text and persona profile access', () async {
    FlutterSecureStorage.setMockInitialValues({
      ModelSettings.supportStorageKey: jsonEncode({
        'protocol': 'chatCompletions',
        'endpoint': 'https://personal.example/v1',
        'model': 'personal-model',
        'credentialId': 'personal',
      }),
    });
    final calls = <(Uri, Map<String, Object>?, String?)>[];
    final session = ExperienceSession(
      request: (uri, body, bearer) async {
        calls.add((uri, body, bearer));
        return Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'tester_id': 'tester_sample',
              'token': 'a' * 43,
              'expires_at': DateTime.now().millisecondsSinceEpoch + 300000,
            }),
          ),
        );
      },
    );
    addTearDown(session.dispose);
    await expectLater(
      session.model(),
      throwsA(
        isA<AgentFailure>().having(
          (e) => e.code,
          'code',
          'experience_enrollment_required',
        ),
      ),
    );
    expect(calls, isEmpty);
    await session.redeem('sample-code');
    final secret = calls.single.$2!['installation_secret'] as String;
    expect(secret, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
    final model = await session.model();
    expect(model.endpoint, 'https://api.deepnovacore.com/novacore/beta/v1');
    expect(model.model, 'deepseek-flash');
    expect(calls.where((c) => c.$1.path.endsWith('/token')), hasLength(1));
    expect(calls.last.$2!['scope'], 'text');
    expect(calls.last.$2!['installation_secret'], secret);
    await session.refreshPersona('sample', 'b' * 64);
    expect(calls.last.$1.path, '/novacore/beta/persona-profile');
    expect(calls[calls.length - 2].$2!['scope'], 'profile');
    expect(calls.last.$3, 'a' * 43);
    expect(calls.last.$2, {'persona_id': 'sample', 'source_version': 'b' * 64});
  });

  for (final revokeAfterTool in [false, true]) {
    test(
      'managed round renews short grant without replaying tools, revoked: $revokeAfterTool',
      () async {
        FlutterSecureStorage.setMockInitialValues({
          'novacore.experience.installation.v1': 'a' * 43,
          'novacore.experience.tester.v1': 'tester_sample',
        });
        var grants = 0, mutations = 0;
        final session = ExperienceSession(
          request: (uri, body, _) async {
            expect(uri.path, '/novacore/beta/token');
            expect(body!['scope'], 'text');
            if (revokeAfterTool && mutations > 0) {
              throw const ExperienceFailure('enrollment_inactive');
            }
            grants++;
            return Uint8List.fromList(
              utf8.encode(
                jsonEncode({
                  'tester_id': 'tester_sample',
                  'token': grants.toString().padLeft(43, 'a'),
                  // Inside the session renewal margin, without sleeping or using a real model.
                  'expires_at': DateTime.now().millisecondsSinceEpoch + 1000,
                }),
              ),
            );
          },
        );
        addTearDown(session.dispose);
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        await store.ensureMain();
        final life = LocalLife(MemoryPersistence());
        await life.open();
        addTearDown(life.dispose);
        final journal = ToolJournal(MemoryPersistence());
        await journal.open();
        final model = _ShortGrantToolModel();
        final host = AgentCoreHost(
          store: store,
          settings: ModelSettings(headless: true),
          experienceModel: session.model,
          experiencePersona: true,
          clientFactory: () => model,
          tools: ToolRunner(
            journal: journal,
            registry: ToolRegistry(
              snapshot: () => life.life,
              mutate: (input, {required operationId}) async {
                mutations++;
                return life.mutate(input, operationId: operationId);
              },
              hasConflict: () => false,
              fetch: (_) => throw StateError('forbidden'),
              allowedNames: const {'life.create'},
            ),
          ),
        );
        addTearDown(host.dispose);
        await host.send(
          ConversationStore.mainId,
          'Save a sample task.',
          approve: (_) async => true,
        );
        expect(
          host.error,
          revokeAfterTool ? 'experience_enrollment_inactive' : isNull,
        );
        expect(mutations, 1);
        expect(life.life['todos'], hasLength(1));
        final results =
            (store.conversation(ConversationStore.mainId)['messages'] as List)
                .where((row) => row['role'] == 'tool')
                .toList();
        expect(results, hasLength(1));
        expect(results.single['tool_call_id'], 'sample-create');
        expect(model.keys, hasLength(revokeAfterTool ? 1 : 2));
        if (!revokeAfterTool) {
          expect(model.keys.toSet(), hasLength(2));
          expect(
            model.prompts.last.where((row) => row['role'] == 'tool'),
            hasLength(1),
          );
          expect(host.lastTurnCompleted, isTrue);
        }
      },
    );
  }

  test(
    'expired or foreign grants never become a model configuration',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'novacore.experience.installation.v1': 'a' * 43,
        'novacore.experience.tester.v1': 'tester_sample',
      });
      final session = ExperienceSession(
        request: (_, _, _) async => Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'tester_id': 'tester_other',
              'token': 'a' * 43,
              'expires_at': DateTime.now().millisecondsSinceEpoch + 300000,
            }),
          ),
        ),
      );
      addTearDown(session.dispose);
      await expectLater(
        session.model(),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'experience_invalid_response',
          ),
        ),
      );
    },
  );

  test(
    'old Space records retain their schema and experience fields round trip independently',
    () {
      const normal = SpaceRecord(
        id: 'normal',
        name: 'Mine',
        mode: SpaceMode.standalone,
      );
      expect(SpaceRecord.fromJson(normal.toJson()).personaId, isNull);
      final experience = SpaceRecord(
        id: 'experience',
        name: 'Sample',
        mode: SpaceMode.standalone,
        personaId: 'sample',
        experienceSeededAt: DateTime.utc(2026),
      );
      final restored = SpaceRecord.fromJson(experience.toJson());
      expect(restored.personaId, 'sample');
      expect(
        SpaceStorage.runScoped(normal, () => SpaceStorage.secureKey('key')),
        'key.space.normal',
      );
      expect(
        SpaceStorage.runScoped(restored, () => SpaceStorage.secureKey('key')),
        'key.space.experience',
      );
    },
  );

  test('persona Spaces can run phone tasks but not web or shell', () async {
    final requests = <Map<String, dynamic>>[];
    final tools = ToolRegistry(
      snapshot: () => <String, dynamic>{},
      mutate: (_, {required operationId}) async => <String, dynamic>{},
      hasConflict: () => false,
      fetch: (_) async => {'status': 'completed'},
      readProfile: (_, _) async => {'available': true},
      listDeviceApps: () async => {'apps': <Object>[]},
      requestDeviceTask: (input, id) async {
        requests.add(input);
        return {'status': 'completed', 'task_id': id};
      },
      allowedNames: experiencePersonaToolNames,
    );
    final names = tools.definitions.map((e) => e.wireName).toSet();
    expect(
      names,
      containsAll(['device_run_task', 'device_list_apps', 'profile_read']),
    );
    expect(names.intersection({'web_fetch', 'shell_execute'}), isEmpty);
    final args = {
      'goal': 'Open Meituan Waimai',
      'app_name': '美团外卖',
      'acceptance': 'Meituan Waimai home page is shown',
    };
    final definition = tools.resolve('device_run_task', args);
    expect(tools.needsApproval(definition, args), isFalse);
    expect(
      (await tools.execute(definition, args, 'p-1'))['status'],
      'completed',
    );
    expect(requests.single['app_name'], '美团外卖');
  });

  test('persona profile_read pages the persona snapshot, newest first', () {
    final snapshot = {
      'profile': [
        {
          'title': '关于我',
          'text': '独立设计师，周二周四夜骑',
          'refs': ['r1'],
        },
        {
          'title': '目前在做的事',
          'text': '作品集网站改版',
          'refs': ['r2'],
        },
      ],
      'timeline': [
        {
          'title': '旧事',
          'summary': '十月的签核',
          'refs': ['r3'],
          'time': {'kind': 'event', 'anchor_date': '2026-10-01'},
        },
        {
          'title': '新事',
          'summary': '导视物料交接',
          'refs': ['r4'],
          'time': {'kind': 'deadline', 'anchor_date': '2026-11-06'},
          'status_label': '已签核',
          'facts': [
            '周砚确认',
            {'text': '晚上8点交接'},
          ],
        },
      ],
    };
    final profile = readPersonaProfileForModel(snapshot, {
      'section': 'profile',
    });
    expect(profile['available'], isTrue);
    expect(profile['fictional_example'], isTrue);
    expect([for (final e in profile['entries']) e['title']], ['关于我', '目前在做的事']);
    expect(profile['entries'][0]['text'], '独立设计师，周二周四夜骑');
    expect(profile['entries'][0], isNot(contains('refs')));

    final timeline = readPersonaProfileForModel(snapshot, {
      'section': 'timeline',
    });
    expect([for (final e in timeline['entries']) e['title']], ['新事', '旧事']);
    expect(timeline['entries'][0], {
      'key': 'timeline-1',
      'title': '新事',
      'text': '导视物料交接',
      'date': '2026-11-06',
      'time_kind': 'deadline',
      'status': '已签核',
      'facts': ['周砚确认', '晚上8点交接'],
    });

    final filtered = readPersonaProfileForModel(snapshot, {
      'section': 'timeline',
      'query': '十月',
    });
    expect(filtered['total'], 1);
    expect(filtered['entries'].single['title'], '旧事');

    final paged = readPersonaProfileForModel(snapshot, {
      'section': 'profile',
      'offset': 1,
    });
    expect(paged['entries'].single['title'], '目前在做的事');
    expect(paged, isNot(contains('next_offset')));

    expect(
      readPersonaProfileForModel(null, {'section': 'profile'})['available'],
      isFalse,
    );
  });
}
