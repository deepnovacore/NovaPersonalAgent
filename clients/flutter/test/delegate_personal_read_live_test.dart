// Opt-in live check: a real model, running as the voice delegate worker,
// builds a mobile personal website from the confirmed profile, timeline and
// recalled memory, then revises it, then works after a forget.
//
// NOVA_AGENT_LIVE_CONFIG points to a private JSON {endpoint, model, key}.
// NOVA_EVIDENCE_DIR (optional) receives the generated HTML and a tool-call
// summary. Credentials and prompts never reach the test log.
@Tags(['live'])
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
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

class _LiveSettings extends ModelSettings {
  _LiveSettings(this.config);
  final ModelConfiguration config;
  @override
  Future<ModelConfiguration?> read() async => config;
}

/// Records tool names the real model chose; never their payloads.
class _Recorder {
  final calls = <List<String>>[];
  final advertisedPerRound = <List<String>>[];
}

/// One client per turn, as in production: a finished turn closes its client.
class _Recording extends ModelClient {
  _Recording(this.log);
  final _Recorder log;
  List<List<String>> get calls => log.calls;
  List<List<String>> get advertisedPerRound => log.advertisedPerRound;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    advertisedPerRound.add([
      for (final t in tools) t['function']['name'] as String,
    ]);
    final names = <String>[];
    await for (final delta in super.stream(
      configuration,
      messages,
      tools: tools,
    )) {
      for (final call
          in (delta['tool_calls'] as List? ?? []).whereType<Map>()) {
        final name = (call['function'] as Map?)?['name'];
        if (name is String && name.isNotEmpty) names.add(name);
      }
      yield delta;
    }
    calls.add(names);
  }
}

void main() {
  final configPath = Platform.environment['NOVA_AGENT_LIVE_CONFIG'];
  test(
    'live delegate builds and revises a personal website from local data',
    () async {
      final raw =
          jsonDecode(await File(configPath!).readAsString())
              as Map<String, dynamic>;
      final config = ModelConfiguration(
        endpoint: raw['endpoint'] as String,
        model: raw['model'] as String,
        key: raw['key'] as String,
      );
      final provider = '${config.endpoint}|${config.model}';
      final evidence = Platform.environment['NOVA_EVIDENCE_DIR'];

      // Synthetic person: every fact the site may state comes from here.
      final now = DateTime.now().toUtc();
      final older = now.subtract(const Duration(days: 40));
      final newer = now.subtract(const Duration(days: 5));
      final sources = SourceStore(MemoryLifePersistence(), now: () => now);
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
              'body': {'content': '{"text":"synthetic source $id"}'},
            },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await sources.grantProcessing(provider, 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final profile = ProfileRepository(
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
            'text': '我叫林澈，在杭州做移动端 AI 助手的工程师，主要写 Flutter 和语音交互。',
            'evidence_ids': [refs['m1']],
          },
          {
            'key': 'interests',
            'kind': 'profile',
            'text': '业余喜欢骑行和拍胶片照片。',
            'evidence_ids': [refs['m1']],
          },
          {
            'key': 'tidepool',
            'kind': 'timeline',
            'policy_revision': 2,
            'text': '完成了「潮汐记账」小程序的离线同步，用户可以断网记账、联网后自动合并。',
            'observed_at': older.toIso8601String(),
            'evidence_ids': [refs['m1']],
          },
          {
            'key': 'echo',
            'kind': 'timeline',
            'policy_revision': 2,
            'text': '正在做「回声」语音笔记 App，刚上线了边说边整理成待办的功能。',
            'observed_at': newer.toIso8601String(),
            'evidence_ids': [refs['m2']],
          },
        ]),
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: provider,
      );

      final memory = LocalMemoryStore(MemoryPersistence());
      await memory.open();
      const preference = '我喜欢简洁的深色设计，手机页面不要太密';
      final saved = await memory.save(
        kind: 'preference',
        text: preference,
        quote: preference,
        userUtterance: '记住，$preference。',
      );

      final root = await Directory.systemTemp.createTemp('nova-live-site-');
      addTearDown(() => root.delete(recursive: true));
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final model = _Recorder();
      final host = AgentCoreHost(
        store: store,
        settings: _LiveSettings(config),
        allowLocalMemory: false,
        memoryReadOnly: true,
        owner: 'voice:delegate',
        clientFactory: () => _Recording(model),
        tools: ToolRunner(
          journal: journal,
          registry: ToolRegistry(
            snapshot: () => {
              'todos': <dynamic>[],
              'ideas': <dynamic>[],
              'goals': <dynamic>[],
              'profile': {'about': '', 'version': 0},
            },
            mutate: (_, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => throw StateError('offline fixture'),
            automaticExecution: true,
            workspace: AgentWorkspace(root),
            localMemory: memory,
            spaceMode: SpaceMode.standalone,
            readProfile: (args, receiving) => readProfileForModel(
              repository: profile,
              sources: sources,
              provider: receiving,
              args: args,
            ),
          ),
        ),
      );
      addTearDown(host.dispose);
      final summary = <String, dynamic>{'model': config.model, 'turns': []};
      Future<String> turn(String request) async {
        model.calls.clear();
        model.advertisedPerRound.clear();
        await host.send(
          id,
          request,
          userAuthored: false,
          language: 'zh',
          approve: (_) async => true,
        );
        final html = await _readSite(root);
        // Round r's tools are advertised before round r's calls run, so a
        // read in round r must withdraw web_fetch from round r + 1 onward.
        final rounds = [for (final r in model.calls) List<String>.of(r)];
        final advertised = [
          for (final r in model.advertisedPerRound) List<String>.of(r),
        ];
        final firstRead = rounds.indexWhere(
          (r) => r.contains('profile_read') || r.contains('memory_recall'),
        );
        (summary['turns'] as List).add({
          'error': host.error,
          'tool_rounds': rounds,
          'first_personal_read_round': firstRead,
          'web_fetch_advertised_after_read':
              firstRead >= 0 &&
              advertised
                  .skip(firstRead + 1)
                  .any((r) => r.contains('web_fetch')),
          'html_chars': html.length,
        });
        return html;
      }

      final first = await turn(
        '结合我的个人画像、最近的项目经历和设计偏好，做一个适合手机浏览的个人网站，保存为 /workspace/index.html。',
      );
      final tools = model.calls.expand((r) => r).toSet();
      expect(model.calls.length, model.advertisedPerRound.length);
      final firstTurn = (summary['turns'] as List).last as Map;
      if (evidence != null) {
        await File('$evidence/site-1.html').writeAsString(first);
      }
      expect(host.error, isNull);
      expect(tools, contains('profile_read'));
      expect(tools, contains('memory_recall'));
      expect(tools.intersection({'file_write', 'file_edit'}), isNotEmpty);
      expect(first, contains('林澈'));
      expect(first, contains('回声'));
      expect(first, contains('潮汐记账'));
      expect(first.toLowerCase(), contains('name="viewport"'));
      expect(firstTurn['web_fetch_advertised_after_read'], isFalse);
      // Nothing personal is replayable from durable history.
      final durable = jsonEncode(
        (store.conversation(id)['messages'] as List)
            .where((m) => m['role'] == 'tool')
            .toList(),
      );
      expect(durable, isNot(contains('不要太密')));
      expect(durable, isNot(contains('林澈')));

      final second = await turn('把最近那个项目放到首页最上面，介绍写得更口语一点。');
      if (evidence != null) {
        await File('$evidence/site-2.html').writeAsString(second);
      }
      expect(host.error, isNull);
      expect(second, isNot(first));
      expect(second.indexOf('回声'), lessThan(second.indexOf('潮汐记账')));

      await memory.forget(saved.id);
      expect(memory.recall('深色'), isEmpty);
      final third = await turn('按我现在保存的设计偏好检查一下网站配色，如果没有偏好就保持现状，告诉我依据。');
      if (evidence != null) {
        await File('$evidence/site-3.html').writeAsString(third);
      }
      final answer =
          ((store.conversation(id)['messages'] as List).lastWhere(
                    (m) => m['role'] == 'assistant',
                  )
                  as Map)['content']
              as String? ??
          '';
      summary['third_answer_mentions_dark_preference'] =
          answer.contains('深色') && answer.contains('偏好');
      if (evidence != null) {
        await File(
          '$evidence/summary.json',
        ).writeAsString(const JsonEncoder.withIndent('  ').convert(summary));
        await File('$evidence/answer-3.txt').writeAsString(answer);
      }
      expect(host.error, isNull);
      // Counts only, never content.
      // ignore: avoid_print
      print(jsonEncode(summary));
    },
    skip: configPath == null ? 'set NOVA_AGENT_LIVE_CONFIG' : false,
    timeout: const Timeout(Duration(minutes: 15)),
  );
}

Future<String> _readSite(Directory root) async {
  final file = File('${root.path}/index.html');
  return await file.exists() ? file.readAsString() : '';
}
