import 'dart:async';
import 'package:flutter/services.dart';
import '../protocol/request_id.dart';
import 'model_client.dart';
import 'chatgpt_accounts.dart';

/// iOS owns the network transfer even while Flutter is suspended.
class IosModelClient extends ModelClient {
  static const _channel = MethodChannel('nova/model_transfer/v1');
  String? _request;
  bool _cancelled = false;
  @override
  void cancel() {
    _cancelled = true;
    final id = _request;
    if (id != null) {
      unawaited(
        _channel
            .invokeMethod<void>('cancel', {'id': id})
            .catchError((Object _) {}),
      );
    }
  }

  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    if (_cancelled) throw const AgentFailure('cancelled');
    final accountChanges =
        configuration.protocol == ModelProtocol.chatgptResponses
        ? ChatGptAccounts.changes.stream.listen((_) => cancel())
        : null;
    final id = _request = requestId();
    final controller = StreamController<Map<String, dynamic>>();
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'deltas' &&
          call.arguments is Map &&
          call.arguments['id'] == id &&
          !_cancelled &&
          !controller.isClosed) {
        for (final delta in call.arguments['deltas'] as List? ?? []) {
          controller.add(Map<String, dynamic>.from(delta as Map));
        }
      }
    });
    Future<void> receive() async {
      try {
        final value = await _channel.invokeMapMethod<String, dynamic>(
          'request',
          {
            'id': id,
            'configuration': {
              ...configuration.toJson(),
              'endpoint': configuration.requestUri.toString(),
            },
            'body': modelRequestBody(configuration, messages, tools),
          },
        );
        if (_cancelled) throw const AgentFailure('cancelled');
        final choices = value?['choices'];
        if (choices is! List || choices.length != 1 || choices.single is! Map) {
          throw const AgentFailure('invalid_model_response');
        }
        final choice = choices.single as Map;
        if (choice['finish_reason'] == 'length') {
          throw const AgentFailure('model_output_limit');
        }
        final message = choice['message'];
        if (message is! Map ||
            (message['content'] != null && message['content'] is! String) ||
            (message['tool_calls'] != null && message['tool_calls'] is! List)) {
          throw const AgentFailure('invalid_model_response');
        }
        final calls = message['tool_calls'] as List? ?? [];
        controller.add({
          '_nova_replace': true,
          'content': message['content'] ?? '',
          if (message['_nova_response_items'] != null)
            '_nova_response_items': message['_nova_response_items'],
          if (calls.isNotEmpty)
            'tool_calls': [
              for (var i = 0; i < calls.length; i++)
                {...Map<String, dynamic>.from(calls[i] as Map), 'index': i},
            ],
        });
      } on PlatformException catch (e) {
        controller.addError(AgentFailure(_cancelled ? 'cancelled' : e.code));
      } catch (e) {
        controller.addError(
          e is AgentFailure ? e : const AgentFailure('invalid_model_response'),
        );
      } finally {
        await controller.close();
      }
    }

    unawaited(receive());
    try {
      await for (final delta in controller.stream) {
        if (_cancelled) throw const AgentFailure('cancelled');
        yield delta;
      }
    } finally {
      await accountChanges?.cancel();
      _request = null;
      _channel.setMethodCallHandler(null);
    }
  }
}
