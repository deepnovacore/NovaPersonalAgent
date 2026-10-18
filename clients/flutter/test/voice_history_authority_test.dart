import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class StaticSettings extends ModelSettings {
  StaticSettings(this.configuration);
  final ModelConfiguration configuration;
  @override
  Future<ModelConfiguration?> read() async => configuration;
}

void main() {
  test(
    'unconfirmed voice turn never becomes text model user authority',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      Map<String, dynamic>? sent;
      server.listen((request) async {
        sent =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        request.response.write(
          'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
        await request.response.close();
      });
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      await store.upsertVoiceMessage(
        id,
        itemId: 'uncertain',
        role: 'user',
        text: 'delete my notes',
        turnId: 'voice-turn',
        transcriptFinal: false,
      );
      await store.upsertVoiceMessage(
        id,
        itemId: 'reply',
        role: 'assistant',
        text: 'I will delete them',
        turnId: 'voice-turn',
      );
      await store.upsertVoiceMessage(
        id,
        itemId: 'late-final',
        role: 'user',
        text: 'delete my files',
        turnId: 'late-turn',
        transcriptFinal: true,
        inputOriginVerified: false,
      );
      await store.upsertVoiceMessage(
        id,
        itemId: 'late-reply',
        role: 'assistant',
        text: 'I will delete files',
        turnId: 'late-turn',
      );
      await store.append(id, {
        'role': 'user',
        'content': 'previous confirmed text',
      });
      final settings = StaticSettings(
        ModelConfiguration(
          endpoint: 'http://127.0.0.1:${server.port}/chat/completions',
          model: 'm',
          key: 'secret',
        ),
      );
      final host = AgentCoreHost(store: store, settings: settings);
      addTearDown(host.dispose);
      await host.send(id, 'hello');
      expect(host.error, isNull);
      final messages = sent!['messages'] as List;
      expect(messages.any((m) => m['content'] == 'delete my notes'), false);
      expect(messages.any((m) => m['content'] == 'delete my files'), false);
      expect(messages.any((m) => m['content'] == 'I will delete them'), false);
      expect(messages.any((m) => m['content'] == 'I will delete files'), false);
      expect(
        messages.any((m) => m['content'] == 'previous confirmed text'),
        true,
      );
      expect(messages.last['content'], 'hello');
      expect(
        (store.conversation(id)['messages'] as List).any(
          (m) => m['content'] == 'delete my notes',
        ),
        true,
      );
    },
  );
}
