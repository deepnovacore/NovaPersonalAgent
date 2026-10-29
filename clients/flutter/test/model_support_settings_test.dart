import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/chatgpt_accounts.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/space/space_storage.dart';

class RecordingNative implements LocalAgent {
  final calls = <String>[];
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    calls.add(method);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SpaceStorage.active = null;
  });
  tearDown(() => SpaceStorage.active = null);

  test(
    'support defaults to chat, saves independently, and resets to chat',
    () async {
      final native = RecordingNative();
      final models = ModelSettings(native: native);
      await models.save(
        endpoint: 'https://chat.example/v1',
        model: 'chat',
        key: 'chat-key',
      );
      expect(
        (await models.readForPurpose(ModelPurpose.support))!.model,
        'chat',
      );
      final chatRecord = await models.storage.read(
        key: ModelSettings.storageKey,
      );
      final credential = await models.credentials.save(
        endpoint: 'https://support.example/v1',
        key: 'support-key',
      );
      native.calls.clear();
      await models.saveSupport(
        endpoint: credential.endpoint,
        model: 'background',
        protocol: ModelProtocol.responses,
        credentialId: credential.id,
      );
      final support = (await models.readForPurpose(ModelPurpose.support))!;
      expect(support.model, 'background');
      expect(support.key, 'support-key');
      expect(support.protocol, ModelProtocol.responses);
      expect(
        (await models.readForPurpose(ModelPurpose.conversationText))!.model,
        'chat',
      );
      expect(
        await models.storage.read(key: ModelSettings.storageKey),
        chatRecord,
      );
      expect(await models.readSupportDraft(), {
        'endpoint': credential.endpoint,
        'model': 'background',
        'protocol': 'responses',
        'credentialId': credential.id,
      });
      expect(native.calls, isEmpty);
      await models.resetSupport();
      expect(await models.readSupportDraft(), isNull);
      expect(
        (await models.readForPurpose(ModelPurpose.support))!.model,
        'chat',
      );
      expect(native.calls, isEmpty);
    },
  );

  test(
    'explicit support never uses or switches the active OAuth account',
    () async {
      final native = RecordingNative();
      final models = ModelSettings(native: native);
      final oauth = jsonEncode({
        'active': 'fixture',
        'accounts': [
          {
            'client_id': 'fixture',
            'access_token': 'oauth-token',
            'model': 'oauth-chat',
            'scopes': ['chatgpt.tokens.use.direct'],
            'expires_at': DateTime.now()
                .add(const Duration(hours: 1))
                .millisecondsSinceEpoch,
          },
        ],
      });
      await models.storage.write(key: ChatGptAccounts.storageKey, value: oauth);
      final followed = (await models.readForPurpose(ModelPurpose.support))!;
      expect(followed.protocol, ModelProtocol.chatgptResponses);
      expect(followed.key, 'oauth-token');
      final credential = await models.credentials.save(
        endpoint: chatGptResource,
        key: 'api-key',
      );
      native.calls.clear();
      await models.saveSupport(
        endpoint: chatGptResource,
        model: 'background',
        credentialId: credential.id,
      );
      expect(
        (await models.readForPurpose(ModelPurpose.support))!.key,
        'api-key',
      );
      await models.resetSupport();
      expect(native.calls, isEmpty);
      expect(await models.storage.read(key: ChatGptAccounts.storageKey), oauth);
      expect((await models.credentials.list()).single.key, 'api-key');
      await expectLater(
        models.saveSupport(
          endpoint: chatGptResource,
          model: 'background',
          credentialId: credential.id,
          protocol: ModelProtocol.chatgptResponses,
        ),
        throwsA(isA<AgentFailure>()),
      );
    },
  );

  test(
    'missing or wrong-scope support references fail closed without chat fallback',
    () async {
      final models = ModelSettings(native: RecordingNative());
      await models.save(
        endpoint: 'https://chat.example/v1',
        model: 'chat',
        key: 'chat-key',
      );
      final selected = await models.credentials.save(
        endpoint: 'https://support.example/v1',
        key: 'selected',
      );
      await models.saveSupport(
        endpoint: selected.endpoint,
        model: 'support',
        credentialId: selected.id,
      );
      await models.credentials.delete(selected.id);
      await models.credentials.save(
        endpoint: selected.endpoint,
        key: 'replacement',
      );
      await expectLater(
        models.readForPurpose(ModelPurpose.support),
        throwsA(isA<AgentFailure>()),
      );
      final chat = (await models.credentials.resolve(
        'https://chat.example/v1',
      ))!;
      await expectLater(
        models.saveSupport(
          endpoint: selected.endpoint,
          model: 'support',
          credentialId: chat.id,
        ),
        throwsA(isA<AgentFailure>()),
      );
      expect((await models.read())!.model, 'chat');
    },
  );

  test(
    'support routes and change notifications stay pinned to their Space',
    () async {
      const spaceA = SpaceRecord(
        id: 'a',
        name: 'A',
        mode: SpaceMode.standalone,
      );
      const spaceB = SpaceRecord(
        id: 'b',
        name: 'B',
        mode: SpaceMode.standalone,
      );
      SpaceStorage.active = spaceA;
      final a = ModelSettings(native: RecordingNative());
      final anotherA = ModelSettings(native: RecordingNative());
      SpaceStorage.active = spaceB;
      final b = ModelSettings(native: RecordingNative());
      var aChanges = 0, bChanges = 0;
      final aListener = anotherA.changes.listen((_) => aChanges++);
      final bListener = b.changes.listen((_) => bChanges++);
      addTearDown(aListener.cancel);
      addTearDown(bListener.cancel);
      final credential = await a.credentials.save(
        endpoint: 'https://support.example/v1',
        key: 'a-key',
      );
      await a.saveSupport(
        endpoint: credential.endpoint,
        model: 'a-model',
        credentialId: credential.id,
      );
      expect(
        (await anotherA.readForPurpose(ModelPurpose.support))!.key,
        'a-key',
      );
      expect(await b.readSupportDraft(), isNull);
      expect(await b.readForPurpose(ModelPurpose.support), isNull);
      expect(aChanges, 1);
      expect(bChanges, 0);
      await a.resetSupport();
      expect(aChanges, 2);
      expect(await anotherA.readSupportDraft(), isNull);
    },
  );
}
