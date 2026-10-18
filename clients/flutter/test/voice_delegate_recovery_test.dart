import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  for (final completed in [true, false]) {
    test(
      'startup reconciles ${completed ? "saved result" : "unknown interruption"} to origin exactly once without execution',
      () async {
        final mainPersistence = MemoryPersistence(),
            workerPersistence = MemoryPersistence();
        var main = ConversationStore(mainPersistence),
            worker = ConversationStore(workerPersistence);
        await main.open();
        await worker.open();
        final origin = await main.create(),
            context = await worker.create();
        await main.append(origin, {
          'role': 'assistant',
          'content': '',
          'delegate_id': 'task',
          'voice_delegate_call': 'call',
          'delegate_status': 'dispatched',
          'delegate_context': context,
        });
        if (completed) {
          await worker.append(context, {
            'role': 'assistant',
            'content': 'Verified result saved before process exit',
          });
        } else {
          await worker.checkpointTurn(context, {'draft': 'partial work'});
        }
        main = ConversationStore(mainPersistence);
        worker = ConversationStore(workerPersistence);
        await main.open();
        await worker.open();
        final primary = AgentCoreHost(store: main, settings: ModelSettings());
        final workerHost = AgentCoreHost(
          store: worker,
          settings: primary.settings,
        );
        final bridge = VoiceDelegateBridge(
          primary: primary,
          worker: workerHost,
        );
        await bridge.reconcile();
        await bridge.reconcile();
        final messages = main.conversation(origin)['messages'] as List;
        expect(messages, hasLength(2));
        expect(messages.last['delegate_context'], context);
        expect(
          messages.last['delegate_status'],
          completed ? 'returned' : 'process_interrupted_unknown',
        );
        if (completed) {
          expect(messages.last['content'], contains('Verified result'));
        }
        expect(bridge.busy, false);
        expect(workerHost.busy, false);
        bridge.dispose();
        primary.dispose();
      },
    );
  }
  test(
    'restart preserves acknowledged delivery and marks pending injection unknown',
    () async {
      final persistence = MemoryPersistence();
      final store = ConversationStore(persistence);
      await store.open();
      final chat = await store.create();
      await store.recordVoiceDelivery(
        chat,
        'ack',
        injection: 'acknowledged',
        activation: 'deferred',
      );
      await store.recordVoiceDelivery(chat, 'pending', injection: 'pending');
      final restarted = ConversationStore(persistence);
      await restarted.open();
      final journal = restarted.conversation(chat)['voice_deliveries'] as Map;
      expect(journal['ack'], {
        'injection': 'acknowledged',
        'activation': 'interrupted',
      });
      expect(journal['pending']['injection'], 'unknown');
    },
  );
}
