import 'dart:convert';

bool isMemoryTool(Object? name) =>
    const {'memory_remember', 'memory_recall', 'memory_forget'}.contains(name);

/// Tools whose personal payloads exist only during the live turn: memory and
/// the confirmed profile/timeline projection. Durable history keeps receipts.
bool isLiveOnlyTool(Object? name) =>
    isMemoryTool(name) || name == 'profile_read';

/// Durable memory receipts contain metadata only. Apply to old history too, so
/// forgotten payloads cannot be revived from legacy tool results on restart.
void redactMemoryToolHistory(List messages) {
  final callIds = <String>{};
  for (final message in messages.whereType<Map>()) {
    final progress = message['progress'];
    var memoryCall = progress is Map && isLiveOnlyTool(progress['tool']);
    if (memoryCall) {
      progress.remove('draft');
      progress.remove('reasoning');
    }
    for (final call
        in (message['tool_calls'] as List? ?? []).whereType<Map>()) {
      final function = call['function'];
      if (function is! Map || !isLiveOnlyTool(function['name'])) continue;
      memoryCall = true;
      if (call['id'] is String) callIds.add(call['id'] as String);
      Map args = {};
      try {
        args = jsonDecode(function['arguments'] as String) as Map;
      } catch (_) {}
      function['arguments'] = jsonEncode({
        if (function['name'] == 'memory_forget' && args['id'] is String)
          'id': args['id'],
        if (function['name'] == 'memory_remember' &&
            ['fact', 'preference'].contains(args['kind']))
          'kind': args['kind'],
      });
    }
    if (memoryCall) {
      // Providers may duplicate tool payloads in native response items or
      // reasoning; neither is needed to replay a redacted receipt.
      message['content'] = '';
      message.remove('reasoning_content');
      message.remove('_nova_response_items');
    } else if (jsonEncode(
      message['_nova_response_items'],
    ).contains('memory_')) {
      message.remove('_nova_response_items');
    }
  }
  for (final message in messages.whereType<Map>()) {
    if (message['role'] != 'tool' ||
        !(isLiveOnlyTool(message['tool_name']) ||
            callIds.contains(message['tool_call_id']))) {
      continue;
    }
    Map result = {};
    try {
      result = jsonDecode(message['content'] as String) as Map;
    } catch (_) {}
    final data = result['data'] is Map ? result['data'] as Map : result;
    final state = data['state'] ?? data['status'];
    final entry = data['entry'];
    message['content'] = jsonEncode({
      'state':
          const ['committed', 'ok', 'rejected', 'completed'].contains(state)
          ? state
          : 'redacted',
      if (data['id'] is String) 'id': data['id'],
      if (entry is Map && entry['id'] is String) 'id': entry['id'],
      if (data['entries'] is List) 'count': (data['entries'] as List).length,
      if (data['count'] is int) 'count': data['count'],
    });
    message.remove('_nova_response_items');
  }
}
