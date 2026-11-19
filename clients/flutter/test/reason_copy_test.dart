import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/reason_copy.dart';
import 'package:nova_mobile/ui/tool_step.dart';

void main() {
  test('repeat tap refusal is readable in tool results', () {
    for (final code in [
      'repeat_tap_same_element',
      'model_repeat_tap_same_element',
    ]) {
      expect(toolResultCopy({'reason': code}), '同一个按钮刚点过，为避免反复切换没有再点');
      expect(
        toolResultCopy({'reason': code}, language: 'en'),
        'Just tapped this same control; not tapping it again',
      );
    }
  });
  test(
    'model reasons and unknown codes never render raw in either language',
    () {
      for (final language in ['zh', 'en']) {
        for (final code in [
          'model_invalid_action_fields',
          'model_invalid_model_decision',
          'model_unsupported_action',
          'model_invalid_coordinate',
          'model_invalid_input',
          'model_timeout',
          'model_http_503',
          'model_dns_failed',
          'model_tls_failed',
          'model_invalid_response',
          'model_observation_limit',
          'model_needs_user',
          'model_future_error',
          'no_progress',
          'unknown_future_code',
        ]) {
          expect(
            toolResultCopy({'reason': code}, language: language),
            isNot(contains(code)),
          );
          expect(humanReason(code, language: language), isNot(contains('_')));
        }
      }
      expect(humanReason('Please check the app.'), 'Please check the app.');
    },
  );

  test(
    'model failure with accounted-for actions is stopped, not uncertain',
    () {
      const data = {
        'reason': 'model_invalid_action_fields',
        'dispatched_actions': 3,
        'unresolved_actions': 0,
        'action_in_flight': false,
      };
      expect(
        const ToolStep(
          name: 'device_run_task',
          status: 'outcome_unknown',
          data: data,
        ).state,
        '中途停止',
      );
      expect(
        const ToolStep(
          name: 'device_run_task',
          status: 'outcome_unknown',
          data: data,
          language: 'en',
        ).state,
        'Stopped partway through',
      );
      for (final changed in [
        {...data, 'unresolved_actions': 1},
        {...data, 'action_in_flight': true},
        {'reason': 'model_timeout'},
      ]) {
        expect(
          ToolStep(
            name: 'device_run_task',
            status: 'outcome_unknown',
            data: changed,
          ).state,
          '无法确认结果',
        );
      }
    },
  );
}
