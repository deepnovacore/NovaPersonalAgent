import 'dart:async';
import 'package:flutter/services.dart';
import '../protocol/request_id.dart';
import 'model_client.dart';
import 'chatgpt_accounts.dart';

/// iOS owns the network transfer even while Flutter is suspended.
class IosModelClient extends ModelClient {
  static const _channel = MethodChannel('nova/model_transfer/v1');
  String? _request, _reservation;
  int _cancelGeneration = 0;
  bool _cancelled = false;
  @override
  void cancel() {
    _cancelled = true;
    _cancelGeneration++;
    final id = _request;
    final reservation = _reservation;
    if (id != null && reservation != null) {
      unawaited(_cancelNative(id, reservation));
    }
  }

  Future<void> _cancelNative(String id, String reservation) => _channel
      .invokeMethod<void>('cancel', {'id': id, 'reservation': reservation})
      .catchError((Object _) {});

  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) {
    final id = requestId();
    final controller = StreamController<Map<String, dynamic>>();
    String? reservation;
    StreamSubscription<void>? accountChanges;
    var stopped = false, finished = false, submitted = false;
    var operationGeneration = 0;
    Future<void>? releaseFuture;
    Future<void> release() => releaseFuture ??= () async {
      try {
        await accountChanges?.cancel();
      } catch (_) {}
      if (_request == id) {
        _request = _reservation = null;
        _channel.setMethodCallHandler(null);
      }
    }();
    Future<void> receive() async {
      final cancelGeneration = _cancelGeneration;
      final operation = operationGeneration;
      try {
        if (_cancelled) throw const AgentFailure('cancelled');
        reservation = await _channel.invokeMethod<String>('reserve', {
          'id': id,
        });
        if (reservation == null) {
          throw const AgentFailure('invalid_model_request');
        }
        // Listener disappearance is local to this round, not client.cancel().
        if (stopped || operation != operationGeneration) return;
        if (_cancelled || cancelGeneration != _cancelGeneration) {
          throw const AgentFailure('cancelled');
        }
        if (_request == id) _reservation = reservation;
        final body = modelRequestBody(
          configuration,
          messages,
          tools,
          disableThinking: disableThinking,
        );
        submitted = true;
        final value = await _channel.invokeMapMethod<String, dynamic>(
          'request',
          {
            'id': id,
            'reservation': reservation,
            'configuration': {
              ...configuration.toJson(),
              'endpoint': configuration.requestUri.toString(),
            },
            'body': body,
          },
        );
        if (stopped || operation != operationGeneration) return;
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
        final reasoning = message['reasoning_content'];
        controller.add({
          '_nova_replace': true,
          'content': message['content'] ?? '',
          if (reasoning is String) 'reasoning_content': reasoning,
          if (message['_nova_response_items'] != null)
            '_nova_response_items': message['_nova_response_items'],
          if (calls.isNotEmpty)
            'tool_calls': [
              for (var i = 0; i < calls.length; i++)
                {...Map<String, dynamic>.from(calls[i] as Map), 'index': i},
            ],
        });
      } on PlatformException catch (e) {
        if (!stopped) {
          controller.addError(AgentFailure(_cancelled ? 'cancelled' : e.code));
        }
      } catch (e) {
        if (!stopped) {
          controller.addError(
            e is AgentFailure
                ? e
                : const AgentFailure('invalid_model_response'),
          );
        }
      } finally {
        if (!submitted && reservation != null) {
          unawaited(_cancelNative(id, reservation!));
        }
        finished = true;
        await release();
        await controller.close();
      }
    }

    controller.onListen = () {
      _request = id;
      _reservation = null;
      accountChanges = configuration.protocol == ModelProtocol.chatgptResponses
          ? ChatGptAccounts.changes.stream.listen((_) => cancel())
          : null;
      _channel.setMethodCallHandler((call) async {
        if (call.method == 'deltas' &&
            call.arguments is Map &&
            call.arguments['id'] == id &&
            reservation != null &&
            call.arguments['reservation'] == reservation &&
            !stopped &&
            !_cancelled &&
            !controller.isClosed) {
          for (final delta in call.arguments['deltas'] as List? ?? []) {
            controller.add(Map<String, dynamic>.from(delta as Map));
          }
        }
      });
      unawaited(receive());
    };
    controller.onCancel = () {
      stopped = true;
      operationGeneration++;
      if (!finished && reservation != null) {
        unawaited(_cancelNative(id, reservation!));
      }
      return release();
    };
    return controller.stream;
  }
}
