import {t} from './locale.mjs'
export const TASK_PHASE_LABEL={queued:'已排队',running:'进行中',verifying:'验证中',waiting:'等待处理',started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
const WAITING_LABEL={task_check_unavailable:'暂时无法验证任务结果，请稍后重试',correction_limit:'自动修正次数已用完，请决定是否继续',task_effect_unknown:'操作结果待确认，请核对后继续',uncertain_recovery:'恢复结果待确认，请核对已有操作',task_delivery_uncertain:'上次交付状态待确认',delivery_interrupted:'交付已中断，请决定是否继续',task_executor_unavailable:'执行器暂不可用',task_runtime_unavailable:'任务执行服务暂不可用',task_runtime_recovery_unavailable:'任务执行服务尚未恢复',task_session_recovery_unavailable:'执行器会话尚未恢复',task_work_recovery_unavailable:'执行状态尚未恢复',task_recovery_blocked:'任务恢复待处理',task_execution_rejected:'本次执行未获接收，请核对任务状态',task_execution_unconfirmed:'执行是否开始仍待确认',task_initial_pending:'正在确认任务启动',executor_admission_pending:'正在等待执行器接收',execution_route_required:'请选择任务的执行方式'}
export const taskWaitingLabel=reason=>t(Object.hasOwn(WAITING_LABEL,reason)?WAITING_LABEL[reason]:reason??'')
export const activeTaskCount=state=>(state?.tasks??[]).filter(t=>['queued','running','verifying','waiting','started','working'].includes(t.phase)).length
/** Durable host tasks; the page only renders and forwards actions. */
export function renderTasksPage(panel,{tasks,taskAction,results,openResults,card,chips,button,askProgress,openTask}){
 const state=tasks()
 if(state?.error){const notice=card('任务列表暂时不可用',state.error);notice.classList.add('warn');notice.setAttribute('role','alert')}
 const list=state?.tasks??[];if(!list.length)card('暂无任务','开始对话后可在这里查看任务进展。')
 for(const task of list){
  const a=card(task.goal??task.title,task.waiting_reason?taskWaitingLabel(task.waiting_reason):task.summary);a.dataset.phase=task.phase;if(task.id)a.dataset.taskId=task.id
  chips(a,[task.project,TASK_PHASE_LABEL[task.phase]||task.phase,task.executor]);if(task.id){button(t('查看任务与结果'),()=>openTask(task.id),a);continue}
  const actions=document.createElement('div');actions.className='card-actions';a.append(actions)
  button('询问任务进展',()=>askProgress(task),actions)
  const active=state?.selected?.work_id===task.work_id
  const open=button(active&&state?.opening?'正在打开…':'打开项目',()=>taskAction(task.work_id,'open'),actions);open.disabled=active&&state?.opening
  if(['started','working'].includes(task.phase)){const cancel=button(active&&state?.cancelling?'正在停止…':'停止任务',()=>taskAction(task.work_id,'cancel'),actions);cancel.disabled=active&&state?.cancelling}
  if(results().length)button('查看结果',openResults,actions)
 }
}
