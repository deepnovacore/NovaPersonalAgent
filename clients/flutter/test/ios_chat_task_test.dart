import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent/native_chat_task.dart';

class NativeFixture implements LocalAgent {
  Map<String, dynamic>? runInput;
  var phase = 'running';
  var stops = 0, polls = 0, starts = 0;
  bool finish = true;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    if (method == 'run') {
      starts++;
      runInput = Map.of(input);
      return {'id': input['id'], 'phase': phase};
    }
    if (method == 'stop') {
      stops++;
      phase = 'cancelled';
      return {};
    }
    if (method == 'tasks') {
      polls++;
      if (finish && polls >= 2 && phase == 'running') phase = 'completed';
      return [
        {
          'id': runInput!['id'],
          'phase': phase,
          'summary': 'Synthetic result',
          'operations': [
            {
              'id': 'op-one',
              'state': 'applied',
              'result': {'id': 'created-one'},
            },
          ],
        },
      ];
    }
    throw StateError('Unexpected $method');
  }
}

void main() {
  const request = {
    'goal': 'Create synthetic event',
    'scope': 'calendar',
    'acceptance': 'One event exists',
  };
  test('chat task returns completion receipts, not merely started', () async {
    final native = NativeFixture();
    final runner = NativeChatTaskRunner(
      agent: native,
      pollInterval: Duration.zero,
    );
    final result = await runner.run(request, 'stable-id');
    expect(native.runInput, {
      'id': 'stable-id',
      'goal': 'Create synthetic event',
      'target_package': 'calendar',
      'acceptance': 'One event exists',
      'interaction_mode': 'chat',
    });
    expect(native.polls, 2);
    expect(result['status'], 'completed');
    expect(result['summary'], 'Synthetic result');
    expect(
      (result['operations'] as List).single['result']['id'],
      'created-one',
    );
  });
  test('stop reaches native task and never reports completion', () async {
    final native = NativeFixture()..finish = false;
    final runner = NativeChatTaskRunner(
      agent: native,
      pollInterval: const Duration(milliseconds: 1),
    );
    final running = runner.run(request, 'cancel-id');
    await Future<void>.delayed(const Duration(milliseconds: 5));
    await runner.cancel();
    final result = await running;
    expect(native.stops, greaterThanOrEqualTo(1));
    expect(result['status'], 'cancelled');
  });
  test('interrupted task remains unknown and is never restarted', () async {
    final native = NativeFixture()..phase = 'interrupted';
    final runner = NativeChatTaskRunner(
      agent: native,
      pollInterval: Duration.zero,
    );
    expect(
      (await runner.run(request, 'unknown-id'))['status'],
      'outcome_unknown',
    );
    expect(native.starts, 1);
  });
  test('timeout stops the native task instead of leaving it running', () async {
    final native = NativeFixture()..finish = false;
    final runner = NativeChatTaskRunner(
      agent: native,
      pollInterval: Duration.zero,
      timeout: Duration.zero,
    );
    expect(
      (await runner.run(request, 'timeout-id'))['status'],
      'outcome_unknown',
    );
    expect(native.stops, greaterThanOrEqualTo(1));
  });
}
