import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/chatgpt_accounts.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/provider_credentials.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

class Native implements LocalAgent {
  Map<String, dynamic>? projected;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    if (method == 'saveModelSettings') projected = input;
  }
}

class FailingStorage extends FlutterSecureStorage {
  String? failKey;
  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (key == failKey) throw StateError('write_failed');
    await super.write(key: key, value: value);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SpaceStorage.active = null;
  });
  tearDown(() => SpaceStorage.active = null);
  test('providers coexist and custom paths never share a key', () async {
    final store = ProviderCredentials();
    final a = await store.save(endpoint: 'https://api.openai.com/v1', key: 'a');
    await store.save(
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      key: 'q',
    );
    await store.save(endpoint: 'https://custom.example/v1', key: 'c');
    expect((await store.list()).length, 3);
    expect(
      (await store.resolve(IntegratedVoiceCatalog.openaiEndpoint))!.id,
      a.id,
    );
    expect(
      (await store.resolve(IntegratedVoiceCatalog.qwenEndpoint))!.key,
      'q',
    );
    expect(await store.resolve('https://custom.example/v1/responses'), isNull);
    expect(await store.resolve('https://custom.example/other'), isNull);
    expect(await store.resolve('https://dashscope.aliyuncs.com/other'), isNull);
  });
  test(
    'model switch and rotation retain provider keys and update native',
    () async {
      final native = Native();
      final models = ModelSettings(native: native);
      await models.save(
        endpoint: 'https://api.openai.com/v1',
        model: 'a',
        key: 'a-key',
      );
      await models.save(
        endpoint: 'https://api.stepfun.com/v1',
        model: 'b',
        key: 'b-key',
      );
      await models.save(
        endpoint: 'https://api.openai.com/v1',
        model: 'a2',
        key: '',
      );
      expect((await models.readApiKey())!.key, 'a-key');
      final a = (await models.credentials.resolve(
        'https://api.openai.com/v1',
      ))!;
      await models.credentials.save(
        id: a.id,
        endpoint: a.endpoint,
        key: 'rotated',
      );
      await models.refreshApiKeyProjection();
      expect((await models.read())!.key, 'rotated');
      expect(native.projected!['key'], 'rotated');
      await models.credentials.delete(a.id);
      await expectLater(models.readApiKey(), throwsA(isA<AgentFailure>()));
    },
  );
  test(
    'legacy conflicts migrate to stable refs without persisted voice secrets',
    () async {
      const storage = FlutterSecureStorage();
      await storage.write(
        key: ModelSettings.storageKey,
        value: jsonEncode({
          'endpoint': 'https://generativelanguage.googleapis.com/v1beta/openai',
          'model': 'chat',
          'key': 'chat-key',
        }),
      );
      final old = const VoiceConfiguration().copyWith(
        pipeline: VoicePipeline.cascaded,
        asr: const VoiceConfiguration().asr.copyWith(key: 'asr-key'),
        tts: const VoiceConfiguration().tts.copyWith(key: 'tts-key'),
        fastLlm: const VoiceServiceConfiguration(
          endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
          model: 'fast',
          key: 'chat-key',
        ),
      );
      await storage.write(
        key: VoiceSettings.storageKey,
        value: jsonEncode(old.toJson()),
      );
      await ModelSettings(native: Native()).readApiKey();
      final voice = VoiceSettings();
      final draft = (await voice.readDraft())!;
      expect(draft.asr.key, isEmpty);
      expect(draft.asr.credentialId, isNotNull);
      expect((await voice.credentials.list()).length, 3);
      expect((await voice.read())!.asr.key, 'asr-key');
      expect((await voice.readForDictation())!.asr.key, 'asr-key');
      expect((await voice.read())!.tts.key, 'tts-key');
      final raw = (await storage.read(key: VoiceSettings.storageKey))!;
      expect(raw.contains('asr-key'), isFalse);
      expect(raw.contains('tts-key'), isFalse);
      final asr = (await voice.credentials.get(draft.asr.credentialId!))!;
      await voice.credentials.save(
        id: asr.id,
        endpoint: asr.endpoint,
        key: 'rotated',
      );
      await voice.save(draft.copyWith(tts: draft.tts.copyWith(voice: 'Puck')));
      expect((await voice.readDraft())!.asr.credentialId, asr.id);
      expect((await voice.readForDictation())!.asr.key, 'rotated');
      await voice.credentials.delete(asr.id);
      await expectLater(voice.readForDictation(), throwsA(isA<AgentFailure>()));
      expect((await voice.credentials.list()).length, 2);
    },
  );
  test('failed or corrupt registry never rewrites legacy originals', () async {
    final storage = FailingStorage();
    final raw = jsonEncode({
      'endpoint': 'https://api.openai.com/v1',
      'model': 'chat',
      'key': 'original',
    });
    await storage.write(key: ModelSettings.storageKey, value: raw);
    storage.failKey = ProviderCredentials.storageKey;
    await expectLater(
      ModelSettings(storage: storage, native: Native()).readApiKey(),
      throwsA(isA<AgentFailure>()),
    );
    expect(await storage.read(key: ModelSettings.storageKey), raw);
    storage.failKey = null;
    await storage.write(key: ProviderCredentials.storageKey, value: 'corrupt');
    await expectLater(
      ModelSettings(storage: storage, native: Native()).readApiKey(),
      throwsA(isA<AgentFailure>()),
    );
    expect(await storage.read(key: ModelSettings.storageKey), raw);
    await storage.delete(key: ProviderCredentials.storageKey);
    final models = ModelSettings(storage: storage, native: Native());
    expect((await models.readApiKey())!.key, 'original');
    expect((await models.credentials.list()).length, 1);
    expect((await models.credentials.list()).length, 1);
  });
  test('concurrent instances serialize registry updates', () async {
    await Future.wait(
      List.generate(
        12,
        (i) => SpaceStorage.runScoped(
          SpaceRecord(
            id: 'space-$i',
            name: 'Space $i',
            mode: SpaceMode.standalone,
          ),
          () => ProviderCredentials().save(
            endpoint: 'https://custom.example/provider/$i',
            key: 'key-$i',
          ),
        ),
      ),
    );
    expect((await ProviderCredentials().list()).length, 12);
  });
  test(
    'malformed unrelated legacy service does not block valid providers',
    () async {
      const storage = FlutterSecureStorage();
      final raw = jsonEncode({
        'endpoint': 'http://unsafe.example/v1',
        'model': 'broken',
        'key': 'preserved',
      });
      await storage.write(key: ModelSettings.storageKey, value: raw);
      final credentials = ProviderCredentials();
      await credentials.save(
        endpoint: 'https://api.openai.com/v1',
        key: 'valid',
      );
      expect((await credentials.list()).single.key, 'valid');
      expect(await storage.read(key: ModelSettings.storageKey), raw);
      final voice = VoiceSettings();
      await voice.credentials.save(
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        key: 'voice',
      );
      await voice.save(const VoiceConfiguration());
      expect((await voice.read())!.integrated.key, 'voice');
    },
  );
  test(
    'unused incomplete service never blocks the selected pipeline',
    () async {
      final voice = VoiceSettings();
      await voice.credentials.save(
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        key: 'voice',
      );
      final draft = const VoiceConfiguration().copyWith(
        asr: const VoiceServiceConfiguration(
          endpoint: 'http://unfinished.example/asr',
        ),
      );
      expect((await voice.save(draft)).integrated.key, 'voice');
      expect((await voice.read())!.integrated.key, 'voice');
    },
  );
  test(
    'central credentials preserve OAuth mode and never borrow its token',
    () async {
      const storage = FlutterSecureStorage();
      final oauth = jsonEncode({
        'active': 'oaiapp_test',
        'accounts': [
          {
            'client_id': 'oaiapp_test',
            'access_token': 'oauth-token',
            'model': 'chat',
          },
        ],
      });
      await storage.write(key: ChatGptAccounts.storageKey, value: oauth);
      final native = Native();
      final models = ModelSettings(native: native);
      await models.credentials.save(
        endpoint: 'https://api.openai.com/v1',
        key: 'api-key',
      );
      await models.refreshApiKeyProjection();
      expect(await storage.read(key: ChatGptAccounts.storageKey), oauth);
      expect(native.projected, isNull);
      expect((await models.credentials.list()).single.key, 'api-key');
      final voice = VoiceSettings();
      await expectLater(
        voice.save(const VoiceConfiguration()),
        throwsA(isA<AgentFailure>()),
      );
      expect(
        (await voice.credentials.list()).any((e) => e.key == 'oauth-token'),
        isFalse,
      );
    },
  );
  test('Spaces share keys while voice selections stay scoped', () async {
    SpaceStorage.active = const SpaceRecord(
      id: 'a',
      name: 'A',
      mode: SpaceMode.standalone,
    );
    final modelA = ModelSettings(native: Native());
    final voiceA = VoiceSettings();
    SpaceStorage.active = const SpaceRecord(
      id: 'b',
      name: 'B',
      mode: SpaceMode.standalone,
    );
    await modelA.credentials.save(
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      key: 'a-key',
    );
    await ProviderCredentials().save(
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      key: 'b-key',
    );
    await voiceA.save(const VoiceConfiguration());
    expect((await voiceA.read())!.integrated.key, 'a-key');
    expect((await modelA.credentials.list()).map((e) => e.key), [
      'a-key',
      'b-key',
    ]);
    expect((await ProviderCredentials().list()).map((e) => e.key), [
      'a-key',
      'b-key',
    ]);
    expect(await VoiceSettings().readDraft(), isNull);
  });

  test(
    'experience opened first imports existing Space keys without changing routes',
    () async {
      const storage = FlutterSecureStorage();
      const endpoint = 'https://api.openai.com/v1';
      for (final id in ['own', 'experience']) {
        await storage.write(
          key: '${ProviderCredentials.storageKey}.space.$id',
          value: jsonEncode({
            'version': 1,
            'credentials': [
              {'id': id, 'endpoint': endpoint, 'label': id, 'key': '$id-key'},
            ],
          }),
        );
        await storage.write(
          key: '${ModelSettings.storageKey}.space.$id',
          value: jsonEncode({
            'endpoint': endpoint,
            'model': id,
            'credentialId': id,
          }),
        );
      }
      SpaceStorage.active = const SpaceRecord(
        id: 'experience',
        name: 'Experience',
        mode: SpaceMode.standalone,
        personaId: 'fixture',
      );
      final settings = ModelSettings(native: Native());
      expect((await settings.credentials.list()).map((e) => e.id).toSet(), {
        'own',
        'experience',
      });
      expect((await settings.read())!.key, 'experience-key');
      expect((await settings.read())!.model, 'experience');
      await settings.credentials.save(
        id: 'own',
        endpoint: endpoint,
        key: 'rotated',
      );
      expect((await ProviderCredentials().get('own'))!.key, 'rotated');
      await settings.credentials.delete('own');
      expect(await ProviderCredentials().get('own'), isNull);
      expect(
        await storage.read(key: '${ProviderCredentials.storageKey}.space.own'),
        isNull,
      );
      expect(
        await storage.read(key: '${ModelSettings.storageKey}.space.own'),
        contains('"credentialId":"own"'),
      );
    },
  );

  test(
    'failed shared migration preserves old registry and retries safely',
    () async {
      final storage = FailingStorage();
      final key = '${ProviderCredentials.storageKey}.space.own';
      final raw = jsonEncode({
        'version': 1,
        'credentials': [
          {
            'id': 'old',
            'endpoint': 'https://api.openai.com/v1',
            'label': 'Old',
            'key': 'secret',
          },
        ],
      });
      await storage.write(key: key, value: raw);
      storage.failKey = ProviderCredentials.storageKey;
      await expectLater(
        ProviderCredentials(storage: storage).list(),
        throwsA(isA<AgentFailure>()),
      );
      expect(await storage.read(key: key), raw);
      storage.failKey = null;
      expect(
        (await ProviderCredentials(storage: storage).list()).single.id,
        'old',
      );
      expect(await storage.read(key: key), isNull);
      expect(
        (await ProviderCredentials(storage: storage).list()).single.key,
        'secret',
      );
    },
  );

  test(
    'experience can discover legacy model and voice keys before opening their Space',
    () async {
      const storage = FlutterSecureStorage();
      const modelKey = '${ModelSettings.storageKey}.space.own';
      const voiceKey = '${VoiceSettings.storageKey}.space.own';
      await storage.write(
        key: modelKey,
        value: jsonEncode({
          'endpoint': 'https://api.openai.com/v1',
          'model': 'own-model',
          'key': 'old-chat',
        }),
      );
      await storage.write(
        key: voiceKey,
        value: jsonEncode(
          const VoiceConfiguration()
              .copyWith(
                integrated: const VoiceConfiguration().integrated.copyWith(
                  key: 'old-voice',
                ),
              )
              .toJson(),
        ),
      );
      SpaceStorage.active = const SpaceRecord(
        id: 'experience',
        name: 'Experience',
        mode: SpaceMode.standalone,
        personaId: 'fixture',
      );
      final keys = await ProviderCredentials().list();
      expect(keys.map((e) => e.key).toSet(), {'old-chat', 'old-voice'});
      expect(await storage.read(key: modelKey), isNot(contains('old-chat')));
      expect(await storage.read(key: voiceKey), isNot(contains('old-voice')));
      expect(await ModelSettings(native: Native()).read(), isNull);
      expect(await VoiceSettings().readDraft(), isNull);
    },
  );
}
