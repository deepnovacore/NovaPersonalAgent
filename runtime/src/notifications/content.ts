import type {NotificationInput} from './contracts.js';
/** Only result prose, never prompts, work orders or arbitrary serialized tool payloads. */
export function notificationResultText(value: unknown, fallback: string): string {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fallback;
    const data = value as Record<string, unknown>;
    const result = data.result && typeof data.result === 'object' ? data.result as Record<string, unknown> : undefined;
    const final = result?.final_message;
    if (final && typeof final === 'object' && typeof (final as Record<string, unknown>).text === 'string')
        return String((final as Record<string, unknown>).text) + ((final as Record<string, unknown>).truncated === true ? '\n（来源结果已截断，请在 Nova 查看任务详情）' : '');
    for (const key of ['text', 'observation', 'summary', 'message'])
        if (typeof data[key] === 'string' && data[key].trim())
            return data[key];
    return fallback;
}

const TASK_WAITING_TEXT:Readonly<Record<string,string>>={
    task_runtime_unavailable:'任务已暂停，电脑端的任务执行服务暂不可用',
    task_runtime_recovery_unavailable:'任务已暂停，电脑端的任务执行服务尚未恢复',
    task_session_recovery_unavailable:'任务已暂停，之前的执行会话尚未恢复',
    task_session_inspection_unavailable:'任务已暂停，暂时无法检查之前的执行会话',
    task_work_recovery_unavailable:'任务已暂停，之前的执行状态尚未恢复',
    task_origin_unavailable:'任务已暂停，原来的任务对话暂不可用',
    task_executor_unavailable:'任务已暂停，执行器暂不可用',
    task_recovery_blocked:'任务已暂停，需要先核对恢复状态',
    work_fence_unavailable:'任务已暂停，无法确认之前操作的执行归属',
    uncertain_recovery:'任务已暂停，之前的执行结果尚未确认',
    task_effect_unknown:'任务已暂停，上一次操作的结果尚未确认',
    task_execution_unconfirmed:'任务已暂停，尚未确认执行是否已经开始',
    task_delivery_uncertain:'任务已暂停，上次结果是否交付仍待确认',
    delivery_interrupted:'任务结果的交付已中断',
    task_check_unavailable:'任务已暂停，暂时无法验证执行结果',
    task_execution_rejected:'本次任务执行未被接收',
    plan_delegation_refused:'任务计划未被执行器接收',
    plan_delegation_unknown:'任务计划是否被执行器接收仍待确认',
    correction_limit:'任务已暂停，自动修正次数已用完',
    task_initial_pending:'正在确认任务是否已启动',
    executor_admission_pending:'正在等待执行器接收任务',
    execution_route_required:'任务需要先选择执行方式',
    cancellation_pending:'停止请求已记录，仍需确认正在执行的操作是否结束',
    user_reconciled:'之前的执行结果已核对，可以决定是否继续任务',
};

/** Translate status codes before they become notification bodies; never resume work here. */
export function notificationTaskWaitingText(reason:string|null):string {
    if(!reason)return '任务需要你补充信息';
    if(Object.hasOwn(TASK_WAITING_TEXT,reason))return TASK_WAITING_TEXT[reason]+'。请回到电脑端查看任务详情，核对后再决定是否继续。';
    return /^[a-z][a-z0-9_]*$/u.test(reason)?'任务已暂停。请回到电脑端查看任务详情，核对后再决定是否继续。':reason;
}


/** Old task-status notices stay readable without rewriting delivery history. */
export function notificationDisplayBody(notification:Pick<NotificationInput,'source'|'body'>):string {
    if(notification.source.type!=='task_waiting')return notification.body;
    const match=/^([a-z][a-z0-9_]*)(?:\n请在 Nova 中查看并处理。)?$/u.exec(notification.body);
    return match&&Object.hasOwn(TASK_WAITING_TEXT,match[1]!)?notificationTaskWaitingText(match[1]!):notification.body;
}
