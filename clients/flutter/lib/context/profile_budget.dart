import 'dart:convert';
import 'dart:math';
import '../agent_core/model_client.dart';
import '../personal/local_life.dart';

// shortcut: acceptance-only DashScope pricing; add provider pricing before general use.
class ProfileBudget {
  ProfileBudget(this.persistence, {this.capMicroyuan = limitMicroyuan});
  final LifePersistence persistence;
  static Future<void> _tail = Future.value();
  static const limitMicroyuan = int.fromEnvironment(
    'NOVA_PROFILE_BUDGET_LIMIT_MICROYUAN',
    defaultValue: 5000000,
  );
  final int capMicroyuan;
  int reservedMicroyuan = 0;

  /// Explicit build approval, scoped to the same acceptance ledger. This only
  /// reads accounting: old reservations and pending tickets are never released.
  Future<Map<String, dynamic>?> recoverExhaustedPause(
    Map<String, dynamic> state, {
    required String budgetId,
    required String upgradeId,
    required int previousCapMicroyuan,
    String errorKey = 'error_code',
  }) => _serialize(() async {
    if (state[errorKey] != 'profile_budget_exhausted' ||
        state['manual_pause'] == true ||
        budgetId.isEmpty ||
        upgradeId.isEmpty ||
        previousCapMicroyuan <= 0 ||
        capMicroyuan <= previousCapMicroyuan ||
        state['budget_resume_approval'] == upgradeId ||
        (state['budget_id'] != null && state['budget_id'] != budgetId)) {
      return null;
    }
    final pausedCap = state['budget_limit_microyuan'];
    // A cap-less legacy record requires the explicit from-cap build approval.
    if (pausedCap != null && pausedCap != previousCapMicroyuan) return null;
    final ledger = await _read(requireExisting: true);
    reservedMicroyuan = ledger['reserved_microyuan'] as int;
    if (reservedMicroyuan >= capMicroyuan) return null;
    return {
      ...state,
      'budget_id': budgetId,
      'budget_limit_microyuan': capMicroyuan,
      'budget_resume_approval': upgradeId,
    }..remove(errorKey);
  });

  static int requestCost(
    ModelConfiguration model,
    List<Map<String, dynamic>> messages,
  ) {
    if (model.requestUri.toString() !=
            'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' ||
        model.protocol != ModelProtocol.chatCompletions ||
        !['qwen-flash', 'qwen3-vl-plus'].contains(model.model) ||
        messages.isEmpty ||
        messages.any(
          (m) =>
              !['system', 'user'].contains(m['role']) ||
              m['content'] is! String ||
              m.keys.any((key) => key != 'role' && key != 'content'),
        )) {
      throw const AgentFailure('profile_budget_model_unsupported');
    }
    final body = modelRequestBody(model, messages, []);
    // UTF-8 bytes bound text tokens; reserve extra framing and twice list price.
    final input =
        utf8.encode(jsonEncode(body)).length + 4096 + messages.length * 128;
    final output = body['max_tokens'] as int;
    final visionPlus = model.model == 'qwen3-vl-plus';
    if (input > (visionPlus ? 260096 : 990000) ||
        (visionPlus && input + output > 262144) ||
        output < 1 ||
        output > 32768 ||
        body['enable_thinking'] != false) {
      throw const AgentFailure('profile_budget_request_unsupported');
    }
    // Mainland China / Beijing list prices, checked 2026-10-18:
    // https://help.aliyun.com/zh/model-studio/qwen-flash
    // https://help.aliyun.com/zh/model-studio/qwen3-vl-plus
    // https://help.aliyun.com/zh/model-studio/model-pricing
    // Integer hundredths of CNY per million tokens; output costs 10x input.
    // VL Plus: 1/10, 1.5/15, 3/30 CNY across 32K/128K/256K input tiers.
    // Decimal thresholds deliberately upgrade earlier than binary K boundaries.
    // No discounts for cached input, free quota, or Batch calls are assumed.
    return _tokenCost(model.model, input, output);
  }

  static int _tokenCost(String model, int input, int output) {
    final rate = model == 'qwen3-vl-plus'
        ? (input <= 32000
              ? 100
              : input <= 128000
              ? 150
              : 300)
        : (input <= 128000
              ? 15
              : input <= 256000
              ? 60
              : 120);
    return ((input * rate + output * rate * 10) * 2 + 99) ~/ 100;
  }

  Future<ProfileReservation> reserve(
    ModelConfiguration model,
    List<Map<String, dynamic>> messages,
  ) => _serialize(() async {
    final cost = requestCost(model, messages);
    final ledger = await _read();
    final spent = ledger['reserved_microyuan'] as int;
    reservedMicroyuan = spent;
    if (spent + cost > capMicroyuan) {
      throw const AgentFailure('profile_budget_exhausted');
    }
    final pending = ledger['pending_reservations'] as Map<String, dynamic>;
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final id =
        '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
    if (pending.containsKey(id)) {
      throw const AgentFailure('profile_budget_unavailable');
    }
    pending[id] = {'cost': cost, 'model': model.model};
    ledger['reserved_microyuan'] = spent + cost;
    await persistence.write(jsonEncode(ledger));
    reservedMicroyuan = spent + cost;
    return ProfileReservation._(id);
  });

  /// Failed/cancelled/incomplete responses retain their full durable reservation.
  /// Removing the ticket and reducing the balance use a single atomic write.
  Future<void> settle(ProfileReservation ticket, CompletedModelUsage usage) =>
      _serialize(() async {
        final ledger = await _read();
        final spent = ledger['reserved_microyuan'] as int;
        reservedMicroyuan = spent;
        final pending = ledger['pending_reservations'] as Map<String, dynamic>;
        final reservation = pending[ticket.id] as Map?;
        if (reservation == null) return; // Already settled; never refund twice.
        if (usage.model != reservation['model'] ||
            usage.responseId.isEmpty ||
            usage.promptTokens < 1 ||
            usage.promptTokens > 990000 ||
            usage.completionTokens < 1 ||
            usage.completionTokens > 12000) {
          throw const AgentFailure('profile_budget_usage_invalid');
        }
        final actual = _tokenCost(
          usage.model,
          usage.promptTokens,
          usage.completionTokens,
        );
        final cost = reservation['cost'] as int;
        if (actual > cost) {
          throw const AgentFailure('profile_budget_usage_exceeds_reservation');
        }
        pending.remove(ticket.id);
        ledger['reserved_microyuan'] = spent - cost + actual;
        await persistence.write(jsonEncode(ledger));
        reservedMicroyuan = spent - cost + actual;
      });

  Future<Map<String, dynamic>> _read({bool requireExisting = false}) async {
    final raw = await persistence.read();
    if (requireExisting && raw == null) {
      throw const AgentFailure('profile_budget_unavailable');
    }
    final decoded = raw == null ? {'reserved_microyuan': 0} : jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      throw const AgentFailure('profile_budget_unavailable');
    }
    final spent = decoded['reserved_microyuan'];
    final pending = decoded['pending_reservations'] ?? <String, dynamic>{};
    if (spent is! int ||
        spent < 0 ||
        spent > capMicroyuan ||
        pending is! Map<String, dynamic>) {
      throw const AgentFailure('profile_budget_unavailable');
    }
    var total = 0;
    for (final item in pending.entries) {
      final entry = item.value;
      if (item.key.isEmpty ||
          entry is! Map ||
          entry['cost'] is! int ||
          (entry['cost'] as int) <= 0 ||
          !['qwen-flash', 'qwen3-vl-plus'].contains(entry['model'])) {
        throw const AgentFailure('profile_budget_unavailable');
      }
      total += entry['cost'] as int;
    }
    if (total > spent) throw const AgentFailure('profile_budget_unavailable');
    return {...decoded, 'pending_reservations': pending};
  }

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final result = _tail.then((_) async {
      try {
        return await operation();
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

class ProfileReservation {
  const ProfileReservation._(this.id);
  final String id;
}
