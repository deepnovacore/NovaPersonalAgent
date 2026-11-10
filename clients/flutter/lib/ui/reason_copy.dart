/// Human copy for native/runtime reason codes. Unknown codes never reach UI.
String reasonCopy(Object? reason, {String language = 'zh', String? fallback}) {
  final copy = _lookup(reason);
  return copy == null
      ? fallback ??
            (language == 'zh' ? '需要你查看任务状态' : 'Please check the task status')
      : language == 'zh'
      ? copy.$1
      : copy.$2;
}

/// Whether [reason] is a code with real human copy.
bool hasReasonCopy(Object? reason) => _lookup(reason) != null;

(String, String)? _lookup(Object? reason) {
  final text = reason is String ? reason.trim() : '';
  final exact = _reasons[text];
  if (exact != null) return exact;
  for (final entry in _prefixes.entries) {
    if (text.startsWith(entry.key)) return entry.value;
  }
  return null;
}

/// Display prose as-is; translate only a value that is wholly a known code.
/// Tokens inside prose are never rewritten. Non-text payloads are not
/// rendered as raw maps or lists.
String humanReason(Object? value, {String language = 'zh', String? fallback}) {
  final text = value is String ? value.trim() : '';
  if (text.isEmpty) return fallback ?? '';
  return hasReasonCopy(text) ||
          RegExp(r'^[a-z][a-z0-9]*_[a-z0-9_]+$').hasMatch(text)
      ? reasonCopy(text, language: language, fallback: fallback)
      : text;
}

/// Presentation only: the journal still requires reconciliation after effects.
bool knownStepsStopped(Map? data) {
  if (data == null ||
      data['unresolved_actions'] != 0 ||
      data['action_in_flight'] != false) {
    return false;
  }
  final reason = data['reason'] ?? data['error'];
  return reason is String &&
      (reason.startsWith('model_') ||
          reason == 'no_progress' ||
          reason == 'invalid_model_response');
}

/// Preferred human explanation from a tool's result data.
String toolResultCopy(Object? data, {String language = 'zh'}) {
  if (data is! Map) return '';
  for (final key in ['reason', 'summary', 'error']) {
    final value = data[key];
    if (value is String && value.trim().isNotEmpty) {
      return humanReason(value, language: language);
    }
  }
  return '';
}

const _prefixes = <String, (String, String)>{
  'model_http_': ('执行模型服务暂时不可用', 'The execution model service is unavailable'),
  'model_invalid_': (
    '执行模型给出的操作无效',
    'The execution model returned an invalid action',
  ),
  'model_': (
    '执行模型出错，任务已停止',
    'The task stopped because of an execution model error',
  ),
  'launch_': ('打开 App 时出了问题', 'Something went wrong opening the app'),
  'observation_': ('没能读取当前屏幕', 'Could not read the current screen'),
};

const _reasons = <String, (String, String)>{
  'repeat_tap_same_element': (
    '同一个按钮刚点过，为避免反复切换没有再点',
    'Just tapped this same control; not tapping it again',
  ),
  'model_repeat_tap_same_element': (
    '同一个按钮刚点过，为避免反复切换没有再点',
    'Just tapped this same control; not tapping it again',
  ),
  'model_unsupported_action': (
    '执行模型给出的操作不受支持',
    'The execution model requested an unsupported action',
  ),
  'model_timeout': ('执行模型响应超时', 'The execution model timed out'),
  'model_dns_failed': (
    '无法连接执行模型服务',
    'Could not connect to the execution model service',
  ),
  'model_tls_failed': (
    '无法安全连接执行模型服务',
    'Could not securely connect to the execution model service',
  ),
  'model_observation_limit': (
    '屏幕观察次数已用完',
    'The screen observation limit was reached',
  ),
  'model_needs_user': (
    '执行模型需要你接手',
    'The execution model needs you to take over',
  ),
  'time_limit': ('这次执行的时间用完了', 'The time limit was reached'),
  'native_loop_failed': ('任务执行中出错了', 'The task failed while running'),
  'execution_interrupted': ('执行被中断了', 'The run was interrupted'),
  'virtual_setup_failed': (
    '虚拟屏没能准备好',
    'The virtual screen could not be set up',
  ),
  'space_changed': ('当前空间已切换', 'The space was changed'),
  'task_stopped': ('任务已停止', 'The task was stopped'),
  'app_name_ambiguous': (
    '有多个 App 名称相近，请说得更具体',
    'Several apps match that name; be more specific',
  ),
  'app_name_required': ('请告诉我要操作哪个 App', 'Tell me which app to use'),
  'task_id_conflict': ('任务编号冲突，请重试', 'Task id conflict; try again'),
  'accessibility_unavailable': (
    '系统的无障碍服务断开了',
    'The system accessibility service disconnected',
  ),
  'a11y_interrupted': (
    '系统的无障碍服务断开了',
    'The system accessibility service disconnected',
  ),
  'a11y_destroyed': (
    '系统的无障碍服务断开了',
    'The system accessibility service disconnected',
  ),
  'a11y_reconnected': (
    '系统的无障碍服务断开了',
    'The system accessibility service disconnected',
  ),
  'helper_unavailable': ('手机助手没连上', 'The phone helper is not connected'),
  'step_limit': ('步骤用完了', 'The step budget was used up'),
  'no_progress': (
    '页面反复出现，已暂停；请先在 App 里核对',
    'Paused after repeated screens; check previous actions in the app first',
  ),
  'action_outcome_unknown': (
    '有一处操作无法确认是否生效',
    'We could not confirm whether an action took effect',
  ),
  'outcome_unknown': ('无法确认结果', 'Unable to confirm the result'),
  'secure_page': ('遇到受保护页面', 'Reached a protected page'),
  'outside_target_app': ('离开了目标 App', 'Left the target app'),
  'device_busy': ('手机正忙', 'The phone is busy'),
  'timed_out': ('已超时', 'Timed out'),
  'blocked': ('先核对上一步', 'Check the previous step first'),
  'blocked_by_unresolved_prior_action': (
    '先核对上一步',
    'Check the previous step first',
  ),
  'prior_task_unverified': ('先核对上一步', 'Check the previous step first'),
  'cancelled_before_execution': ('未执行', 'Not executed'),
  'denied': ('你未允许，未执行', 'Not executed because you did not allow it'),
  'rejected': ('Nova 未执行（不被允许）', 'Nova did not execute this (not permitted)'),
  'model_required': ('请先配置模型', 'Set up a model first'),
  'model_settings_required': ('请先配置模型', 'Set up a model first'),
  'schedule_schema': (
    '定时任务记录暂时无法读取，请更新 Nova 后再试',
    'Cannot read schedule records; update Nova and try again',
  ),
  'schedule_disposed': (
    '定时任务页面已关闭，请重新打开',
    'The schedule page closed; open it again',
  ),
  'invalid_timezone': ('请检查时区', 'Check the time zone'),
  'invalid_time': ('请检查执行时间', 'Check the scheduled time'),
  'invalid_date': ('请检查执行日期', 'Check the scheduled date'),
  'invalid_schedule': (
    '请填写任务名称、目标并检查时间设置',
    'Enter a task name and goal, and check its schedule',
  ),
  'invalid_rule': ('请检查日期、时间和时区', 'Check the date, time and time zone'),
  'invalid_weekdays': ('请选择每周执行的日期', 'Choose the days of the week to run'),
  'timezone_unavailable': (
    '这个时区暂时不可用，请检查时区名称',
    'This time zone is unavailable; check its name',
  ),
  'nonexistent_local_time': (
    '所选时间因夏令时不存在，请换一个时间',
    'This time does not exist due to daylight saving; choose another time',
  ),
  'schedule_in_past': (
    '执行时间已经过去了，请选择以后的时间',
    'The scheduled time has passed; choose a future time',
  ),
  'schedule_capacity': (
    '定时任务记录已满，请先整理旧记录',
    'Schedule storage is full; remove old records first',
  ),
  'stale_schedule': (
    '任务设置已更新，请刷新后再试',
    'The schedule changed; refresh and try again',
  ),
  'stale_run': (
    '执行状态已更新，请刷新后再试',
    'The run status changed; refresh and try again',
  ),
  'run_already_bound': ('这次任务已经开始了', 'This run has already started'),
  'invalid_run_transition': (
    '任务状态已改变，请刷新后再试',
    'The task state changed; refresh and try again',
  ),
  'invalid_context': ('请检查任务的访问权限设置', 'Check the task access settings'),
  'authorization_changed': (
    '授权已改变，请重新确认权限',
    'Authorization changed; confirm permissions again',
  ),
  'scheduler_owned_elsewhere': (
    '定时任务正在另一处运行',
    'Schedules are running elsewhere',
  ),
  'client_runtime_forbidden': (
    '当前设备不能执行此任务',
    'This device cannot execute this task',
  ),
  'task_check_unavailable': (
    '暂时无法验证任务结果，请稍后重试',
    'Cannot verify the result right now; try again later',
  ),
  'correction_limit': (
    '自动修正次数已用完，请决定是否继续',
    'Automatic corrections are used up; decide whether to continue',
  ),
  'task_effect_unknown': (
    '操作结果待确认，请核对后继续',
    'Check the action result before continuing',
  ),
  'uncertain_recovery': (
    '恢复结果待确认，请核对已有操作',
    'Check existing actions before resuming',
  ),
  'task_delivery_uncertain': (
    '上次交付状态待确认',
    'The previous delivery needs confirmation',
  ),
  'delivery_interrupted': (
    '交付已中断，请决定是否继续',
    'Delivery was interrupted; decide whether to continue',
  ),
  'task_executor_unavailable': (
    '执行器暂不可用',
    'The executor is temporarily unavailable',
  ),
  'task_runtime_unavailable': (
    '任务执行服务暂不可用',
    'The task service is temporarily unavailable',
  ),
  'task_runtime_recovery_unavailable': (
    '任务执行服务尚未恢复',
    'The task service has not recovered yet',
  ),
  'task_session_recovery_unavailable': (
    '执行器会话尚未恢复',
    'The executor session has not recovered yet',
  ),
  'task_work_recovery_unavailable': (
    '执行状态尚未恢复',
    'The execution state has not recovered yet',
  ),
  'task_recovery_blocked': ('任务恢复待处理', 'Task recovery needs attention'),
  'task_execution_rejected': (
    '本次执行未获接收，请核对任务状态',
    'Execution was not accepted; check the task status',
  ),
  'task_execution_unconfirmed': (
    '执行是否开始仍待确认',
    'Whether execution started is still unconfirmed',
  ),
  'task_initial_pending': ('正在确认任务启动', 'Confirming task startup'),
  'executor_admission_pending': (
    '正在等待执行器接收',
    'Waiting for the executor to accept the task',
  ),
  'execution_route_required': ('请选择任务的执行方式', 'Choose how to execute the task'),
  'user_reconciled': (
    '已核对执行结果，可以继续任务',
    'The result has been checked; the task can continue',
  ),
};
