import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/ios_model_client.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('nova/model_transfer/v1');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));
  test(
    'Responses native transfer keeps explicit protocol, normalized URL and reasoning',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        final args = call.arguments as Map;
        expect(
          args['configuration']['endpoint'],
          'https://example.com/v1/responses',
        );
        expect(args['configuration']['protocol'], 'responses');
        expect(args['body']['store'], false);
        expect(args['body'].containsKey('messages'), false);
        return {
          'choices': [
            {
              'message': {
                'content': 'ok',
                '_nova_response_items': [
                  {'type': 'reasoning', 'encrypted_content': 'opaque'},
                ],
              },
            },
          ],
        };
      });
      final deltas = await IosModelClient()
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'k',
              protocol: ModelProtocol.responses,
            ),
            [],
          )
          .toList();
      expect(deltas.single['_nova_response_items'], hasLength(1));
    },
  );
  test(
    'uses a background transfer with SSE, then feeds real tool calls into the existing loop',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'request');
        final args = call.arguments as Map;
        expect(args['body']['stream'], true);
        expect(args['body']['messages'], [
          {'role': 'user', 'content': 'build'},
        ]);
        return {
          'choices': [
            {
              'finish_reason': 'tool_calls',
              'message': {
                'content': 'Saving',
                'tool_calls': [
                  {
                    'id': 'a',
                    'type': 'function',
                    'function': {
                      'name': 'artifact_write',
                      'arguments': '{"title":"blocks"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      });
      final chunks = await IosModelClient().stream(
        ModelConfiguration(
          endpoint: 'https://example.com/v1',
          model: 'm',
          key: 'test',
        ),
        [
          {'role': 'user', 'content': 'build'},
        ],
      ).toList();
      expect(chunks.single['content'], 'Saving');
      expect(chunks.single['tool_calls'].single['index'], 0);
      expect(
        chunks.single['tool_calls'].single['function']['name'],
        'artifact_write',
      );
    },
  );
  test(
    'native deltas appear before completion; final snapshot replaces the preview',
    () async {
      final started = Completer<String>(), finish = Completer<Object?>();
      messenger.setMockMethodCallHandler(channel, (call) async {
        started.complete(call.arguments['id'] as String);
        return finish.future;
      });
      final deltas = <Map<String, dynamic>>[];
      final done = Completer<void>();
      final client = IosModelClient();
      client
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'test',
            ),
            [],
          )
          .listen(
            deltas.add,
            onDone: done.complete,
            onError: done.completeError,
          );
      final id = await started.future;
      final delivered = Completer<void>();
      messenger.handlePlatformMessage(
        'nova/model_transfer/v1',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('deltas', {
            'id': id,
            'deltas': [
              {'content': 'Hello'},
            ],
          }),
        ),
        (_) => delivered.complete(),
      );
      await delivered.future;
      await Future<void>.delayed(Duration.zero);
      expect(deltas.single['content'], 'Hello');
      expect(done.isCompleted, false);
      finish.complete({
        'choices': [
          {
            'finish_reason': 'stop',
            'message': {'content': 'Hello there'},
          },
        ],
      });
      await done.future;
      expect(deltas.last['_nova_replace'], true);
      expect(deltas.last['content'], 'Hello there');
    },
  );
  test(
    'cancel reaches the native background transfer and late results never become tools',
    () async {
      final started = Completer<void>(),
          ended = Completer<Map<String, dynamic>>();
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'request') {
          started.complete();
          return ended.future;
        }
        expect(call.method, 'cancel');
        ended.complete({
          'choices': [
            {
              'finish_reason': 'stop',
              'message': {'content': 'late'},
            },
          ],
        });
        return null;
      });
      final client = IosModelClient();
      final response = client
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'test',
            ),
            [],
          )
          .toList();
      await started.future;
      client.cancel();
      await expectLater(
        response,
        throwsA(isA<AgentFailure>().having((e) => e.code, 'code', 'cancelled')),
      );
    },
  );
  test(
    'output truncation is explicit; an incomplete tool is never dispatched',
    () async {
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => {
          'choices': [
            {
              'finish_reason': 'length',
              'message': {'content': 'partial'},
            },
          ],
        },
      );
      await expectLater(
        IosModelClient()
            .stream(
              ModelConfiguration(
                endpoint: 'https://example.com/v1',
                model: 'm',
                key: 'test',
              ),
              [],
            )
            .toList(),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'model_output_limit',
          ),
        ),
      );
    },
  );
}
