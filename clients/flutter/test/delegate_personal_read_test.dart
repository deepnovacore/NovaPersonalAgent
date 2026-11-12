import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_tool.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/memory/local_memory_store.dart';
import 'package:nova_mobile/space/space_storage.dart';

import 'agent_core_test.dart' show MemoryPersistence;
import 'local_life_test.dart' show MemoryLifePersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

Map<String, dynamic> _emptyLife() => {
  'todos': <dynamic>[],
  'ideas': <dynamic>[],
  'goals': <dynamic>[],
  'profile': {'about': '', 'version': 0},
};

/// Replays one scripted tool round per request, then answers with text.
class _ScriptedModel extends ModelClient {
  _ScriptedModel(this.rounds);
  final List<List<(String, Map<String, dynamic>)>> rounds;
  final prompts = <List<Map<String, dynamic>>>[];
  final advertised = <List<String>>[];
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    final round = prompts.length;
    prompts.add(messages.map(Map<String, dynamic>.from).toList());
    advertised.add([for (final t in tools) t['function']['name'] as String]);
    if (round >= rounds.length) {
      yield {'content': 'Done'};
      return;
    }
    yield {
      'tool_calls': [
        for (final (i, (name, args)) in rounds[round].indexed)
          {
            'index': i,
            'id': 'call-$round-$i',
            'function': {'name': name, 'arguments': jsonEncode(args)},
          },
      ],
    };
  }
}

Future<(AgentCoreHost, ConversationStore, String, _ScriptedModel)> _delegate({
  required LocalMemoryStore memory,
  required List<List<(String, Map<String, dynamic>)>> rounds,
  required Future<Map<String, dynamic>> Function(Map<String, dynamic>)
  readProfile,
}) async {
  final store = ConversationStore(MemoryPersistence());
  await store.open();
  final id = await store.create();
  final journal = ToolJournal(MemoryPersistence());
  await journal.open();
  final model = _ScriptedModel(rounds);
  final host = AgentCoreHost(
    store: store,
    settings: FixtureSettings(),
    allowLocalMemory: false,
    memoryReadOnly: true,
    clientFactory: () => model,
    tools: ToolRunner(
      journal: journal,
      registry: ToolRegistry(
        snapshot: _emptyLife,
        mutate: (_, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {'status': 200, 'body': 'page'},
        readProfile: readProfile,
        automaticExecution: true,
        localMemory: memory,
        spaceMode: SpaceMode.standalone,
      ),
    ),
  );
  addTearDown(host.dispose);
  return (host, store, id, model);
}

void main() {
  late LocalMemoryStore memory;
  setUp(() async {
    memory = LocalMemoryStore(MemoryPersistence());
    await memory.open();
    await memory.save(
      kind: 'preference',
      text: 'prefers a minimal dark design',
      quote: 'prefers a minimal dark design',
      userUtterance: 'prefers a minimal dark design',
    );
  });

  test(
    'delegate gets recall and profile_read, no saves, no summary, and loses web_fetch after a read',
    () async {
      final (host, store, id, model) = await _delegate(
        memory: memory,
        rounds: [
          [
            ('memory_recall', {'query': 'design'}),
            ('profile_read', {'section': 'profile'}),
          ],
        ],
        readProfile: (_) async => {
          'available': true,
          'entries': [
            {'key': 'about', 'text': 'private robotics engineer'},
          ],
        },
      );
      await host.send(
        id,
        'Build a personal website',
        userAuthored: false,
        approve: (_) async => true,
      );
      expect(host.error, isNull);
      final first = model.advertised.first;
      expect(
        first,
        containsAll(['memory_recall', 'profile_read', 'web_fetch']),
      );
      expect(first, isNot(contains('memory_remember')));
      expect(first, isNot(contains('memory_forget')));
      expect(model.advertised[1], isNot(contains('web_fetch')));
      expect(
        jsonEncode(model.prompts.first),
        isNot(contains('Local memory summary')),
      );
      // The live round sees both payloads; durable history keeps receipts only.
      final live = jsonEncode(model.prompts[1]);
      expect(live, contains('minimal dark design'));
      expect(live, contains('private robotics engineer'));
      final durable = jsonEncode(store.conversation(id));
      expect(durable, isNot(contains('minimal dark design')));
      expect(durable, isNot(contains('private robotics engineer')));
    },
  );

  test('a delegate cannot save memory even when it names the tool', () async {
    final (host, _, id, _) = await _delegate(
      memory: memory,
      rounds: [
        [
          (
            'memory_remember',
            {'kind': 'fact', 'text': 'x', 'quote': 'Build a site'},
          ),
        ],
      ],
      readProfile: (_) async => {'available': false},
    );
    await host.send(
      id,
      'Build a site',
      userAuthored: false,
      approve: (_) async => true,
    );
    expect(host.error, 'tool_rejected');
    expect(memory.recall('x'), isEmpty);
  });

  test('web_fetch stays available when no personal data was read', () async {
    final (host, _, id, model) = await _delegate(
      memory: memory,
      rounds: [
        [
          ('life_list', {'kind': 'todo'}),
        ],
      ],
      readProfile: (_) async => {'available': false},
    );
    await host.send(
      id,
      'What time is it',
      userAuthored: false,
      approve: (_) async => true,
    );
    expect(host.error, isNull);
    expect(model.advertised[1], contains('web_fetch'));
  });

  test(
    'forgetting a memory cancels a delegate turn that may hold it',
    () async {
      late String entry;
      entry = memory.recall('design').single.id;
      final (host, _, id, _) = await _delegate(
        memory: memory,
        rounds: [
          [
            ('memory_recall', {'query': 'design'}),
          ],
          [
            ('profile_read', {'section': 'profile'}),
          ],
        ],
        readProfile: (_) async {
          // The user forgets the recalled preference while the task runs.
          await memory.forget(entry);
          return {'available': false};
        },
      );
      await host.send(
        id,
        'Build a personal website',
        userAuthored: false,
        approve: (_) async => true,
      );
      expect(host.error, 'cancelled');
    },
  );

  group('readProfileForModel', () {
    late SourceStore sources;
    late LocalPublicationContext publication;
    late ProfileRepository profile;
    setUp(() async {
      final now = DateTime.utc(2026, 11, 12);
      final older = DateTime.utc(2026, 11, 1, 8);
      final newer = DateTime.utc(2026, 11, 9, 8);
      sources = SourceStore(MemoryLifePersistence(), now: () => now);
      await sources.bind('self', 1);
      await sources.select('c', older.subtract(const Duration(days: 1)));
      await sources.ingestPage(
        sources.fence('c'),
        [
          for (final (id, time) in [('m1', older), ('m2', newer)])
            {
              'message_id': id,
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${time.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {'content': '{"text":"synthetic plan $id"}'},
            },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await sources.grantProcessing('p', 'profile', true);
      publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      profile = ProfileRepository(
        MemoryLifePersistence(),
        publication,
        sources,
      );
      final refs = {
        for (final m in sources.messages('c'))
          m['message_id']: m['evidence_id'],
      };
      await profile.publish(
        jsonEncode([
          {
            'key': 'about',
            'kind': 'profile',
            'text': 'Builds voice agents',
            'evidence_ids': [refs['m1']],
          },
          for (final (key, id, time) in [
            ('older', 'm1', older),
            ('newer', 'm2', newer),
          ])
            {
              'key': key,
              'kind': 'timeline',
              'policy_revision': 2,
              'text': '$key project',
              'observed_at': time.toIso8601String(),
              'evidence_ids': [refs[id]],
            },
        ]),
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'p',
      );
      addTearDown(publication.dispose);
    });

    Future<Map<String, dynamic>> read(
      Map<String, dynamic> args, {
      String? provider = 'p',
    }) => readProfileForModel(
      repository: profile,
      sources: sources,
      provider: provider,
      args: args,
    );

    test('returns only the requested section, newest timeline first', () async {
      final about = await read({'section': 'profile'});
      expect(about['available'], isTrue);
      expect([for (final e in about['entries']) e['key']], ['about']);
      final timeline = await read({'section': 'timeline'});
      expect(
        [for (final e in timeline['entries']) e['key']],
        ['newer', 'older'],
      );
      expect(timeline['entries'].first['date'], '2026-11-09');
      final filtered = await read({'section': 'timeline', 'query': 'OLDER'});
      expect([for (final e in filtered['entries']) e['key']], ['older']);
    });

    test('a model without a processing grant reads nothing', () async {
      final result = await read({'section': 'profile'}, provider: 'other');
      expect(result['available'], isFalse);
      expect(result['reason'], 'processing_consent_required');
      expect(jsonEncode(result), isNot(contains('voice agents')));
      expect(
        (await read({'section': 'profile'}, provider: null))['reason'],
        'model_settings_required',
      );
    });

    test('a withdrawn grant hides the projection', () async {
      await sources.grantProcessing('p', 'profile', false);
      final result = await read({'section': 'profile'});
      expect(result['available'], isFalse);
      expect(jsonEncode(result), isNot(contains('voice agents')));
    });

    test('pages through results with next_offset', () async {
      final first = await read({'section': 'timeline', 'offset': 1});
      expect([for (final e in first['entries']) e['key']], ['older']);
      expect(first.containsKey('next_offset'), isFalse);
    });
  });
}
