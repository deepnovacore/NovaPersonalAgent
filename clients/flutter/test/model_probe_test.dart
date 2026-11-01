import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_catalog.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';
import 'package:nova_mobile/agent_core/model_probe.dart';

ModelOption _option(
  String id, {
  bool tools = true,
  bool toolsKnown = false,
  String name = '',
  bool? chat,
}) => ModelOption(
  id: id,
  displayName: name,
  capabilities: ProviderCapabilities(toolCalls: tools),
  toolCallsKnown: toolsKnown,
  visionKnown: false,
  contextKnown: false,
  chat: chat,
);

void main() {
  group('candidate order', () {
    test('own family first, then models the listing says can use tools', () {
      final options = [
        _option('other-model'),
        _option('qwen-plus'),
        _option('known-tools', toolsKnown: true),
        _option('qwen-vl', toolsKnown: true),
      ];
      expect(probeCandidates(options, ['qwen']), [
        'qwen-vl',
        'qwen-plus',
        'known-tools',
        'other-model',
      ]);
      // Without a family only the "tools known" rank applies; the list order
      // is otherwise kept.
      expect(probeCandidates(options), [
        'known-tools',
        'qwen-vl',
        'other-model',
        'qwen-plus',
      ]);
    });

    test('within the family newer versions go first, previews last', () {
      final options = [
        _option('deepseek-v2'),
        _option('deepseek-v3.1-preview'),
        _option('deepseek-v3.1'),
        _option('deepseek-v3'),
        _option('deepseek-chat'),
        _option('deepseek-v3-latest'),
      ];
      expect(probeCandidates(options, ['deepseek']), [
        'deepseek-v3.1',
        'deepseek-v3.1-preview',
        'deepseek-v3',
        'deepseek-v3-latest',
        'deepseek-v2',
        'deepseek-chat',
      ]);
    });

    test('dashed minor versions and snapshot dates compare as versions', () {
      final a = ModelVersion.of('claude-3-5-sonnet-20241022');
      final b = ModelVersion.of('claude-3-7-sonnet-20250219');
      expect(a.numbers, [3, 5]);
      expect(ModelVersion.newestFirst(b, a), lessThan(0));
      expect(ModelVersion.of('gpt-4o-2024-08-06').date, 20240806);
      expect(ModelVersion.of('llama-70b').parsed, isFalse);
      expect(
        ModelVersion.newestFirst(
          ModelVersion.of('m-2'),
          ModelVersion.of('plain'),
        ),
        lessThan(0),
      );
    });

    test('non-chat, tool-less models never become candidates', () {
      final options = [
        _option('text-embedding-3'),
        _option('whisper-1'),
        _option('big-chat', chat: true),
        _option('declared-embed', chat: false),
        _option('no-tools', tools: false),
        _option('gpt-image-1'),
      ];
      expect(probeCandidates(options), ['big-chat']);
    });

    test('display names count towards the family', () {
      final options = [_option('x1'), _option('model-9', name: 'Kimi K2')];
      expect(probeCandidates(options, ['kimi']), ['model-9', 'x1']);
    });

    test('merge keeps listed facts and falls back to the preset', () {
      final merged = mergeModelOptions(const [
        ListedModel(id: 'a', toolCalls: false, contextTokens: 8000),
        ListedModel(id: 'b', toolCalls: true, vision: true),
        ListedModel(id: 'c', unsupportedApis: ['messages']),
        ListedModel(id: 'd'),
      ], const ProviderCapabilities(contextTokens: 64000));
      // c is unusable; tool-capable ones (b, d) come before a.
      expect(merged.map((o) => o.id), ['b', 'd', 'a']);
      final b = merged[0];
      expect(b.toolCallsKnown, isTrue);
      expect(b.capabilities.vision, isTrue);
      expect(b.capabilities.contextTokens, 64000);
      expect(b.contextKnown, isFalse);
      final d = merged[1];
      expect(d.toolCallsKnown, isFalse);
      expect(d.capabilities.toolCalls, isTrue);
      expect(merged[2].contextKnown, isTrue);
    });
  });

  group('probeModelTool', () {
    late HttpServer server;
    late Map<String, dynamic>? sentBody;
    String? sentAuth;
    Future<void> Function(HttpRequest request) respond = (_) async {};

    setUp(() async {
      sentBody = null;
      sentAuth = null;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        sentAuth = request.headers.value('authorization');
        sentBody =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        await respond(request);
      });
    });
    tearDown(() => server.close(force: true));

    ModelConfiguration config({
      ModelProtocol protocol = ModelProtocol.chatCompletions,
    }) => ModelConfiguration(
      endpoint: 'http://127.0.0.1:${server.port}/v1',
      model: 'probe-model',
      key: 'sk-probe',
      protocol: protocol,
    );

    Future<void> sse(HttpRequest request, List<Object> events) async {
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
      );
      for (final event in events) {
        request.response.write(
          'data: ${event is String ? event : jsonEncode(event)}\n\n',
        );
      }
      await request.response.close();
    }

    Map<String, Object> delta(Map<String, Object?> value, {String? finish}) => {
      'choices': [
        {'delta': value, 'finish_reason': finish},
      ],
    };

    test('a tool call is a pass and the request carries one tool', () async {
      respond = (request) => sse(request, [
        delta({
          'tool_calls': [
            {
              'index': 0,
              'id': 'c1',
              'type': 'function',
              'function': {'name': 'get_time', 'arguments': '{}'},
            },
          ],
        }),
        delta({}, finish: 'tool_calls'),
        '[DONE]',
      ]);
      final result = await probeModelTool(config());
      expect(result, isA<ProbeToolCalled>());
      expect(sentAuth, 'Bearer sk-probe');
      expect(sentBody!['model'], 'probe-model');
      final tools = sentBody!['tools'] as List;
      expect(tools, hasLength(1));
      expect((tools.single as Map)['function']['name'], 'get_time');
      expect(sentBody!['stream'], true);
      // The reply is capped so a reasoning model cannot bill for a long time.
      expect(sentBody!['max_tokens'], probeOutputTokens);
      expect(sentBody!.containsKey('max_completion_tokens'), isFalse);
    });

    test('the cap parameter follows the API that is called', () {
      Map<String, dynamic> body(String endpoint, ModelProtocol protocol) =>
          modelRequestBody(
            ModelConfiguration(
              endpoint: endpoint,
              model: 'm',
              key: 'k',
              protocol: protocol,
            ),
            const [],
            const [],
            maxOutputTokens: probeOutputTokens,
          );
      final openAi = body(
        'https://api.openai.com/v1',
        ModelProtocol.chatCompletions,
      );
      expect(openAi['max_completion_tokens'], probeOutputTokens);
      expect(openAi.containsKey('max_tokens'), isFalse);
      final other = body(
        'https://api.deepseek.com',
        ModelProtocol.chatCompletions,
      );
      expect(other['max_tokens'], probeOutputTokens);
      final responses = body(
        'https://api.openai.com/v1',
        ModelProtocol.responses,
      );
      expect(responses['max_output_tokens'], probeOutputTokens);
      // Ordinary turns keep their own budget.
      final plain = modelRequestBody(
        ModelConfiguration(
          endpoint: 'https://api.openai.com/v1',
          model: 'm',
          key: 'k',
        ),
        const [],
        const [],
      );
      expect(plain['max_tokens'], 12000);
    });

    test('reasoning text counts towards the text limit', () async {
      respond = (request) async {
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        for (var i = 0; i < 100; i++) {
          request.response.write(
            'data: ${jsonEncode(delta({'reasoning_content': 'x' * 100}))}\n\n',
          );
        }
        await request.response.close();
      };
      expect(await probeModelTool(config()), isA<ProbeNoToolCall>());
    });

    test(
      'spending the whole output cap is a model that gave no tool call',
      () async {
        respond = (request) => sse(request, [
          delta({'reasoning_content': 'thinking'}),
          delta({}, finish: 'length'),
          '[DONE]',
        ]);
        expect(await probeModelTool(config()), isA<ProbeNoToolCall>());
      },
    );

    test('a text-only reply is NoToolCall', () async {
      respond = (request) => sse(request, [
        delta({'content': 'It is noon.'}),
        delta({}, finish: 'stop'),
        '[DONE]',
      ]);
      expect(await probeModelTool(config()), isA<ProbeNoToolCall>());
    });

    test('a model that rambles without a tool is cut off', () async {
      respond = (request) async {
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        for (var i = 0; i < 100; i++) {
          request.response.write(
            'data: ${jsonEncode(delta({'content': 'x' * 100}))}\n\n',
          );
        }
        await request.response.close();
      };
      expect(await probeModelTool(config()), isA<ProbeNoToolCall>());
    });

    test(
      'the Responses protocol is probed through function_call items',
      () async {
        respond = (request) => sse(request, [
          {
            'type': 'response.output_item.done',
            'item': {
              'type': 'function_call',
              'call_id': 'c1',
              'name': 'get_time',
              'arguments': '{}',
            },
          },
          {
            'type': 'response.completed',
            'response': {'status': 'completed'},
          },
        ]);
        final result = await probeModelTool(
          config(protocol: ModelProtocol.responses),
        );
        expect(result, isA<ProbeToolCalled>());
        expect(sentBody!['input'], isNotEmpty);
        expect(sentBody!['max_output_tokens'], probeOutputTokens);
      },
    );

    test('HTTP failures keep status and body for classification', () async {
      respond = (request) async {
        request.response.statusCode = 404;
        request.response.write(
          jsonEncode({
            'error': {
              'code': 'model_not_found',
              'message': 'The model `probe-model` does not exist',
            },
          }),
        );
        await request.response.close();
      };
      final result = await probeModelTool(config());
      expect(result, isA<ProbeFailed>());
      final error = (result as ProbeFailed).error;
      expect(error, isA<ModelRequestFailure>());
      final failure = classifyProbeFailure(error, 'probe-model');
      expect(failure.problem, ProbeProblem.notFound);
      expect(failure.detail, contains('does not exist'));
    });

    test('a silent server times out and is abandoned', () async {
      final hold = Completer<void>();
      respond = (request) => hold.future;
      final result = await probeModelTool(
        config(),
        timeout: const Duration(milliseconds: 300),
      );
      hold.complete();
      expect(result, isA<ProbeFailed>());
      expect((result as ProbeFailed).error.code, 'probe_timeout');
      expect(
        classifyProbeFailure(result.error, 'm').problem,
        ProbeProblem.timeout,
      );
    });

    test('an unreachable host is a network failure', () async {
      final bad = ModelConfiguration(
        endpoint: 'http://127.0.0.1:1/v1',
        model: 'm',
        key: 'k',
      );
      final result = await probeModelTool(bad);
      expect(result, isA<ProbeFailed>());
      expect(
        classifyProbeFailure((result as ProbeFailed).error, 'm').problem,
        ProbeProblem.network,
      );
    });
  });

  group('failure classification', () {
    ProbeProblem problem(
      int? status, {
      String body = '',
      String code = 'model_request_failed',
    }) => classifyProbeFailure(
      status == null
          ? AgentFailure(code)
          : ModelRequestFailure(
              status == 0 ? code : code,
              status: status,
              body: body,
            ),
      'm',
    ).problem;

    test('statuses and provider words pick the hint', () {
      expect(problem(401), ProbeProblem.auth);
      expect(problem(402), ProbeProblem.quota);
      expect(
        problem(403, body: '{"error":{"message":"no access to model m"}}'),
        ProbeProblem.notAvailable,
      );
      expect(problem(403, body: 'forbidden'), ProbeProblem.auth);
      expect(problem(404), ProbeProblem.notFound);
      expect(
        problem(
          400,
          body: '{"error":{"message":"The model m does not exist"}}',
        ),
        ProbeProblem.notFound,
      );
      expect(
        problem(400, body: '{"error":{"message":"tools are not supported"}}'),
        ProbeProblem.noTools,
      );
      expect(
        problem(
          400,
          body: '{"error":{"code":"insufficient_quota","message":"x"}}',
        ),
        ProbeProblem.quota,
      );
      expect(problem(429), ProbeProblem.rateLimited);
      expect(problem(500), ProbeProblem.server);
      // OpenAI's reasoning models refuse `max_tokens`: that is about the model.
      expect(
        problem(
          400,
          code: 'unsupported_parameter',
          body:
              '{"error":{"code":"unsupported_parameter","param":"max_tokens",'
              '"message":"Unsupported parameter: max_tokens is not supported with this model."}}',
        ),
        ProbeProblem.modelRejected,
      );
      expect(
        problem(
          400,
          body: '{"error":{"message":"Unsupported value: temperature"}}',
        ),
        ProbeProblem.modelRejected,
      );
      // A 400 that is about the key still blocks.
      expect(
        problem(400, body: '{"error":{"message":"API key not valid"}}'),
        ProbeProblem.other,
      );
      expect(problem(400, body: 'bad request'), ProbeProblem.other);
      expect(problem(503), ProbeProblem.server);
      expect(problem(418, body: 'teapot'), ProbeProblem.other);
    });

    test('codes without a status are read too', () {
      expect(problem(null), ProbeProblem.network);
      expect(problem(null, code: 'model_timeout'), ProbeProblem.timeout);
      expect(problem(null, code: 'model_not_found'), ProbeProblem.notFound);
      expect(problem(null, code: 'invalid_api_key'), ProbeProblem.auth);
      expect(problem(null, code: 'invalid_model_settings'), ProbeProblem.other);
    });

    test('only model-specific problems let the loop move on', () {
      for (final p in ProbeProblem.values) {
        final f = ProbeFailure(p, 'm');
        expect(
          f.modelSpecific,
          [
            ProbeProblem.noTools,
            ProbeProblem.notAvailable,
            ProbeProblem.notFound,
            ProbeProblem.server,
            ProbeProblem.wrongProtocol,
            ProbeProblem.modelRejected,
          ].contains(p),
          reason: '$p',
        );
      }
    });
  });

  group('probeListedModels', () {
    ListedModel listed(
      String id, {
      bool? tools,
      ModelEndpoint? endpoint,
      List<WireProtocol>? protocols,
    }) => ListedModel(
      id: id,
      toolCalls: tools,
      endpoint: endpoint,
      protocols: protocols,
    );

    Future<ProviderTestResult> run(
      List<ListedModel> models,
      Map<String, ProbeResult> outcomes, {
      List<String> family = const [],
      List<String>? tried,
      WireProtocol protocol = WireProtocol.chatCompletions,
      String? preferred,
      List<String> recommended = const [],
    }) => probeListedModels(
      models: models,
      base: const ProviderCapabilities(),
      familyTokens: family,
      protocol: protocol,
      baseUrl: 'https://p.example/v1',
      preferred: preferred,
      recommended: recommended,
      probe: (model) async {
        tried?.add(model);
        return outcomes[model] ?? const ProbeNoToolCall();
      },
    );

    const pass = ProbeToolCalled();
    ProbeFailed fail(int status, [String body = '']) => ProbeFailed(
      ModelRequestFailure('model_http_$status', status: status, body: body),
    );

    test(
      'the model already in use is tried first, if the list has it',
      () async {
        final tried = <String>[];
        final models = [listed('qwen-9'), listed('qwen-3')];
        final result = await run(
          models,
          {'qwen-3': pass, 'qwen-9': pass},
          family: ['qwen'],
          preferred: 'qwen-3',
          tried: tried,
        );
        expect((result as ProviderTestDone).main, 'qwen-3');
        expect(tried, ['qwen-3']);
        tried.clear();
        final unlisted = await run(
          models,
          {'qwen-9': pass},
          family: ['qwen'],
          preferred: 'gone',
          tried: tried,
        );
        expect((unlisted as ProviderTestDone).main, 'qwen-9');
        expect(tried, ['qwen-9']);
      },
    );

    test('recommended models go before the family order', () async {
      final tried = <String>[];
      final models = [
        listed('gpt-9-pro'),
        listed('gpt-5'),
        listed('gpt-4.1-mini'),
        listed('gpt-4.1'),
      ];
      var result =
          await run(
                models,
                {'gpt-4.1-mini': pass},
                family: ['gpt'],
                recommended: ['gpt-4.1-mini', 'gpt-4.1'],
                tried: tried,
              )
              as ProviderTestDone;
      expect(tried, ['gpt-4.1-mini']);
      expect(result.main, 'gpt-4.1-mini');
      // The model in use still comes first; unlisted recommendations are skipped.
      tried.clear();
      result =
          await run(
                models,
                {'gpt-5': pass},
                family: ['gpt'],
                recommended: ['absent', 'gpt-4.1'],
                preferred: 'gpt-5',
                tried: tried,
              )
              as ProviderTestDone;
      expect(tried, ['gpt-5']);
      tried.clear();
      await run(
        models,
        {},
        family: ['gpt'],
        recommended: ['absent', 'gpt-4.1'],
        tried: tried,
      );
      expect(tried.first, 'gpt-4.1');
    });

    test('a model that refuses the request moves on to the next', () async {
      final tried = <String>[];
      final result =
          await run(
                [listed('o-1'), listed('gpt-4.1-mini')],
                {
                  'o-1': fail(
                    400,
                    '{"error":{"code":"unsupported_parameter",'
                    '"message":"Unsupported parameter: max_tokens"}}',
                  ),
                  'gpt-4.1-mini': pass,
                },
                tried: tried,
              )
              as ProviderTestDone;
      expect(tried, ['o-1', 'gpt-4.1-mini']);
      expect(result.main, 'gpt-4.1-mini');
      expect(
        result.rejected.single.failure.problem,
        ProbeProblem.modelRejected,
      );
    });

    test('the first passing model is chosen, own family first', () async {
      final tried = <String>[];
      final result = await run(
        [listed('other-1'), listed('qwen-2'), listed('qwen-3')],
        {'qwen-3': pass},
        family: ['qwen'],
        tried: tried,
      );
      expect(tried, ['qwen-3']);
      expect((result as ProviderTestDone).main, 'qwen-3');
      expect(result.rejected, isEmpty);
    });

    test(
      'a model without a tool call is rejected and the next one tried',
      () async {
        final tried = <String>[];
        final result =
            await run(
                  [listed('a'), listed('b'), listed('c')],
                  {'a': const ProbeNoToolCall(), 'b': pass},
                  tried: tried,
                )
                as ProviderTestDone;
        expect(tried, ['a', 'b']);
        expect(result.main, 'b');
        expect(result.rejected.single.model, 'a');
        expect(result.rejected.single.failure.problem, ProbeProblem.noTools);
      },
    );

    test('at most three models are tried', () async {
      final tried = <String>[];
      final result =
          await run(
                [
                  for (final id in ['a', 'b', 'c', 'd', 'e']) listed(id),
                ],
                {},
                tried: tried,
              )
              as ProviderTestDone;
      expect(tried, ['a', 'b', 'c']);
      expect(result.main, isNull);
      expect(result.rejected, hasLength(3));
    });

    test('a bad key on the first model blocks the save', () async {
      final result = await run([listed('a'), listed('b')], {'a': fail(401)});
      expect(
        (result as ProviderTestBlocked).failure.problem,
        ProbeProblem.auth,
      );
    });

    test('a not-available model moves on; its reason is kept', () async {
      final result =
          await run(
                [listed('a'), listed('b')],
                {
                  'a': fail(
                    403,
                    '{"error":{"message":"no access to model a"}}',
                  ),
                  'b': pass,
                },
              )
              as ProviderTestDone;
      expect(result.main, 'b');
      expect(result.rejected.single.notAvailable, isTrue);
      expect(result.rejected.single.failure.detail, contains('no access'));
    });

    test('one dead upstream (5xx) does not condemn the provider', () async {
      final result =
          await run([listed('a'), listed('b')], {'a': fail(502), 'b': pass})
              as ProviderTestDone;
      expect(result.main, 'b');
      expect(result.rejected.single.serverSide, isTrue);
    });

    test('only server errors means the provider is down', () async {
      final result = await run(
        [listed('a'), listed('b'), listed('c')],
        {'a': fail(502), 'b': fail(503), 'c': fail(500)},
      );
      final blocked = result as ProviderTestBlocked;
      expect(blocked.failure.problem, ProbeProblem.server);
      expect(blocked.failure.model, 'a');
    });

    test(
      'after a server error the key is unproven, so a later auth failure blocks',
      () async {
        final result = await run(
          [listed('a'), listed('b')],
          {'a': fail(500), 'b': fail(401)},
        );
        expect(
          (result as ProviderTestBlocked).failure.problem,
          ProbeProblem.auth,
        );
      },
    );

    test(
      'a failure after a proven key ends the loop without blocking',
      () async {
        final tried = <String>[];
        final result =
            await run(
                  [listed('a'), listed('b'), listed('c')],
                  {'a': const ProbeNoToolCall(), 'b': fail(429)},
                  tried: tried,
                )
                as ProviderTestDone;
        expect(tried, ['a', 'b']);
        expect(result.main, isNull);
        expect(result.rejected.map((r) => r.model), ['a', 'b']);
      },
    );

    test('models that name another route are skipped, not probed', () async {
      final tried = <String>[];
      final result =
          await run(
                [
                  listed(
                    'elsewhere',
                    endpoint: const ModelEndpoint(
                      WireProtocol.chatCompletions,
                      'https://other.example/v1',
                    ),
                  ),
                  listed(
                    'wrong-wire',
                    protocols: const [WireProtocol.messages],
                  ),
                ],
                {},
                tried: tried,
              )
              as ProviderTestDone;
      expect(tried, isEmpty);
      expect(result.main, isNull);
      expect(result.rejected, hasLength(2));
      expect(result.rejected.every((r) => r.skipped), isTrue);
      expect(result.rejected.first.failure.problem, ProbeProblem.wrongProtocol);
    });

    test(
      'a model on the same route with the configured protocol is kept',
      () async {
        final result =
            await run(
                  [
                    listed(
                      'same',
                      endpoint: const ModelEndpoint(
                        WireProtocol.chatCompletions,
                        'https://p.example/v1/',
                      ),
                      protocols: const [WireProtocol.chatCompletions],
                    ),
                  ],
                  {'same': pass},
                )
                as ProviderTestDone;
        expect(result.main, 'same');
      },
    );

    test(
      'nothing usable in the list is neither a pass nor a failure',
      () async {
        final result = await run(const [], {}) as ProviderTestDone;
        expect(result.main, isNull);
        expect(result.rejected, isEmpty);
      },
    );
  });

  group('session header', () {
    test('only providers that require one get a header name', () {
      final opencode = ModelConfiguration(
        endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
        model: 'm',
        key: 'k',
      );
      expect(opencode.sessionHeader, 'x-opencode-session');
      final plain = ModelConfiguration(
        endpoint: 'https://api.deepseek.com',
        model: 'm',
        key: 'k',
      );
      expect(plain.sessionHeader, isNull);
      expect(newSessionId(), matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(newSessionId(), isNot(newSessionId()));
    });
  });
}
