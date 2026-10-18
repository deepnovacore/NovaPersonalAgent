import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/background_execution.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class WaitingModel extends ModelClient {
  final ready = Completer<void>(), stopped = Completer<void>();
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration config,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    yield {'content': 'Working'};
    ready.complete();
    await stopped.future;
    throw const AgentFailure('cancelled');
  }

  @override
  void cancel() {
    if (!stopped.isCompleted) stopped.complete();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'concurrent leases keep independent expiry callbacks after one ends',
    () async {
      const channel = MethodChannel('nova/execution/v1');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final ids = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'begin') ids.add(call.arguments['id'] as String);
        return {'mode': 'continued'};
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final first = BackgroundExecution(), second = BackgroundExecution();
      var firstExpired = 0, secondExpired = 0;
      await first.begin(() => firstExpired++);
      await second.begin(() => secondExpired++);
      await second.progress(1, 'page');
      await first.end(success: true);
      final delivered = Completer<void>();
      messenger.handlePlatformMessage(
        'nova/execution/v1',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('expired', {'id': ids.last}),
        ),
        (_) => delivered.complete(),
      );
      await delivered.future;
      expect(firstExpired, 0);
      expect(secondExpired, 1);
      await second.end(success: false);
    },
  );
  test(
    'process death preserves the latest progress and never replays a tool',
    () async {
      final disk = MemoryPersistence();
      final store = ConversationStore(disk);
      await store.open();
      final id = await store.create();
      await store.append(id, {'role': 'user', 'content': 'build'});
      await store.checkpointTurn(id, {
        'draft': 'Building',
        'tool': 'artifact_write',
        'characters': 123,
      });
      final restored = ConversationStore(disk);
      await restored.open();
      final messages = restored.conversation(id)['messages'] as List;
      expect(messages.last['interrupted'], true);
      expect(messages.last['error'], 'process_interrupted');
      expect(messages.last['content'], 'Building');
      expect(messages.last['tool_calls'], isNull);
      final again = ConversationStore(disk);
      await again.open();
      expect(again.conversation(id)['messages'], hasLength(2));
    },
  );
  test(
    'system expiration cancels the turn, persists interruption and ends its lease',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      const channel = MethodChannel('nova/execution/v1');
      final calls = <MethodCall>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return {'mode': 'continued'};
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final settings = ModelSettings();
      await settings.storage.write(
        key: ModelSettings.storageKey,
        value: '{"endpoint":"https://example.com/v1","model":"m","key":"test"}',
      );
      final model = WaitingModel();
      final host = AgentCoreHost(
        store: store,
        settings: settings,
        clientFactory: () => model,
        backgroundExecution: BackgroundExecution(),
      );
      final sending = host.send(id, 'build');
      await model.ready.future;
      expect(calls.first.method, 'begin');
      final expired = Completer<void>();
      messenger.handlePlatformMessage(
        'nova/execution/v1',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('expired', {'id': calls.first.arguments['id']}),
        ),
        (_) => expired.complete(),
      );
      await expired.future;
      await sending;
      expect(host.busy, false);
      expect(host.error, 'background_expired');
      expect(calls.last.method, 'end');
      expect(calls.last.arguments['success'], false);
      final last = (store.conversation(id)['messages'] as List).last;
      expect(last['interrupted'], true);
      expect(last['error'], 'background_expired');
      expect(store.conversation(id)['active_turn'], isNull);
      host.dispose();
    },
  );
}
