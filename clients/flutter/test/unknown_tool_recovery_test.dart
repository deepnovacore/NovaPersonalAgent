import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';

import 'agent_core_test.dart' show MemoryPersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

/// Each round: an optional tool call (name), then the final text reply.
class _Model extends ModelClient {
  _Model(this.calls, {this.finalText = 'Done'});
  final List<String> calls;
  final String finalText;
  final prompts = <List<Map<String, dynamic>>>[];
  final offered = <List<String>>[];
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    final round = prompts.length;
    prompts.add(messages);
    offered.add([for (final t in tools) t['function']['name'] as String]);
    if (round < calls.length) {
      final args = calls[round] == 'life_list' ? {'kind': 'todo'} : {};
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'call-$round',
            'function': {'name': calls[round], 'arguments': jsonEncode(args)},
          },
        ],
      };
    } else {
      yield {'content': finalText};
    }
  }
}

Future<(AgentCoreHost, ConversationStore, String)> _host(_Model model) async {
  final store = ConversationStore(MemoryPersistence());
  await store.open();
  final id = await store.create();
  final journal = ToolJournal(MemoryPersistence());
  await journal.open();
  final host = AgentCoreHost(
    store: store,
    settings: FixtureSettings(),
    clientFactory: () => model,
    tools: ToolRunner(
      journal: journal,
      registry: ToolRegistry(
        snapshot: () => {
          'todos': <dynamic>[],
          'ideas': <dynamic>[],
          'goals': <dynamic>[],
        },
        mutate: (_, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        automaticExecution: true,
      ),
    ),
  );
  addTearDown(host.dispose);
  return (host, store, id);
}

Map<String, dynamic> _toolResult(
  ConversationStore store,
  String id,
  String call,
) =>
    jsonDecode(
          ((store.conversation(id)['messages'] as List).firstWhere(
                    (m) => m['tool_call_id'] == call,
                  )
                  as Map)['content']
              as String,
        )
        as Map<String, dynamic>;

void main() {
  test('an invented tool name is corrected and the task continues', () async {
    final model = _Model(['edit_placeholder_ignore', 'life_list']);
    final (host, store, id) = await _host(model);
    await host.send(id, 'Edit the site', approve: (_) async => true);
    expect(host.error, isNull);
    final rejected = _toolResult(store, id, 'call-0');
    expect(rejected['error'], 'unknown_tool');
    expect(rejected['executed'], isFalse);
    expect(rejected['available_tools'], contains('life_list'));
    // The next round still offers tools and the real call runs.
    expect(model.offered[1], isNotEmpty);
    expect(_toolResult(store, id, 'call-1')['status'], 'completed');
    expect(
      (store.conversation(id)['messages'] as List).last['content'],
      'Done',
    );
  });

  test('repeated invented names still stop after two corrections', () async {
    final model = _Model(['nope_a', 'nope_b', 'nope_c']);
    final (host, store, id) = await _host(model);
    await host.send(id, 'Edit the site', approve: (_) async => true);
    expect(host.error, 'tool_rejected');
    expect(_toolResult(store, id, 'call-1')['error'], 'unknown_tool');
    expect(_toolResult(store, id, 'call-2').containsKey('error'), isFalse);
    // The explanation round offers no tools.
    expect(model.offered.last, isEmpty);
  });

  test(
    'tool-call markup written as text never reaches the transcript',
    () async {
      const markup =
          '<｜DSML｜function_calls>\n<｜DSML｜invoke name="file_edit">\n'
          '<｜DSML｜parameter name="path" string="true">/workspace/index.html'
          '</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
      final model = _Model([], finalText: '我先改一下首页。\n$markup');
      final (host, store, id) = await _host(model);
      await host.send(id, 'Edit the site', approve: (_) async => true);
      final reply =
          (store.conversation(id)['messages'] as List).last['content'];
      expect(reply, '我先改一下首页。');
      expect(stripToolCallMarkup('plain answer'), 'plain answer');
      expect(stripToolCallMarkup('<|DSML|function_calls>'), '');
    },
  );
}
