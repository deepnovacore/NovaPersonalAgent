import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/provider_credentials.dart';
import 'package:nova_mobile/space/space_storage.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'native tasks refresh shared keys and reject deleted credentials',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      const channel = MethodChannel('nova/local_agent/v1');
      final calls = <(String, Map<String, dynamic>)>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add((
              call.method,
              jsonDecode(call.arguments as String) as Map<String, dynamic>,
            ));
            return '{}';
          });
      addTearDown(() {
        SpaceStorage.active = null;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });
      SpaceStorage.active = const SpaceRecord(
        id: 'own',
        name: 'Own',
        mode: SpaceMode.standalone,
      );
      final owner = ModelSettings();
      await owner.save(
        endpoint: 'https://api.openai.com/v1',
        model: 'own-model',
        key: 'first',
      );
      final credential = (await owner.credentials.list()).single;
      SpaceStorage.active = const SpaceRecord(
        id: 'experience',
        name: 'Experience',
        mode: SpaceMode.standalone,
        personaId: 'fixture',
      );
      final experience = ModelSettings();
      expect(await experience.read(), isNull);
      await experience.save(
        endpoint: credential.endpoint,
        model: 'experience-model',
        key: '',
      );
      await owner.credentials.save(
        id: credential.id,
        endpoint: credential.endpoint,
        key: 'rotated',
      );
      calls.clear();
      await const NativeLocalAgent().call('modelSettings');
      expect(calls.first.$1, 'saveModelSettings');
      expect(calls.first.$2['key'], 'rotated');
      expect(calls.first.$2['model'], 'experience-model');
      expect(calls.first.$2['space_id'], 'experience');
      expect((await owner.read())!.model, 'own-model');
      await ProviderCredentials().delete(credential.id);
      calls.clear();
      await expectLater(
        const NativeLocalAgent().call('run', {'id': 'never-started'}),
        throwsA(isA<AgentFailure>()),
      );
      expect(calls.map((c) => c.$1), ['clearModelSettings']);
      expect(calls.single.$2, {'space_id': 'experience'});
    },
  );
}
