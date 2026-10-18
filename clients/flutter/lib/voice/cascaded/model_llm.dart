import 'dart:convert';
import '../../agent_core/model_client.dart';
import 'ports.dart';

/// A fresh Dart ModelClient per forebrain turn, separate from AgentCoreHost/iOS.
class ChatCompletionsCascadeLlm implements CascadeLlm {
  ChatCompletionsCascadeLlm({
    required this.configuration,
    ModelClient Function()? clientFactory,
  }) : clientFactory =
           clientFactory ??
           (() => ModelClient(
             maxOutputBytes: 32000,
             maxDuration: const Duration(minutes: 2),
           ));
  final ModelConfiguration configuration;
  final ModelClient Function() clientFactory;
  @override
  Stream<CascadeLlmDelta> generate(
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>> tools,
    CascadeCancellation cancel,
  ) async* {
    cancel.check();
    final client = clientFactory();
    final remove = cancel.onCancel(client.cancel);
    final calls = <int, Map<String, String>>{};
    try {
      await for (final delta in client.stream(
        configuration,
        messages,
        tools: tools,
      )) {
        cancel.check();
        final text = delta['content'];
        if (text is String && text.isNotEmpty) {
          yield CascadeLlmDelta(text: text);
        }
        for (final raw in delta['tool_calls'] as List? ?? []) {
          if (tools.isEmpty ||
              raw is! Map ||
              raw['index'] is! int ||
              raw['index'] < 0 ||
              raw['index'] > 7) {
            throw const CascadeFailure('invalid_tool_call');
          }
          final part = calls.putIfAbsent(
            raw['index'] as int,
            () => {'id': '', 'name': '', 'arguments': ''},
          );
          final id = raw['id'];
          if (id != null && id != '') {
            if (id is! String || (part['id']!.isNotEmpty && part['id'] != id)) {
              throw const CascadeFailure('invalid_tool_call');
            }
            part['id'] = id;
          }
          final fn = raw['function'];
          if (fn != null) {
            if (fn is! Map) throw const CascadeFailure('invalid_tool_call');
            for (final key in ['name', 'arguments']) {
              final fragment = fn[key];
              if (fragment == null) continue;
              if (fragment is! String) {
                throw const CascadeFailure('invalid_tool_call');
              }
              part[key] = part[key]! + fragment;
              if (part[key]!.length > 16000) {
                throw const CascadeFailure('tool_call_overflow');
              }
            }
          }
        }
      }
      cancel.check();
      final ids = <String>{};
      final normalized = <CascadeLlmDelta>[];
      for (final call in calls.values) {
        final id = call['id']!, name = call['name']!;
        if (id.isEmpty ||
            id.length > 256 ||
            !ids.add(id) ||
            name.isEmpty ||
            !tools.any((t) => (t['function'] as Map?)?['name'] == name)) {
          throw const CascadeFailure('invalid_tool_call');
        }
        final args = jsonDecode(call['arguments']!);
        if (args is! Map<String, dynamic>) {
          throw const CascadeFailure('invalid_tool_call');
        }
        normalized.add(
          CascadeLlmDelta(callId: id, name: name, arguments: args),
        );
      }
      for (final call in normalized) {
        yield call;
      }
    } finally {
      remove();
      client.cancel();
    }
  }
}
