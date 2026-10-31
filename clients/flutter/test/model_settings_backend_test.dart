import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/space/space_storage.dart';

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
