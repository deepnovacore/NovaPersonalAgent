import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'conversation_send_ownership_test.dart' show PlainReplySettings;

class _ToolRounds extends ModelClient {
  _ToolRounds({this.finishAfter});
  final int? finishAfter;
  int requests = 0;

  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration config,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    requests++;
    if (finishAfter != null && requests > finishAfter!) {
      yield {'content': 'Verified and finished'};
    } else {
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'read-$requests',
            'function': {
              'name': 'web_fetch',
              'arguments': '{"url":"https://example.com/read-$requests"}',
            },
          },
        ],
      };
    }
  }
}

void main() {
  for (final scenario in ['finish', 'limit', 'cancel']) {
    test('mobile tool rounds: $scenario', () async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final chat = await store.create();
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final model = _ToolRounds(finishAfter: scenario == 'finish' ? 32 : null);
      var executions = 0;
      late AgentCoreHost host;
      host = AgentCoreHost(
        store: store,
        settings: PlainReplySettings(),
        clientFactory: () => model,
        tools: ToolRunner(
          journal: journal,
          registry: ToolRegistry(
            snapshot: () => {},
            mutate: (_, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async {
              executions++;
              if (scenario == 'cancel' && executions == 30) host.cancel();
              return {'fixture': true};
            },
          ),
        ),
      );
      addTearDown(host.dispose);
      await host.send(
        chat,
        'Complete the multi-step task',
        approve: (_) async => true,
      );
      expect(host.busy, false);
      final messages = store.conversation(chat)['messages'] as List;
      expect(messages.where((m) => m['role'] == 'tool'), hasLength(executions));
      if (scenario == 'finish') {
        expect(host.error, isNull);
        expect(executions, 32);
        expect(model.requests, 33);
        expect(messages.last['content'], 'Verified and finished');
      } else if (scenario == 'limit') {
        expect(host.error, 'tool_round_limit');
        expect(executions, 128);
        expect(model.requests, 128);
      } else {
        expect(host.error, 'cancelled');
        expect(executions, 30);
        expect(model.requests, 30);
      }
    });
  }
}
