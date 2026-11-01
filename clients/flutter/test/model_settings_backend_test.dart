import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/model_catalog.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/space/space_storage.dart';

import 'support/fake_model_http.dart';

class _Native implements LocalAgent {
  final calls = <(String, Map<String, dynamic>)>[];

  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    calls.add((method, input));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SpaceStorage.active = null;
  });

  test('local view exposes selection and credential presence only', () async {
    final native = _Native();
    final settings = ModelSettings(native: native);
    final backend = LocalModelSettingsBackend(settings);
    final initial = await backend.load();
    expect(initial.providerId, 'openrouter');
    expect(initial.model, 'openai/gpt-4.1-mini');
    expect(
      await backend.hasCredential(initial.providerId, initial.endpoint),
      false,
    );

    await backend.save(
      const ModelSettingsInput(
        providerId: null,
        endpoint: 'https://example.com/v1/responses',
        model: 'first-model',
        protocol: ModelProtocol.responses,
        newKey: 'private-key',
      ),
    );
    final view = await backend.load();
    expect(view.endpoint, 'https://example.com/v1/responses');
    expect(view.model, 'first-model');
    expect(view.protocol, ModelProtocol.responses);
    expect(view.providerId, isNull);
    expect(await backend.hasCredential(null, view.endpoint), true);
    expect(
      await backend.hasCredential(null, 'https://other.example/v1'),
      false,
    );
    expect(
      [
        view.providerId,
        view.endpoint,
        view.model,
        view.notice,
        view.securityText,
        ...view.providers.map((provider) => provider.endpoint),
      ].join(),
      isNot(contains('private-key')),
    );

    await backend.save(
      ModelSettingsInput(
        providerId: null,
        endpoint: view.endpoint,
        model: 'second-model',
        protocol: view.protocol,
      ),
    );
    expect((await settings.read())!.key, 'private-key');
    expect(native.calls.last.$1, 'saveModelSettings');
    expect(native.calls.last.$2['model'], 'second-model');
    expect(native.calls.last.$2['key'], 'private-key');
  });

  group('listing goes to each provider\'s own route', () {
    Future<(ModelRequest, ModelListResult)> list(
      String providerId,
      String endpoint,
    ) async {
      final http = installModelHttp();
      final backend = LocalModelSettingsBackend(
        ModelSettings(native: _Native()),
      );
      final pending = backend.listModelsDetailed(
        ModelSettingsInput(
          providerId: providerId,
          endpoint: endpoint,
          model: '',
          protocol: ModelProtocol.chatCompletions,
          newKey: 'sk-test',
        ),
      );
      while (http.lists.isEmpty) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      final request = http.lists.single;
      request.response.complete(
        ModelResponse(200, '{"data":[{"id":"listed-model"}],"has_more":false}'),
      );
      return (request, await pending);
    }

    test('Anthropic: its native /v1/models with x-api-key', () async {
      final (request, result) = await list(
        'anthropic',
        'https://api.anthropic.com/v1',
      );
      expect(
        request.url.toString(),
        'https://api.anthropic.com/v1/models?limit=1000',
      );
      expect(request.headers.values['x-api-key'], 'sk-test');
      expect(request.headers.values['anthropic-version'], '2023-06-01');
      expect(request.headers.values.containsKey('Authorization'), isFalse);
      expect((result as ModelListOk).models.single.id, 'listed-model');
    });

    test('Gemini: the OpenAI-compatible route with a Bearer key', () async {
      final (request, _) = await list(
        'gemini',
        'https://generativelanguage.googleapis.com/v1beta/openai',
      );
      expect(
        request.url.toString(),
        'https://generativelanguage.googleapis.com/v1beta/openai/models',
      );
      expect(request.headers.values['Authorization'], 'Bearer sk-test');
      expect(request.headers.values.containsKey('x-goog-api-key'), isFalse);
    });

    test('OpenAI: /models with a Bearer key', () async {
      final (request, _) = await list('openai', 'https://api.openai.com/v1');
      expect(request.url.toString(), 'https://api.openai.com/v1/models');
      expect(request.headers.values['Authorization'], 'Bearer sk-test');
    });
  });

  test('a saved provider keeps the protocol it was saved with', () async {
    final settings = ModelSettings(native: _Native());
    final backend = LocalModelSettingsBackend(settings);
    const custom = 'https://relay.example/v1';
    await backend.save(
      const ModelSettingsInput(
        providerId: null,
        endpoint: custom,
        model: 'm1',
        protocol: ModelProtocol.responses,
        newKey: 'custom-key',
      ),
    );
    // Another provider becomes the one in use.
    await backend.save(
      const ModelSettingsInput(
        providerId: 'deepseek',
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        protocol: ModelProtocol.chatCompletions,
        newKey: 'ds-key',
      ),
    );
    var saved = {for (final p in await backend.savedProviders()) p.endpoint: p};
    expect(saved[custom]!.protocol, ModelProtocol.responses);
    expect(saved[custom]!.presetId, isNull);
    expect(
      saved['https://api.deepseek.com']!.protocol,
      ModelProtocol.chatCompletions,
    );
    expect(saved['https://api.deepseek.com']!.presetId, 'deepseek');

    // Replacing only the key keeps the protocol.
    await backend.saveCredential(
      const ModelSettingsInput(
        providerId: null,
        endpoint: custom,
        model: '',
        protocol: ModelProtocol.responses,
        newKey: 'custom-key-2',
      ),
    );
    // Saving the same key again with another protocol updates the record.
    await backend.save(
      const ModelSettingsInput(
        providerId: 'deepseek',
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        protocol: ModelProtocol.responses,
      ),
    );
    saved = {for (final p in await backend.savedProviders()) p.endpoint: p};
    expect(saved[custom]!.protocol, ModelProtocol.responses);
    expect(
      saved['https://api.deepseek.com']!.protocol,
      ModelProtocol.responses,
    );
    expect((await settings.credentials.resolve(custom))!.key, 'custom-key-2');
  });

  test(
    'records saved before protocols were stored read as the preset\'s',
    () async {
      final settings = ModelSettings(native: _Native());
      await settings.credentials.save(
        endpoint: 'https://api.deepseek.com',
        key: 'old-key',
      );
      await settings.credentials.save(
        endpoint: 'https://relay.example/v1',
        key: 'old-custom',
      );
      final saved = {
        for (final p in await LocalModelSettingsBackend(
          settings,
        ).savedProviders())
          p.endpoint: p.protocol,
      };
      expect(saved['https://api.deepseek.com'], ModelProtocol.chatCompletions);
      expect(saved['https://relay.example/v1'], ModelProtocol.chatCompletions);
    },
  );

  test(
    'support preserves credential references and resets to follow',
    () async {
      final settings = ModelSettings(native: _Native());
      final credential = await settings.credentials.save(
        endpoint: 'https://support.example/v1',
        key: 'support-private-key',
      );
      final backend = LocalModelSettingsBackend(settings, support: true);
      expect((await backend.load()).following, true);
      await backend.save(
        ModelSettingsInput(
          providerId: null,
          endpoint: credential.endpoint,
          model: 'support-model',
          protocol: ModelProtocol.responses,
        ),
      );
      final view = await backend.load();
      expect(view.following, false);
      expect(view.allowKeyEntry, false);
      expect(view.protocol, ModelProtocol.responses);
      expect(await backend.hasCredential(null, view.endpoint), true);
      await settings.credentials.delete(credential.id);
      await settings.credentials.save(
        endpoint: credential.endpoint,
        key: 'replacement',
      );
      expect(await backend.hasCredential(null, view.endpoint), false);
      await expectLater(
        backend.save(
          ModelSettingsInput(
            providerId: null,
            endpoint: credential.endpoint,
            model: 'support-model',
            protocol: view.protocol,
          ),
        ),
        throwsA(isA<AgentFailure>()),
      );
      await backend.follow();
      expect((await backend.load()).following, true);
    },
  );
}
