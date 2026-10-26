import {t} from './locale.mjs'
export const TASK_PHASE_LABEL={queued:'已排队',running:'进行中',verifying:'验证中',waiting:'等待处理',started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
const WAITING_LABEL={task_check_unavailable:'暂时无法验证任务结果，请稍后重试',correction_limit:'自动修正次数已用完，请决定是否继续',task_effect_unknown:'操作结果待确认，请核对后继续',uncertain_recovery:'恢复结果待确认，请核对已有操作',task_delivery_uncertain:'上次交付状态待确认',delivery_interrupted:'交付已中断，请决定是否继续',task_executor_unavailable:'执行器暂不可用',task_runtime_unavailable:'任务执行服务暂不可用',task_runtime_recovery_unavailable:'任务执行服务尚未恢复',task_session_recovery_unavailable:'执行器会话尚未恢复',task_work_recovery_unavailable:'执行状态尚未恢复',task_recovery_blocked:'任务恢复待处理',task_execution_rejected:'本次执行未获接收，请核对任务状态',task_execution_unconfirmed:'执行是否开始仍待确认',task_initial_pending:'正在确认任务启动',executor_admission_pending:'正在等待执行器接收',execution_route_required:'请选择任务的执行方式',user_reconciled:'已核对执行结果，可以继续任务'}
export const taskWaitingLabel=reason=>reason?t(Object.hasOwn(WAITING_LABEL,reason)?WAITING_LABEL[reason]:'任务需要你处理'):''
export function taskNotificationText(message){
 const match=message.id?.startsWith('notification:')&&/^需要你处理\n([a-z_]+)\n请在 Nova 中查看并处理。$/.exec(message.text??'')
 return match?taskWaitingLabel(match[1]):message.text
}
/** Who acts next on a delegated task, in one short phrase for cards. */
export const taskNextStep=task=>task.phase==='waiting'?t('需要你：{0}',taskWaitingLabel(task.waiting_reason)||t('任务需要你处理')):task.controller?.kind==='user'?t('你在控制'):['completed','cancelled'].includes(task.phase)?t('无需操作'):t('Nova 在推进')
// Built-in source maintenance keeps its recovery ledger without becoming a user task.
export const isSourceProcessingTask=task=>task.trigger?.schedule_id?.startsWith('builtin-source-')===true
const DURABLE_ACTIVE=['queued','running','verifying','waiting'],WORK_ACTIVE=['started','working']
/** Counts delegated tasks plus executor work that no delegated task owns. */
export const activeTaskCount=(durable,work)=>{
 const records=durable?.tasks??[],owned=new Set(records.flatMap(task=>task.work_ids??[]))
 return records.filter(task=>!isSourceProcessingTask(task)&&DURABLE_ACTIVE.includes(task.phase)).length+(work?.tasks??[]).filter(item=>!owned.has(item.work_id)&&WORK_ACTIVE.includes(item.phase)).length
}
/** Tasks are conversations; the host remains the sole selected/voice owner. */
export function renderConversationTasks(panel,{c,el,button,openTask,now=Date.now()}){
 const create=button(t('创建任务'),()=>c.create(),panel);create.disabled=!c.connected
 const items=(c.snapshot?.conversations?.items??[]).filter(item=>item.id!=='chat:main'&&item.kind!=='schedule').sort((a,b)=>String(b.updated_at??b.created_at).localeCompare(String(a.updated_at??a.created_at)))
 const waiting=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
 for(const [recent,label]of [[true,'近 7 天'],[false,'更早']]){
  const group=items.filter(item=>(now-Date.parse(item.updated_at??item.created_at)<7*86400000)===recent)
  if(!group.length)continue
  panel.append(el('h3',t(label)))
  for(const item of group){
   const messages=(c.snapshot?.conversations?.messages??[]).filter(message=>message.conversation_id===item.id),last=messages.at(-1)
   const records=(c.snapshot?.tasks??[]).filter(task=>task.conversation_id===item.id&&!isSourceProcessingTask(task))
   const pending=records.some(task=>task.phase==='waiting')||waiting.some(row=>row.conversation_id===item.id)||item.build?.status==='awaiting_approval'||item.build?.status==='paused'
   const status=pending?'待你处理':records.some(task=>task.phase==='failed')||item.build?.status==='failed'||(item.generation_status??last?.generation_status)==='failed'?'失败':records.some(task=>['queued','running','verifying'].includes(task.phase))||c.state(item.id).submission||['running','idle'].includes(item.build?.status)||(item.generation_status??last?.generation_status)==='pending'?'进行中':'已完成'
   const row=button(item.title??t('对话'),()=>c.select(item.id),panel);row.className='conversation-task';row.dataset.conversationId=item.id;row.setAttribute('aria-current',String(item.id===c.selectedId));row.disabled=!c.connected
   row.append(el('span',(item.last_message??last?.text??'').slice(0,160),'conversation-task-summary'),el('span',t(status),'conversation-badge'))
   if(item.unread_count)row.append(el('span',String(item.unread_count),'unread-badge'))
   if(item.id===c.voiceId)row.append(el('span',t('语音中'),'conversation-badge'))
   if(c.state(item.id).submission)row.append(el('span',t('发送中'),'conversation-badge'))
   if(item.id===c.selectedId&&openTask){if(records.length){const detail=el('details'),summary=el('summary',t('委托任务记录'));detail.append(summary);for(const task of records)button(task.goal,()=>openTask(task.id),detail);panel.append(detail)}}
  }
 }
 if(!items.length)panel.append(el('p',t('暂无任务'),'empty-state'))
}
