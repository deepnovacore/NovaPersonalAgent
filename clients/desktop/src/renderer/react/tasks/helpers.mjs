// DOM-free task and schedule policies shared by the declarative React views.
import {t,currentLanguage} from '../../locale.mjs'
export const TASK_PHASE_LABEL={queued:'已排队',running:'进行中',verifying:'验证中',waiting:'等待处理',started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
export const WAITING_LABEL={task_check_unavailable:'暂时无法验证任务结果，请稍后重试',correction_limit:'自动修正次数已用完，请决定是否继续',task_effect_unknown:'操作结果待确认，请核对后继续',uncertain_recovery:'恢复结果待确认，请核对已有操作',task_delivery_uncertain:'上次交付状态待确认',delivery_interrupted:'交付已中断，请决定是否继续',task_executor_unavailable:'执行器暂不可用',task_runtime_unavailable:'任务执行服务暂不可用',task_runtime_recovery_unavailable:'任务执行服务尚未恢复',task_session_recovery_unavailable:'执行器会话尚未恢复',task_work_recovery_unavailable:'执行状态尚未恢复',task_recovery_blocked:'任务恢复待处理',task_execution_rejected:'本次执行未获接收，请核对任务状态',task_execution_unconfirmed:'执行是否开始仍待确认',task_initial_pending:'正在确认任务启动',executor_admission_pending:'正在等待执行器接收',execution_route_required:'请选择任务的执行方式',user_reconciled:'已核对执行结果，可以继续任务'}
export const taskWaitingLabel=reason=>reason?t(Object.hasOwn(WAITING_LABEL,reason)?WAITING_LABEL[reason]:'任务需要你处理'):''
export function taskNotificationText(message){
 const match=message.id?.startsWith('notification:')&&/^需要你处理\n([a-z_]+)\n请在 Nova 中查看并处理。$/.exec(message.text??'')
 return match?taskWaitingLabel(match[1]):message.text
}
/** Who acts next on a delegated task, in one short phrase for cards. */
export const taskNextStep=task=>task.phase==='waiting'?t('需要你：{0}',taskWaitingLabel(task.waiting_reason)||t('任务需要你处理')):task.controller?.kind==='user'?t('你在控制'):['completed','cancelled'].includes(task.phase)?t('无需操作'):t('Nova 在推进')
// Built-in source maintenance keeps its recovery ledger without becoming a user task.
export const isSourceProcessingTask=task=>task.trigger?.schedule_id?.startsWith('builtin-source-')===true
const DURABLE_ACTIVE=['queued','running','verifying','waiting'],WORK_ACTIVE=['started','working'],BUILD_WAITING=['awaiting_approval','paused','outcome_unknown']
/** Counts delegated tasks plus executor work that no delegated task owns. */
export const activeTaskCount=(durable,work)=>{
 const records=durable?.tasks??[],owned=new Set(records.flatMap(task=>task.work_ids??[]))
 return records.filter(task=>!isSourceProcessingTask(task)&&DURABLE_ACTIVE.includes(task.phase)).length+(work?.tasks??[]).filter(item=>!owned.has(item.work_id)&&WORK_ACTIVE.includes(item.phase)).length
}
export const taskDraftKey = (clientId, taskId, sessionId) => `nova:task-draft:${JSON.stringify([clientId, taskId, sessionId])}`
const TASK_ERROR = {
  stale_task: '任务已在别处更新，已刷新，请重试', not_controller: '该任务正由另一客户端控制', task_terminal: '任务已结束', task_effect_unknown: '上一步执行结果待核对', task_input_reconciliation_required: '有尚未处理的回复，请稍后重试', task_recovery_in_progress: '任务正在恢复，请稍后重试', task_control_unavailable: '此客户端不能接管任务', nothing_to_reconcile: '没有需要核对的执行', todo_not_in_conflict: 'Todo 已处理', todo_not_found: 'Todo 已删除或取消', todo_changed: 'Todo 刚被修改，请重新核对后再标记', execution_in_flight: '执行仍在进行，请等待结果后再核对', session_not_found: '该会话已不可用', task_input_unavailable: '执行器暂不接受输入', task_execution_unavailable: '执行器暂不可用', request_conflict: '请求冲突，请刷新后重试', task_retired: '该任务已归档', session_active: '该会话正被另一个未完成的任务使用', unavailable: 'Nova 暂不可用，请稍后重试'
};
/** Host failures arrive as codes; show a readable sentence and never the raw code. */
export const taskErrorText = message => t(Object.hasOwn(TASK_ERROR, message) ? TASK_ERROR[message] : /^[a-z0-9_]+$/.test(message ?? '') ? '操作未完成，请刷新后重试' : message);
/** Sessions are shown by position until executors report titles; the raw id stays in the tooltip. */
const EXECUTOR_NAME = { codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', midscene: 'Midscene' };
/** Sessions by position, prefixed with their executor and marked when they are where the task continues by default. */
export const sessionLabel = (ids, id, detail) => {
  const index = (ids ?? []).indexOf(id)
  if (index < 0)
    return t('尚无会话')
  const executor = detail?.works?.find(work => work.session_id === id)?.executor
  const name = executor ? EXECUTOR_NAME[executor] ?? executor : ''
  const label = name ? t('{0} 会话 {1}', name, index + 1) : t('会话 {0}', index + 1)
  return detail?.primary_session_id === id && ids.length > 1 ? t('{0}（默认）', label) : label
}
const EVIDENCE_KIND = { 'task-work': '执行结果', 'task-delivery': 'Nova 交付', 'task-attested': '你已核对', 'task-input': '你的回复' }
export const evidenceLabel = ref => {
  const kind = String(ref).split(':')[0]
  return t(Object.hasOwn(EVIDENCE_KIND, kind) ? EVIDENCE_KIND[kind] : '依据')
};
export const artifactLabel = ref => String(ref).split(/[\\/]/).filter(Boolean).at(-1) ?? String(ref)
export function publicEventSummary(event) {
  if (event.kind === 'status')
    return taskWaitingLabel(event.text)
  if (!['verification', 'control'].includes(event.kind))
    return null
  try {
    const value = JSON.parse(event.text)
    if (event.kind === 'verification') {
      if (value.kind === 'complete' && Array.isArray(value.evidence_refs))
        return t('验收通过')
      if (value.kind === 'correct' && typeof value.instruction === 'string')
        return t('需要修正：{0}', value.instruction)
      if (value.kind === 'wait' && typeof value.reason === 'string')
        return t('等待处理：{0}', taskWaitingLabel(value.reason))
    }
    const label = {
      takeover: '已接管任务', return: '已交还 Nova', continue: '已继续任务', cancel: '任务已停止', reconcile: '已核对执行结果', input_before_handback: '交还前已发送的消息已送达执行器', goal_revised: '任务目标已更新', controller_changed: '任务控制已更新'
    }[value.operation]
    return label ? t(label) : null
  }
  catch {
    return null
  }
}
/** First line or sentence of a goal, short enough to act as a card heading. */
export function taskHeadline(goal = '') {
  const first = String(goal).trim().split(/\n|(?<=[。！？.!?])\s/, 1)[0]
  return first.length > 48 ? first.slice(0, 47) + '…' : first
}
/** Controllers decorate failures with refusal_text but keep the host code on the error. */
const errorCode=error=>error?.refusal_code??error?.message
export const scheduleError=error=>{const code=errorCode(error);return t(({stale_schedule:'规则已更新，请载入最新版本后再保存。',schedule_in_past:'请选择未来的执行时间。',invalid_params:'请检查时间、时区和任务内容。',schedule_running:'上次任务尚未结束，请先查看执行进展。',context_authorization_changed:'相关资料已变化，请重新运行后查看结果。'})[code]??code??String(error))}
const contextDefault={todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false}
export class ScheduleDraft{
 constructor(value,command){this.value=structuredClone(value??{});this.value={title:'',goal:'',acceptance:[],rule:{kind:'daily',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},context:contextDefault,...this.value};this.command=command;this.next=null;this.sequence=0;this.pending=null;this.busy=false;this.conflict=false;this.error='';this.onChange=()=>{}}
 set(key,value){if(this.pending||this.busy)return false;this.value[key]=structuredClone(value);this.error='';if(key==='rule'){this.sequence++;this.next=null}this.onChange();return true}
 async preview(){const sequence=++this.sequence,rule=structuredClone(this.value.rule);this.next=null;this.onChange();try{const result=await this.command('schedules.preview',{rule});if(sequence===this.sequence){this.next=result.next_slot;this.previewKey=JSON.stringify(rule);this.error=this.next?'':t('请选择未来的执行时间。')}}catch(error){if(sequence===this.sequence)this.error=scheduleError(error)}finally{if(sequence===this.sequence)this.onChange()}}
 async save(){
  if(this.busy)return null
  if(this.conflict)throw Error('stale_schedule')
  if(!this.pending){
   const {title,goal,acceptance,rule,context,id,revision}=this.value
   if(!title.trim()||!goal.trim()||!acceptance.length||!rule.timezone?.trim()||!rule.time||rule.kind==='weekly'&&!rule.weekdays?.length||rule.kind==='once'&&!rule.date)throw Error('invalid_params')
   if(!this.next||this.previewKey!==JSON.stringify(rule))throw Error('preview_required')
   this.pending={method:id?'schedules.update':'schedules.create',params:{input:{title:title.trim(),goal:goal.trim(),acceptance,rule,context},...(id?{id,expected_revision:revision}:{})},request_id:crypto.randomUUID()}
  }
  this.busy=true;this.error='';this.onChange()
  try{const result=await this.command(this.pending.method,this.pending.params,{request_id:this.pending.request_id});this.pending=null;return result}
  catch(error){this.error=scheduleError(error);const code=errorCode(error);if(['stale_schedule','invalid_params','schedule_in_past','context_not_authorized'].includes(code)){this.pending=null;this.conflict=code==='stale_schedule'}else{this.error=t('尚未确认保存结果，草稿已保留。重试会核对同一请求。');await this.command('schedules.list',{}).catch(()=>{})}throw error}
  finally{this.busy=false;this.onChange()}
 }
}
export function scheduleRuleLabel(rule){const days=['周一','周二','周三','周四','周五','周六','周日'];return [rule.kind==='once'?rule.date:rule.kind==='daily'?t('每天'):(rule.weekdays??[]).map(day=>t(days[day-1])).join('、'),rule.time,rule.timezone].filter(Boolean).join(' · ')}
export async function scheduleMutation(local,command,operation,params){
 local.requests??=new Map();const key=JSON.stringify([operation,params.id??params.run_id]);let pending=local.requests.get(key)
 if(!pending){pending={request_id:crypto.randomUUID(),params:structuredClone(params)};local.requests.set(key,pending)}
 try{const result=await command('schedules.'+operation,pending.params,{request_id:pending.request_id});local.requests.delete(key);return result}
 catch(error){const code=error?.refusal_code??error?.message;if(['stale_schedule','invalid_params','schedule_running','context_authorization_changed','version_conflict'].includes(code))local.requests.delete(key);throw error}
}

/** Same bounded public executor snapshot contract as the retained transport. */
export function parseExecutorTaskSnapshot(frame) {
 const text=(value,maximum)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\u0000-\u001f\u007f]/u.test(value)
 const project=value=>text(value,240)&&[...value].length<=120
 const summary=value=>text(value,180)&&!/(^|\s)\/(?:Users|home|private|tmp|var|etc)(?:\/|\b)/u.test(value)&&!/\b[A-Za-z]:[\\/]/u.test(value)
 const backends=['codex','opencode','codebuddy','pi','deepseek'],phases=['started','working','completed','cancelled','failed','refused','unknown']
 if(!frame||frame.type!=='executor.tasks'||!Number.isSafeInteger(frame.revision)||frame.revision<0||!(frame.active_project===null||project(frame.active_project))||!Array.isArray(frame.tasks)||frame.tasks.length>16||new TextEncoder().encode(JSON.stringify(frame)).length>16384)return null
 const ids=new Set()
 for(const task of frame.tasks){
  if(!task||(task.backend_id!==undefined&&!backends.includes(task.backend_id))||!project(task.project)||!project(task.title)||!phases.includes(task.phase)||!text(task.work_id,128)||!text(task.executor,128)||!summary(task.summary)||!Number.isFinite(task.ts)||task.ts<0||ids.has(task.work_id))return null
  ids.add(task.work_id)
 }
 return {revision:frame.revision,active_project:frame.active_project,tasks:frame.tasks.map(task=>({...task}))}
}
