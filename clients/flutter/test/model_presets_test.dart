import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';

void main() {
  group('model presets', () {
    test('ids are unique and every preset is a valid configuration', () {
      expect({
        for (final p in modelPresets) p.id,
      }, hasLength(modelPresets.length));
      for (final p in modelPresets) {
        expect(
          Uri.parse(p.endpoint).scheme,
          'https',
          reason: '${p.id} must use https',
        );
        expect(Uri.parse(p.keyUrl).scheme, 'https', reason: p.id);
        // Same validation as saving: a preset must never be unsavable.
        ModelConfiguration(
          endpoint: p.endpoint,
          model: p.recommendedModels.isEmpty ? 'm' : p.recommendedModels.first,
          key: 'k',
          protocol: p.protocol,
        );
      }
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
