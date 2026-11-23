import 'dart:ui' show Locale;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/model_settings_backend.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

SpaceClientState fixture() => SpaceClientState(MemorySpacePersistence())
  ..snapshot = {
    'owner': true,
    'host_settings': {
      'models': {
        'version': 7,
        'applied_version': 6,
        'locked': false,
        'source': 'space',
        'routes': {
          'conversationText': {'provider': 'deepseek', 'model': 'current'},
        },
        'providers': [
          {
            'id': 'deepseek',
            'label': 'DeepSeek',
            'keyName': 'DEEPSEEK_API_KEY',
            'keyOptional': false,
            'configured': true,
            'usable': true,
          },
        ],
        'lanes': {
          'conversationText': ['deepseek'],
          'support': ['deepseek'],
        },
        'models': [
          {'provider': 'deepseek', 'id': 'recommended', 'label': 'Recommended'},
        ],
      },
    },
  };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'remote backend reads redacted Host state without local keychain or native access',
    () async {
      var nativeCalls = 0;
      for (final channel in [
        'plugins.it_nomads.com/flutter_secure_storage',
        'nova/local_agent',
      ]) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(MethodChannel(channel), (call) async {
              nativeCalls++;
              throw StateError('local access forbidden');
            });
      }
      final state = fixture(),
          backend = RemoteModelSettingsBackend(
            state,
            onSync: () async {},
            lane: 'conversationText',
          );
      final view = await backend.load();
      expect(view.model, 'current');
      expect(view.providerId, 'deepseek');
      expect(view.customEndpoint, false);
      expect(view.modelDiscovery, false);
      expect(view.allowKeyEntry, false);
      expect(await backend.hasCredential('deepseek', ''), true);
      expect(view.notice, contains('restarts'));
      expect(nativeCalls, 0);
    },
  );
  test(
    'a typed key precedes the versioned route change through durable dependency',
    () async {
      final state = fixture();
      var syncs = 0;
      final backend = RemoteModelSettingsBackend(
        state,
        onSync: () async {
          syncs++;
        },
        lane: 'conversationText',
      );
      await backend.load();
      await backend.save(
        const ModelSettingsInput(
          providerId: 'deepseek',
          endpoint: '',
          model: 'new-model',
          protocol: ModelProtocol.chatCompletions,
          newKey: 'typed-private-key',
        ),
      );
      expect(state.pending, hasLength(2));
      final key = state.pending[0], route = state.pending[1];
      expect(key['kind'], 'secret.put');
      expect(key['input'], {
        'name': 'DEEPSEEK_API_KEY',
        'value': 'typed-private-key',
      });
      expect(route['kind'], 'settings.patch');
      expect(route['depends_on'], [key['op_id']]);
      expect(route['input'], {
        'method': 'models.configure',
        'params': {
          'expected_version': 7,
          'routes': {
            'conversationText': {'provider': 'deepseek', 'model': 'new-model'},
          },
        },
      });
      expect(syncs, 1);
    },
  );
  test(
    'blank key reuses the Host key; captured version does not silently rebase',
    () async {
      final state = fixture();
      final backend = RemoteModelSettingsBackend(
        state,
        onSync: () async {},
        lane: 'conversationText',
      );
      await backend.load();
      ((state.snapshot['host_settings'] as Map)['models'] as Map)['version'] =
          8;
      await backend.save(
        const ModelSettingsInput(
          providerId: 'deepseek',
          endpoint: '',
          model: 'mine',
          protocol: ModelProtocol.chatCompletions,
        ),
      );
      expect(state.pending, hasLength(1));
      expect(
        (state.pending.single['input'] as Map)['params'],
        containsPair('expected_version', 7),
      );
    },
  );
  test(
    'all Host lanes can restore defaults; missing keys cannot silently save',
    () async {
      for (final lane in [
        'conversationText',
        'support',
        'fast',
        'compressor',
        'watch',
        'embedding',
      ]) {
        final state = fixture(),
            backend = RemoteModelSettingsBackend(
              fixture(),
              onSync: () async {},
              lane: lane,
            );
        expect((await backend.load()).canFollow, true);
        expect(
          (await backend.load()).followLabel,
          'Use the computer’s default model',
        );
        TestWidgetsFlutterBinding.instance.platformDispatcher.localeTestValue =
            const Locale('zh', 'CN');
        expect((await backend.load()).followLabel, '使用电脑默认模型');
        TestWidgetsFlutterBinding.instance.platformDispatcher
            .clearLocaleTestValue();
        await backend.follow();
        final blocked = RemoteModelSettingsBackend(
          state,
          onSync: () async {},
          lane: 'conversationText',
        );
        (((state.snapshot['host_settings'] as Map)['models']
                        as Map)['providers']
                    as List)
                .single['configured'] =
            false;
        await blocked.load();
        await expectLater(
          blocked.save(
            const ModelSettingsInput(
              providerId: 'deepseek',
              endpoint: '',
              model: 'x',
              protocol: ModelProtocol.chatCompletions,
            ),
          ),
          throwsA(isA<AgentFailure>()),
        );
        expect(state.pending, isEmpty);
      }
    },
  );

  test(
    'follow clears only its lane; operator and non-owner edits never enqueue',
    () async {
      final state = fixture();
      final backend = RemoteModelSettingsBackend(
        state,
        onSync: () async {},
        lane: 'support',
      );
      await backend.load();
      await backend.follow();
      expect(
        ((state.pending.single['input'] as Map)['params'] as Map)['routes'],
        {'support': null},
      );
      for (final lock in [false, true]) {
        final blocked = fixture();
        if (lock) {
          ((blocked.snapshot['host_settings'] as Map)['models']
                  as Map)['locked'] =
              true;
        } else {
          blocked.snapshot['owner'] = false;
        }
        final editor = RemoteModelSettingsBackend(
          blocked,
          onSync: () async {},
          lane: 'conversationText',
        );
        await expectLater(
          editor.save(
            const ModelSettingsInput(
              providerId: 'deepseek',
              endpoint: '',
              model: 'x',
              protocol: ModelProtocol.chatCompletions,
            ),
          ),
          throwsA(anything),
        );
        expect(blocked.pending, isEmpty);
      }
    },
  );
}
