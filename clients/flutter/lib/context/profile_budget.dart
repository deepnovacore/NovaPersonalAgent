import 'dart:convert';
import '../agent_core/model_client.dart';
import '../personal/local_life.dart';

// shortcut: acceptance-only DashScope pricing; add provider pricing before general use.
class ProfileBudget {
  ProfileBudget(this.persistence);
  final LifePersistence persistence;
  static Future<void> _tail = Future.value();
  static const limitMicroyuan = 5000000;
  int reservedMicroyuan = 0;

  static int requestCost(
    ModelConfiguration model,
    List<Map<String, dynamic>> messages,
  ) {
    if (model.requestUri.toString() !=
            'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' ||
        model.protocol != ModelProtocol.chatCompletions ||
        model.model != 'qwen-flash' ||
        messages.isEmpty ||
        messages.any(
          (m) =>
              !['system', 'user'].contains(m['role']) ||
              m['content'] is! String,
        )) {
      throw const AgentFailure('profile_budget_model_unsupported');
    }
    final body = modelRequestBody(model, messages, []);
    // UTF-8 bytes bound text tokens; reserve extra framing and twice list price.
    final input =
        utf8.encode(jsonEncode(body)).length + 4096 + messages.length * 128;
    final output = body['max_tokens'] as int;
    if (input > 990000 ||
        output < 1 ||
        output > 32768 ||
        body['enable_thinking'] != false) {
      throw const AgentFailure('profile_budget_request_unsupported');
    }
    // CNY per million tokens, checked 2026-10-18:
    // https://help.aliyun.com/zh/model-studio/qwen-flash
    final rate = input <= 128000
        ? 15
        : input <= 256000
        ? 60
        : 120;
    return ((input * rate + output * rate * 10) * 2 + 99) ~/ 100;
  }

  Future<void> reserve(
    ModelConfiguration model,
    List<Map<String, dynamic>> messages,
  ) {
    final result = _tail.then((_) async {
      final cost = requestCost(model, messages);
      try {
        final raw = await persistence.read();
        final ledger = raw == null
            ? {'reserved_microyuan': 0}
            : jsonDecode(raw);
        final spent = ledger is Map ? ledger['reserved_microyuan'] : null;
        if (spent is! int || spent < 0 || spent > limitMicroyuan) {
          throw const AgentFailure('profile_budget_unavailable');
        }
        reservedMicroyuan = spent;
        if (spent + cost > limitMicroyuan) {
          throw const AgentFailure('profile_budget_exhausted');
        }
        // Never refund failed or cancelled requests; keep the reservation on restart.
        await persistence.write(
          jsonEncode({'reserved_microyuan': spent + cost}),
        );
        reservedMicroyuan = spent + cost;
      } on AgentFailure {
        rethrow;
      } catch (_) {
        throw const AgentFailure('profile_budget_unavailable');
      }
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }
}
