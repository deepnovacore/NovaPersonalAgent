import 'dart:async';
import 'dart:collection';
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
  void handleTransfers(Future<Object?> Function(MethodCall) handler) {
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'reserve') {
        expect((call.arguments as Map).keys, ['id']);
        return 'native-reservation';
      }
      expect(call.arguments['reservation'], 'native-reservation');
      return handler(call);
    });
  }

  test(
    'Responses native transfer keeps explicit protocol, normalized URL and reasoning',
    () async {
      handleTransfers((call) async {
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
      handleTransfers((call) async {
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
    'native final frame forwards reasoning_content for the thinking UI',
    () async {
      handleTransfers((call) async {
        expect(call.method, 'request');
        final args = call.arguments as Map;
        expect(
          args['configuration']['endpoint'],
          'https://api.deepseek.com/v1/chat/completions',
        );
        return {
          'choices': [
            {
              'finish_reason': 'stop',
              'message': {'content': '答案', 'reasoning_content': '先思考再回答'},
            },
          ],
        };
      });
      final deltas = await IosModelClient().stream(
        ModelConfiguration(
          endpoint: 'https://api.deepseek.com/v1',
          model: 'deepseek-reasoner',
          key: 'synthetic',
        ),
        [
          {'role': 'user', 'content': 'hello'},
        ],
      ).toList();
      expect(deltas.single['_nova_replace'], true);
      expect(deltas.single['content'], '答案');
      expect(deltas.single['reasoning_content'], '先思考再回答');
    },
  );
  test(
    'native deltas appear before completion; final snapshot replaces the preview',
    () async {
      final started = Completer<String>(), finish = Completer<Object?>();
      handleTransfers((call) async {
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
      final ignored = Completer<void>();
      messenger.handlePlatformMessage(
        'nova/model_transfer/v1',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('deltas', {
            'id': id,
            'reservation': 'obsolete-native-reservation',
            'deltas': [
              {'content': 'old sensitive bytes'},
            ],
          }),
        ),
        (_) => ignored.complete(),
      );
      await ignored.future;
      await Future<void>.delayed(Duration.zero);
      expect(deltas, isEmpty);
      final delivered = Completer<void>();
      messenger.handlePlatformMessage(
        'nova/model_transfer/v1',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('deltas', {
            'id': id,
            'reservation': 'native-reservation',
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
      handleTransfers((call) async {
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
      handleTransfers(
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
  test(
    'cancel during pending reservation never sends a request body',
    () async {
      final reserved = Completer<void>(), reply = Completer<String>();
      final cancelled = Completer<void>();
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        if (call.method == 'reserve') {
          expect((call.arguments as Map).keys, ['id']);
          reserved.complete();
          return reply.future;
        }
        expect(call.method, 'cancel');
        expect(call.arguments['reservation'], 'delayed-native-reservation');
        cancelled.complete();
        return null;
      });
      final client = IosModelClient();
      final response = client.stream(
        ModelConfiguration(
          endpoint: 'https://example.com/v1',
          model: 'm',
          key: 'k',
        ),
        [
          {'role': 'user', 'content': 'private memory'},
        ],
      ).toList();
      final expectation = expectLater(
        response,
        throwsA(isA<AgentFailure>().having((e) => e.code, 'code', 'cancelled')),
      );
      await reserved.future;
      client.cancel();
      expect(calls, ['reserve']);
      reply.complete('delayed-native-reservation');
      await cancelled.future;
      await expectation;
      expect(calls, ['reserve', 'cancel']);
    },
  );

  test('cancel at reservation reply boundary cannot admit a body', () async {
    final client = IosModelClient();
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'reserve') {
        client.cancel();
        return 'reply-boundary-reservation';
      }
      expect(call.method, 'cancel');
      expect(call.arguments['reservation'], 'reply-boundary-reservation');
      return null;
    });
    await expectLater(
      client
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'k',
            ),
            [],
          )
          .toList(),
      throwsA(isA<AgentFailure>().having((e) => e.code, 'code', 'cancelled')),
    );
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['reserve', 'cancel']);
  });
  test(
    'subscription cancellation fences delayed reserve without poisoning the next round',
    () async {
      final waiting = Completer<void>(), firstReply = Completer<String>();
      final cancelled = Completer<void>();
      final calls = <String>[];
      var rounds = 0, requests = 0;
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        if (call.method == 'reserve') {
          if (++rounds == 1) {
            waiting.complete();
            return firstReply.future;
          }
          return 'fresh-native-reservation';
        }
        if (call.method == 'cancel') {
          cancelled.complete();
          throw PlatformException(code: 'synthetic_cleanup_failure');
        }
        expect(call.method, 'request');
        requests++;
        expect(call.arguments['reservation'], 'fresh-native-reservation');
        return {
          'choices': [
            {
              'message': {'content': 'fresh round'},
            },
          ],
        };
      });
      final client = IosModelClient();
      final privateMessages = _UnreadMessages();
      final deltas = <Map<String, dynamic>>[];
      final subscription = client
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'k',
            ),
            privateMessages,
          )
          .listen(deltas.add);
      await waiting.future;
      await subscription.cancel().timeout(const Duration(seconds: 1));
      firstReply.complete('abandoned-native-reservation');
      await cancelled.future;
      await Future<void>.delayed(Duration.zero);
      expect(requests, 0);
      expect(privateMessages.reads, 0);
      expect(deltas, isEmpty);
      final fresh = await client.stream(
        ModelConfiguration(
          endpoint: 'https://example.com/v1',
          model: 'm',
          key: 'k',
        ),
        [
          {'role': 'user', 'content': 'fresh request'},
        ],
      ).toList();
      expect(fresh.single['content'], 'fresh round');
      expect(requests, 1);
      expect(calls, ['reserve', 'cancel', 'reserve', 'request']);
    },
  );
  test(
    'subscription disappearance revokes an admitted request and ignores late native failure',
    () async {
      final admitted = Completer<void>(), reply = Completer<Object?>();
      final revoked = Completer<void>();
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'reserve') return 'active-native-reservation';
        if (call.method == 'request') {
          admitted.complete();
          return reply.future;
        }
        expect(call.method, 'cancel');
        expect(call.arguments['reservation'], 'active-native-reservation');
        revoked.complete();
        throw PlatformException(code: 'synthetic_cancel_failure');
      });
      final chunks = <Map<String, dynamic>>[];
      final subscription = IosModelClient()
          .stream(
            ModelConfiguration(
              endpoint: 'https://example.com/v1',
              model: 'm',
              key: 'k',
            ),
            [],
          )
          .listen(chunks.add);
      await admitted.future;
      await subscription.cancel();
      await revoked.future;
      reply.completeError(PlatformException(code: 'synthetic_late_failure'));
      await Future<void>.delayed(Duration.zero);
      expect(chunks, isEmpty);
    },
  );
}

// Any attempt to construct a request body from the abandoned round is a failure.
class _UnreadMessages extends ListBase<Map<String, dynamic>> {
  int reads = 0;
  @override
  int get length {
    reads++;
    throw StateError('abandoned body read');
  }

  @override
  set length(int value) => throw UnsupportedError('length');
  @override
  Map<String, dynamic> operator [](int index) {
    reads++;
    throw StateError('abandoned body read');
  }

  @override
  void operator []=(int index, Map<String, dynamic> value) =>
      throw UnsupportedError('write');
}
