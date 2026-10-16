import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class FakeNative implements LocalAgent {
  Map<String, dynamic>? saved;
  bool fail = false;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    expect(method, 'saveModelSettings');
    if (fail) throw StateError('secret');
    saved = input;
    return {};
  }
}

class FakeModel extends ModelClient {
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    expect(configuration.key, 'secret');
    expect(messages.last['content'], 'hello');
    yield {'content': 'Hello'};
    yield {'content': ' there'};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test(
    'Dart settings project to native; blank key preserves only same endpoint',
    () async {
      final native = FakeNative();
      final settings = ModelSettings(native: native);
      await settings.save(
        endpoint: 'https://example.com/v1',
        model: 'm',
        key: 'secret',
      );
      expect(native.saved!['key'], 'secret');
      expect((await settings.read())!.model, 'm');
      await settings.save(
        endpoint: 'https://example.com/v1',
        model: 'm2',
        key: '',
      );
      expect(native.saved!['key'], 'secret');
      await expectLater(
        settings.save(
          endpoint: 'https://other.example/v1',
          model: 'm',
          key: '',
        ),
        throwsA(isA<AgentFailure>()),
      );
      native.fail = true;
      await expectLater(
        settings.save(endpoint: 'https://example.com/v1', model: 'm3', key: ''),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'safe error',
            'model_settings_projection_failed',
          ),
        ),
      );
      expect((await settings.read())!.model, 'm3');
    },
  );
  testWidgets(
    'local chat sends streaming response and persists without credentials',
    (tester) async {
      final persistence = MemoryPersistence();
      final store = ConversationStore(persistence);
      await store.open();
      final id = await store.create(computerConnected: false);
      final settings = ModelSettings(native: FakeNative());
      await settings.save(
        endpoint: 'https://example.com/v1',
        model: 'm',
        key: 'secret',
      );
      final host = AgentCoreHost(
        store: store,
        settings: settings,
        clientFactory: FakeModel.new,
      );
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,
              computerConnected: false,
            ),
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'hello');
      await tester.tap(find.byTooltip('发送'));
      await tester.pumpAndSettle();
      expect(find.text('Hello there'), findsOneWidget);
      expect(host.busy, false);
      expect(host.error, isNull);
      expect(persistence.value, isNot(contains('secret')));
      expect(persistence.value, isNot(contains('example.com')));
      final restored = ConversationStore(persistence);
      await restored.open();
      expect(
        (restored.conversation(id)['messages'] as List).last['content'],
        'Hello there',
      );
    },
  );
}
