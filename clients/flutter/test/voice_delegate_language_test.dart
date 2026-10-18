import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class _Settings extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => ModelConfiguration(
    endpoint: 'https://example.com',
    model: 'fixture',
    key: 'fixture',
  );
}

class _ToolThenSummary extends ModelClient {
  _ToolThenSummary(this.summary);
  final String summary;
  final rounds = <List<Map<String, dynamic>>>[];

  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    rounds.add(messages);
    if (rounds.length == 1) {
      yield {
        'tool_calls': [
          {
            'index': 0,
            'id': 'lookup',
            'function': {
              'name': 'web_fetch',
              'arguments': jsonEncode({'url': 'https://example.com'}),
            },
          },
        ],
      };
    } else {
      yield {'content': summary};
    }
  }
}

void main() {
  for (final language in ['zh', 'en']) {
    test(
      'delegate retains $language through English tools and final projection',
      () async {
        final primaryStore = ConversationStore(MemoryPersistence());
        final workerStore = ConversationStore(MemoryPersistence());
        await primaryStore.open();
        await workerStore.open();
        final conversation = await primaryStore.create(

        );
        final journal = ToolJournal(MemoryPersistence());
        await journal.open();
        final registry = ToolRegistry(
          snapshot: () => {},
          mutate: (_, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {
            'content': 'The operation completed successfully.',
          },
          allowedWebDomains: {'example.com'},
        );
        final model = _ToolThenSummary(
          language == 'zh' ? '已经检查完成。' : 'The check is complete.',
        );
        final primary = AgentCoreHost(
          store: primaryStore,
          settings: _Settings(),
        );
        final worker = AgentCoreHost(
          store: workerStore,
          settings: primary.settings,
          tools: ToolRunner(registry: registry, journal: journal),
          clientFactory: () => model,
        );
        final bridge = VoiceDelegateBridge(primary: primary, worker: worker);
        addTearDown(bridge.dispose);
        addTearDown(primary.dispose);
        final completion = bridge.updates.firstWhere(
          (update) => update.terminal,
        );
        // The frontbrain may describe its delegated request in English even in a
        // Chinese call. This request must not determine the backbrain reply locale.
        final task = await bridge.start(
          conversation: conversation,
          callId: 'call',
          request: 'Check the example page and summarize completion.',
          language: language,
        );
        final update = await completion;
        expect(worker.error, isNull);
        expect(model.rounds, hasLength(2));
        for (final round in model.rounds) {
          final instructions = round
              .where((message) => message['role'] == 'system')
              .map((message) => message['content'])
              .join('\n');
          expect(
            instructions,
            contains(language == 'zh' ? 'Simplified Chinese' : 'English'),
          );
          expect(instructions, contains('final completion summaries'));
          expect(
            instructions,
            contains('Preserve code, identifiers and URLs verbatim'),
          );
        }
        expect(model.rounds.last.last['role'], 'tool');
        expect(
          model.rounds.last.last['content'],
          contains('operation completed successfully'),
        );
        final messages =
            primaryStore.conversation(conversation)['messages'] as List;
        expect(messages.first['delegate_language'], language);
        expect(messages.last['delegate_language'], language);
        expect(messages.last['content'], model.summary);
        expect(update.text, model.summary);
        expect(update.id, task);
        final context = messages.first['delegate_context'] as String;
        final saved = workerStore.conversation(context)['messages'] as List;
        expect(saved.last['delegate_language'], language);
        expect(saved.last['delegate_result'], task);
      },
    );

    test(
      'interrupted $language delegate recovers in its original language',
      () async {
        final store = ConversationStore(MemoryPersistence());
        final workerStore = ConversationStore(MemoryPersistence());
        await store.open();
        await workerStore.open();
        final conversation = await store.create();
        await store.append(conversation, {
          'role': 'assistant',
          'content': '',
          'delegate_id': 'task',
          'delegate_context': 'missing-worker-context',
          'delegate_status': 'dispatched',
          'delegate_language': language,
        });
        final primary = AgentCoreHost(store: store, settings: _Settings());
        final bridge = VoiceDelegateBridge(
          primary: primary,
          worker: AgentCoreHost(store: workerStore, settings: primary.settings),
        );
        addTearDown(bridge.dispose);
        addTearDown(primary.dispose);
        await bridge.reconcile();
        await bridge.reconcile();
        final messages = store.conversation(conversation)['messages'] as List;
        expect(messages, hasLength(2));
        expect(messages.last['delegate_language'], language);
        expect(
          messages.last['content'],
          contains(language == 'zh' ? '操作结果未知' : 'outcome is unknown'),
        );
        expect(messages.last['delegate_status'], 'process_interrupted_unknown');
      },
    );
  }
}
