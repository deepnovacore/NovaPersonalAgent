import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart' show TargetPlatform;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_catalog.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';

void main() {
  group('model presets', () {
    test('ids are unique and every preset is a valid configuration', () {
      expect({
        for (final p in modelPresets) p.id,
      }, hasLength(modelPresets.length));
      for (final p in modelPresets) {
        // Only a self-hosted default may be plain http, and only on loopback.
        expect(
          Uri.parse(p.endpoint).scheme,
          p.selfHosted ? 'http' : 'https',
          reason: '${p.id} must use https unless self-hosted',
        );
        if (p.selfHosted) {
          expect(Uri.parse(p.endpoint).host, '127.0.0.1', reason: p.id);
          expect(p.keyUrl, isEmpty, reason: p.id);
        } else {
          expect(Uri.parse(p.keyUrl).scheme, 'https', reason: p.id);
        }
        // Same validation as saving: a preset must never be unsavable.
        ModelConfiguration(
          endpoint: p.endpoint,
          model: p.recommendedModels.isEmpty ? 'm' : p.recommendedModels.first,
          key: 'k',
          protocol: p.protocol,
        );
      }
    });

    test('every name that contains Chinese has an English form', () {
      final cjk = RegExp(r'[\u3400-\u9fff]');
      var translated = 0;
      for (final p in modelPresets) {
        expect(p.label('zh'), p.name, reason: p.id);
        if (cjk.hasMatch(p.name)) {
          translated++;
          expect(p.nameEn, isNotNull, reason: p.id);
        }
        expect(cjk.hasMatch(p.label('en')), isFalse, reason: p.id);
      }
      expect(translated, 7);
      expect(ModelPreset.byId('deepseek')!.label('en'), 'DeepSeek');
      expect(ModelPreset.byId('zhipu')!.label('en'), 'Zhipu GLM');
    });

    test('a provider that needs the session header is not offered on iOS', () {
      for (final p in modelPresets) {
        expect(p.availableOn(TargetPlatform.android), isTrue, reason: p.id);
        expect(
          p.availableOn(TargetPlatform.iOS),
          p.sessionHeader == null,
          reason: p.id,
        );
      }
      expect(
        ModelPreset.byId('opencode-go')!.availableOn(TargetPlatform.iOS),
        isFalse,
      );
    });

    test(
      'a saved endpoint maps back to its preset, full route or Base URL',
      () {
        final deepseek = ModelPreset.byId('deepseek')!;
        expect(ModelPreset.forEndpoint(deepseek.endpoint)?.id, 'deepseek');
        expect(
          ModelPreset.forEndpoint('${deepseek.endpoint}/chat/completions/')?.id,
          'deepseek',
        );
        expect(
          ModelPreset.forEndpoint('https://api.openai.com/v1/responses')?.id,
          'openai',
        );
        expect(ModelPreset.forEndpoint('https://model.example/v1'), isNull);
      },
    );

    test('the catalogue covers the Mika providers with their defaults', () {
      for (final id in [
        'hunyuan',
        'qianfan',
        'minimax',
        'mistral',
        'groq',
        'ollama',
        'lmstudio',
        'opencode-go',
        'anthropic',
        'gemini',
        'openai',
      ]) {
        expect(ModelPreset.byId(id), isNotNull, reason: id);
      }
      // 20 Mika presets plus Nova's separate international Moonshot site.
      expect(modelPresets, hasLength(21));
      expect(ModelPreset.byId('hunyuan')!.capabilities.contextTokens, 256000);
      expect(ModelPreset.byId('minimax')!.capabilities.vision, isTrue);
      expect(
        ModelPreset.byId('opencode-go')!.sessionHeader,
        'x-opencode-session',
      );
      expect(ModelPreset.byId('deepseek')!.sessionHeader, isNull);
      expect(modelPresets.where((p) => p.selfHosted).map((p) => p.id), [
        'ollama',
        'lmstudio',
      ]);
      expect(ModelPreset.byId('moonshot-cn')!.familyTokens, [
        'kimi',
        'moonshot',
      ]);
      expect(ModelPreset.byId('ark')!.familyTokens, ['doubao']);
      expect(ModelPreset.byId('openrouter')!.familyTokens, isEmpty);
    });

    test(
      'provider kinds follow Mika while the wire stays OpenAI-compatible',
      () {
        expect(
          ModelPreset.byId('anthropic')!.providerKind,
          ProviderKind.anthropic,
        );
        expect(ModelPreset.byId('gemini')!.providerKind, ProviderKind.gemini);
        expect(
          ModelPreset.byId('openai')!.providerKind,
          ProviderKind.openAiResponses,
        );
        expect(
          ModelPreset.byId('deepseek')!.providerKind,
          ProviderKind.openAiCompat,
        );
        // Nova's client has no Messages / generateContent adapter, and saved
        // OpenAI settings are Chat Completions: every preset keeps that route.
        for (final p in modelPresets) {
          expect(p.protocol, ModelProtocol.chatCompletions, reason: p.id);
        }
      },
    );

    test('forHost suggests a preset for an official address on any path', () {
      expect(
        ModelPreset.forHost('https://api.deepseek.com/v1/chat')?.id,
        'deepseek',
      );
      expect(
        ModelPreset.forHost('https://API.ANTHROPIC.COM/v1/messages')?.id,
        'anthropic',
      );
      expect(ModelPreset.forHost('https://api.groq.com/other')?.id, 'groq');
      expect(
        ModelPreset.forHost('https://api.moonshot.ai/x')?.id,
        'moonshot-global',
      );
      expect(ModelPreset.forHost('https://model.example/v1'), isNull);
      // A self-hosted default is a port on this phone, not a vendor address.
      expect(ModelPreset.forHost('http://127.0.0.1:11434/v1'), isNull);
      expect(ModelPreset.forHost('not a url'), isNull);
      expect(ModelPreset.forHost(''), isNull);
    });

    test('forEndpoint resolves the new local presets by exact address', () {
      expect(
        ModelPreset.forEndpoint('http://127.0.0.1:11434/v1')?.id,
        'ollama',
      );
      expect(
        ModelPreset.forEndpoint('http://127.0.0.1:1234/v1/')?.id,
        'lmstudio',
      );
      expect(
        ModelPreset.forEndpoint('https://api.anthropic.com/v1')?.id,
        'anthropic',
      );
    });

    test('China and international Moonshot sites stay distinct', () {
      expect(
        ModelPreset.byId('moonshot-cn')!.endpoint,
        isNot(ModelPreset.byId('moonshot-global')!.endpoint),
      );
    });
  });

  group('listModels', () {
    late HttpServer server;
    late int status;
    late Object body;
    String? auth, path;
    setUp(() async {
      status = 200;
      body = {};
      auth = path = null;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        auth = request.headers.value('authorization');
        path = request.uri.path;
        request.response.statusCode = status;
        request.response.write(body is String ? body : jsonEncode(body));
        await request.response.close();
      });
    });
    tearDown(() => server.close(force: true));
    String base() => 'http://127.0.0.1:${server.port}/api/v1';

    test(
      'returns sorted ids, strips the models/ prefix, sends the key',
      () async {
        body = {
          'data': [
            {'id': 'models/gemini-b'},
            {'id': 'a-model'},
            {'id': 'a-model'},
            {'object': 'no id'},
          ],
        };
        final ids = await listModels(endpoint: base(), key: 'sk-test');
        expect(ids, ['a-model', 'gemini-b']);
        expect(auth, 'Bearer sk-test');
        expect(path, '/api/v1/models');
      },
    );

    test('accepts a saved full route as the endpoint', () async {
      body = {'data': []};
      expect(
        await listModels(endpoint: '${base()}/chat/completions', key: 'k'),
        isEmpty,
      );
      expect(path, '/api/v1/models');
    });

    test('maps HTTP failures to status codes', () async {
      for (final code in [401, 404]) {
        status = code;
        await expectLater(
          listModels(endpoint: base(), key: 'k'),
          throwsA(
            isA<ModelRequestFailure>().having(
              (e) => e.code,
              'code',
              'model_http_$code',
            ),
          ),
        );
      }
    });

    test('rejects a malformed body without leaking it', () async {
      body = 'not json';
      await expectLater(
        listModels(endpoint: base(), key: 'k'),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'invalid_model_response',
          ),
        ),
      );
      body = {'data': 'nope'};
      await expectLater(
        listModels(endpoint: base(), key: 'k'),
        throwsA(isA<AgentFailure>()),
      );
    });

    test('reports an unreachable host as a request failure', () async {
      final port = server.port;
      await server.close(force: true);
      await expectLater(
        listModels(endpoint: 'http://127.0.0.1:$port/v1', key: 'k'),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'model_request_failed',
          ),
        ),
      );
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    });

    test(
      'refuses plain http to a non-loopback host and an empty key',
      () async {
        for (final args in [('http://example.com/v1', 'k'), (base(), '')]) {
          await expectLater(
            listModels(endpoint: args.$1, key: args.$2),
            throwsA(
              isA<AgentFailure>().having(
                (e) => e.code,
                'code',
                'invalid_model_settings',
              ),
            ),
          );
        }
      },
    );
  });
}
