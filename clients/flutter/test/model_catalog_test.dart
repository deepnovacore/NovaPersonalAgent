import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_catalog.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

typedef _Reply = ({int status, Object body});

void main() {
  late HttpServer server;
  late List<HttpRequest> seen;
  late Map<String, String> headersOf;
  late _Reply Function(HttpRequest request) handler;

  setUp(() async {
    seen = [];
    headersOf = {};
    handler = (_) => (status: 200, body: {'data': []});
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      seen.add(request);
      for (final name in [
        'authorization',
        'x-api-key',
        'anthropic-version',
        'x-goog-api-key',
        'x-extra',
      ]) {
        final value = request.headers.value(name);
        if (value != null) headersOf[name] = value;
      }
      final reply = handler(request);
      request.response.statusCode = reply.status;
      request.response.write(
        reply.body is String ? reply.body : jsonEncode(reply.body),
      );
      await request.response.close();
    });
  });
  tearDown(() => server.close(force: true));
  String base([String path = '']) => 'http://127.0.0.1:${server.port}$path';
  ModelCatalog catalog({Set<WireProtocol>? speaks}) =>
      speaks == null ? ModelCatalog() : ModelCatalog(speaks: speaks);

  List<ListedModel> models(ModelListResult result) {
    expect(result, isA<ModelListOk>(), reason: '$result');
    return (result as ModelListOk).models;
  }

  ListFailure reasonOf(ModelListResult result) {
    expect(result, isA<ModelListFailed>());
    return (result as ModelListFailed).reason;
  }

  group('OpenAI-compatible listing', () {
    test('plain ids state no capabilities and are de-duplicated', () async {
      handler = (_) => (
        status: 200,
        body: {
          'data': [
            {'id': 'a'},
            {'id': 'a'},
            {'id': 'b'},
            {'object': 'no id'},
          ],
        },
      );
      final listed = models(
        await catalog().openAiCompat(
          base('/v1/'),
          'sk-1',
          headers: {'x-extra': 'e'},
        ),
      );
      expect(listed.map((m) => m.id), ['a', 'b']);
      expect(listed.first.toolCalls, isNull);
      expect(listed.first.vision, isNull);
      expect(listed.first.contextTokens, isNull);
      expect(listed.first.reasoning, isNull);
      expect(listed.first.usable, isTrue);
      expect(seen.single.uri.path, '/v1/models');
      expect(headersOf['authorization'], 'Bearer sk-1');
      expect(headersOf['x-extra'], 'e');
    });

    test('an empty key sends no Authorization header', () async {
      await catalog().openAiCompat(base('/v1'), '');
      expect(headersOf.containsKey('authorization'), isFalse);
    });

    test(
      'an aggregator row fills capabilities from the fields it gives',
      () async {
        handler = (_) => (
          status: 200,
          body: {
            'data': [
              {
                'id': 'vendor/vision-model',
                'name': 'Vision Model',
                'context_length': 131072,
                'architecture': {
                  'input_modalities': ['text', 'image'],
                  'output_modalities': ['text'],
                },
                'supported_parameters': ['tools', 'reasoning', 'max_tokens'],
              },
              {
                'id': 'vendor/text-only',
                'architecture': {
                  'input_modalities': ['text'],
                  'modality': 'text->text',
                },
                'supported_parameters': ['temperature'],
              },
              {
                'id': 'vendor/image-maker',
                'architecture': {
                  'output_modalities': ['image'],
                },
              },
            ],
          },
        );
        final listed = models(await catalog().openAiCompat(base('/v1'), 'k'));
        final vision = listed[0];
        expect(vision.displayName, 'Vision Model');
        expect(vision.toolCalls, isTrue);
        expect(vision.vision, isTrue);
        expect(vision.reasoning, isTrue);
        expect(vision.contextTokens, 131072);
        expect(listed[1].toolCalls, isFalse);
        expect(listed[1].vision, isFalse);
        expect(listed[1].reasoning, isFalse);
        expect(listed[2].chat, isFalse);
      },
    );

    test(
      'the capabilities / limit / modalities dialect is understood',
      () async {
        handler = (_) => (
          status: 200,
          body: {
            'data': [
              {
                'id': 'dialect',
                'capabilities': {
                  'tools': {'supported': true},
                  'reasoning': {
                    'supported': true,
                    'effort': ['low', 'high'],
                  },
                },
                'limit': {'context': 200000},
                'modalities': {
                  'input': ['text', 'image/png'],
                  'output': ['text'],
                },
              },
            ],
          },
        );
        final m = models(await catalog().openAiCompat(base('/v1'), 'k')).single;
        expect(m.toolCalls, isTrue);
        expect(m.reasoning, isTrue);
        expect(m.contextTokens, 200000);
        expect(m.vision, isTrue);
        expect(m.chat, isNull);
      },
    );

    test(
      'the ChatGPT models table keeps only listed entries in order',
      () async {
        handler = (_) => (
          status: 200,
          body: {
            'models': [
              {
                'slug': 'gpt-x',
                'display_name': 'GPT X',
                'visibility': 'list',
                'input_modalities': ['text', 'image'],
                'context_window': 272000,
                'supported_reasoning_levels': [
                  {'effort': 'low'},
                  {'effort': 'high'},
                ],
              },
              {'slug': 'hidden', 'visibility': 'hide'},
              {'slug': 'gpt-y', 'visibility': 'list'},
            ],
          },
        );
        final listed = models(
          await catalog().openAiCompat(base('/backend-api/codex'), 'tok'),
        );
        expect(listed.map((m) => m.id), ['gpt-x', 'gpt-y']);
        expect(listed.first.displayName, 'GPT X');
        expect(listed.first.contextTokens, 272000);
        expect(listed.first.reasoning, isTrue);
        expect(listed.first.vision, isTrue);
        expect(listed.last.vision, isNull);
      },
    );

    test(
      'the api table picks a protocol the caller speaks, else marks it unusable',
      () async {
        handler = (_) => (
          status: 200,
          body: {
            'data': [
              {
                'id': 'both',
                'api': {
                  'messages': {'base_url': 'https://x.example/anthropic/v1'},
                  'chat-completions': {
                    'base_url': 'https://x.example/v1',
                    'compatibility': {'reasoning_field': 'reasoning_content'},
                  },
                },
              },
              {
                'id': 'messages-only',
                'api': {
                  'messages': {'base_url': 'https://x.example/anthropic/v1'},
                },
              },
              {'id': 'no-table'},
            ],
          },
        );
        final everything = models(
          await catalog().openAiCompat(base('/v1'), 'k'),
        );
        // Wire order is chat-completions, messages, generate-content, responses.
        expect(everything[0].endpoint!.protocol, WireProtocol.chatCompletions);
        expect(everything[1].endpoint!.protocol, WireProtocol.messages);

        final nova = models(
          await catalog(
            speaks: {WireProtocol.chatCompletions, WireProtocol.responses},
          ).openAiCompat(base('/v1'), 'k'),
        );
        expect(nova[0].endpoint!.baseUrl, 'https://x.example/v1');
        expect(nova[1].endpoint, isNull);
        expect(nova[1].unsupportedApis, ['messages']);
        expect(nova[1].usable, isFalse);
        expect(nova[2].usable, isTrue);
      },
    );

    test('supported_endpoints are sniffed into protocols', () async {
      handler = (_) => (
        status: 200,
        body: {
          'data': [
            {
              'id': 'm',
              'supported_endpoints': [
                '/chat/completions',
                '/v1/messages',
                '/v1beta/models/m:generateContent',
                '/v1/models',
              ],
            },
          ],
        },
      );
      final m = models(await catalog().openAiCompat(base('/v1'), 'k')).single;
      expect(m.protocols, [
        WireProtocol.chatCompletions,
        WireProtocol.messages,
        WireProtocol.generateContent,
      ]);
    });

    test('type and output modalities mark non-chat models', () async {
      handler = (_) => (
        status: 200,
        body: {
          'data': [
            {'id': 'e', 'type': 'embedding'},
            {'id': 'c', 'type': 'chat'},
            {'id': 'u'},
          ],
        },
      );
      final listed = models(await catalog().openAiCompat(base('/v1'), 'k'));
      expect([for (final m in listed) m.chat], [false, true, null]);
    });
  });

  group('protocol sniffing', () {
    test('paths map to protocols; a bare models path does not', () {
      expect(
        WireProtocol.ofPath('/v1/chat/completions/'),
        WireProtocol.chatCompletions,
      );
      expect(
        WireProtocol.ofPath('/anthropic/v1/messages'),
        WireProtocol.messages,
      );
      expect(WireProtocol.ofPath('/v1/responses'), WireProtocol.responses);
      expect(
        WireProtocol.ofPath('/v1beta/models/gemini:generateContent'),
        WireProtocol.generateContent,
      );
      expect(WireProtocol.ofPath('/v1/models'), isNull);
      expect(WireProtocol.ofPath(null), isNull);
      expect(WireProtocol.of('generate-content'), WireProtocol.generateContent);
      expect(WireProtocol.of('nope'), isNull);
    });
  });

  group('Anthropic listing', () {
    test('follows after_id pages and reads capabilities', () async {
      handler = (request) {
        if (request.uri.queryParameters['after_id'] == null) {
          return (
            status: 200,
            body: {
              'data': [
                {
                  'id': 'claude-a',
                  'display_name': 'Claude A',
                  'max_input_tokens': 200000,
                  'capabilities': {
                    'image_input': {'supported': true},
                    'thinking': {
                      'supported': true,
                      'types': {
                        'adaptive': {'supported': true},
                        'enabled': {'supported': true},
                        'disabled': {'supported': true},
                      },
                    },
                    'effort': {
                      'supported': true,
                      'max': {'supported': true},
                      'low': {'supported': true},
                      'high': {'supported': true},
                      'medium': {'supported': false},
                    },
                  },
                },
              ],
              'has_more': true,
              'last_id': 'claude-a',
            },
          );
        }
        return (
          status: 200,
          body: {
            'data': [
              {'id': 'claude-b'},
              {'id': 'claude-a'},
            ],
            'has_more': false,
            'last_id': 'claude-b',
          },
        );
      };
      final listed = models(await catalog().anthropic(base(), 'ak'));
      expect(listed.map((m) => m.id), ['claude-a', 'claude-b']);
      expect(seen, hasLength(2));
      expect(seen.last.uri.queryParameters['after_id'], 'claude-a');
      expect(seen.first.uri.path, '/v1/models');
      expect(headersOf['x-api-key'], 'ak');
      expect(headersOf['anthropic-version'], '2023-06-01');
      expect(headersOf.containsKey('authorization'), isFalse);
      final a = listed.first;
      expect(a.vision, isTrue);
      expect(a.contextTokens, 200000);
      expect(a.reasoning, isTrue);
      expect(a.toolCalls, isNull);
    });

    test(
      'the root is the base without its /v1, whichever way it is given',
      () async {
        for (final given in [base(), base('/'), base('/v1'), base('/v1/')]) {
          await catalog().anthropic(given, 'ak');
        }
        expect(seen.map((r) => r.uri.path), everyElement('/v1/models'));
        expect(seen, hasLength(4));
        expect(headersOf['x-api-key'], 'ak');
        expect(headersOf['anthropic-version'], '2023-06-01');
        expect(headersOf.containsKey('authorization'), isFalse);
      },
    );

    test('a short listing is not marked truncated', () async {
      handler = (_) => (
        status: 200,
        body: {
          'data': [
            {'id': 'm'},
          ],
          'has_more': false,
          'last_id': 'm',
        },
      );
      final result = await catalog().anthropic(base(), 'ak') as ModelListOk;
      expect(result.truncated, isFalse);
    });

    test('stops after the page cap when the server never ends', () async {
      handler = (_) => (
        status: 200,
        body: {
          'data': [
            {'id': 'm${seen.length}'},
          ],
          'has_more': true,
          'last_id': 'x${seen.length}',
        },
      );
      final result = await catalog().anthropic(base(), 'ak') as ModelListOk;
      expect(seen, hasLength(ModelCatalog.maxPages));
      expect(result.models, hasLength(ModelCatalog.maxPages));
      expect(result.truncated, isTrue);
    });
  });

  group('dispatch by kind', () {
    test(
      'Anthropic has its own lister; every other kind lists as OpenAI',
      () async {
        await catalog().list(ProviderKind.anthropic, base(), 'k');
        await catalog().list(ProviderKind.gemini, base('/v1beta/openai'), 'k');
        await catalog().list(ProviderKind.openAiResponses, base(), 'k');
        expect(seen.map((r) => r.uri.path), [
          '/v1/models',
          '/v1beta/openai/models',
          '/models',
        ]);
        expect(headersOf['authorization'], 'Bearer k');
        expect(ProviderKind.anthropic.wireProtocol, WireProtocol.messages);
        expect(
          ProviderKind.openAiResponses.wireProtocol,
          WireProtocol.responses,
        );
      },
    );
  });

  group('failures', () {
    test('HTTP statuses map to reasons', () {
      ListFailure reason(int status, [String body = '']) =>
          failureFor(status, body).reason;
      expect(reason(401), ListFailure.auth);
      expect(reason(403), ListFailure.auth);
      expect(
        reason(400, '{"error":{"status":"API_KEY_INVALID"}}'),
        ListFailure.auth,
      );
      expect(
        reason(400, 'API key not valid. Please pass a valid API key.'),
        ListFailure.auth,
      );
      expect(reason(400, 'something else'), ListFailure.badResponse);
      expect(reason(402), ListFailure.quota);
      expect(reason(200, 'insufficient_quota'), ListFailure.quota);
      expect(reason(429), ListFailure.rateLimited);
      for (final status in [404, 405, 501]) {
        expect(reason(status), ListFailure.notSupported, reason: '$status');
      }
      for (final status in [500, 502, 503, 599]) {
        expect(reason(status), ListFailure.server, reason: '$status');
      }
      expect(failureFor(503, '').detail, 'HTTP 503');
      expect(failureFor(418, '').reason, ListFailure.badResponse);
      expect(failureFor(418, '').status, 418);
    });

    test('live responses carry the status and a readable message', () async {
      for (final (status, reason) in [
        (401, ListFailure.auth),
        (402, ListFailure.quota),
        (404, ListFailure.notSupported),
        (429, ListFailure.rateLimited),
        (503, ListFailure.server),
      ]) {
        handler = (_) => (status: status, body: {'error': 'x'});
        final result = await catalog().openAiCompat(base('/v1'), 'k');
        expect(reasonOf(result), reason, reason: '$status');
        final failed = result as ModelListFailed;
        expect(failed.status, status);
        expect(failed.message('zh'), contains(reason.text('zh')));
      }
      expect(failureFor(503, '').message('en'), contains('HTTP 503'));
    });

    test(
      'a bad URL, a dead host and unreadable bodies are distinguished',
      () async {
        for (final url in [
          'ftp://x.example/v1',
          'http://example.com/v1',
          'https://u:p@x.example/v1',
          'not a url',
          '',
        ]) {
          expect(
            reasonOf(await catalog().openAiCompat(url, 'k')),
            ListFailure.badUrl,
            reason: url,
          );
        }
        handler = (_) => (status: 200, body: 'not json');
        expect(
          reasonOf(await catalog().openAiCompat(base('/v1'), 'k')),
          ListFailure.badResponse,
        );
        handler = (_) => (status: 200, body: {'data': 'nope'});
        expect(
          reasonOf(await catalog().openAiCompat(base('/v1'), 'k')),
          ListFailure.badResponse,
        );
        handler = (_) => (status: 200, body: '[1,2]');
        expect(
          reasonOf(await catalog().anthropic(base(), 'k')),
          ListFailure.badResponse,
        );
        final port = server.port;
        await server.close(force: true);
        expect(
          reasonOf(
            await catalog().openAiCompat('http://127.0.0.1:$port/v1', 'k'),
          ),
          ListFailure.network,
        );
        server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      },
    );

    test('an oversized body is a bad response, not a crash', () async {
      handler = (_) => (status: 200, body: 'x' * 2048);
      expect(
        reasonOf(
          await ModelCatalog(maxBytes: 1024).openAiCompat(base('/v1'), 'k'),
        ),
        ListFailure.badResponse,
      );
    });
  });

  group('model_client delegation', () {
    final mixed = {
      'data': [
        {'id': 'b'},
        {'id': 'a'},
        {
          'id': 'messages-only',
          'api': {
            'messages': {'base_url': 'https://x.example/v1'},
          },
        },
      ],
    };

    test(
      'listModelsDetailed strips the route and filters by what Nova speaks',
      () async {
        handler = (_) => (status: 200, body: mixed);
        final result = await listModelsDetailed(
          endpoint: base('/v1/chat/completions'),
          key: 'k',
        );
        expect(seen.single.uri.path, '/v1/models');
        final listed = models(result);
        expect(listed.where((m) => m.usable).map((m) => m.id), ['b', 'a']);
        expect(listed.where((m) => !m.usable).map((m) => m.id), [
          'messages-only',
        ]);
      },
    );

    test('listModels hides models Nova cannot call and sorts ids', () async {
      handler = (_) => (status: 200, body: mixed);
      expect(await listModels(endpoint: base('/v1'), key: 'k'), ['a', 'b']);
    });

    test('listModels keeps the model_http_NNN failure codes', () async {
      handler = (_) => (status: 402, body: '');
      await expectLater(
        listModels(endpoint: base('/v1'), key: 'k'),
        throwsA(
          isA<ModelRequestFailure>().having(
            (e) => e.code,
            'code',
            'model_http_402',
          ),
        ),
      );
    });

    test('a key with a newline is rejected before any request', () async {
      final result = await listModelsDetailed(
        endpoint: base('/v1'),
        key: 'bad\nkey',
      );
      expect(reasonOf(result), ListFailure.auth);
      expect(seen, isEmpty);
    });
  });
}
