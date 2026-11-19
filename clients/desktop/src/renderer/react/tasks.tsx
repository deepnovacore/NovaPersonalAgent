import React, { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { t } from '../locale.mjs'
import { isSourceProcessingTask, parseExecutorTaskSnapshot } from './tasks/helpers.mjs'
export { TaskDetail } from './tasks/task-detail'
export type { TaskDetailHandle, TaskDetailProps, TaskHistory } from './tasks/task-detail'
export { ScheduledTasksPage } from './tasks/scheduled-page'
export { ScheduleEditor } from './tasks/schedule-editor'
export { activeTaskCount, taskWaitingLabel, taskNextStep, taskNotificationText, taskErrorText, taskHeadline, taskDraftKey, scheduleRuleLabel, scheduleMutation, ScheduleDraft } from './tasks/helpers.mjs'

type TasksPageProps = {c:any;run?:(fn:()=>any)=>any;openTask?:(id:string)=>any;api?:any;now?:number}
export function TasksPage({c,run,openTask,now=Date.now()}:TasksPageProps) {
  const pending=useRef(new Set<string>()),live=useRef(true),[,render]=useState(0),[error,setError]=useState('')
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
  const connected=c.connected!==false
  async function act(key:string,action:()=>any){if(!connected||pending.current.has(key))return;pending.current.add(key);setError('');render(n=>n+1);try{if(run)await run(action);else await action()}catch(e:any){if(live.current)setError(e.message)}finally{pending.current.delete(key);if(live.current)render(n=>n+1)}}
  const items=(c.snapshot?.conversations?.items??[]).filter((item:any)=>item.id!=='chat:main'&&item.kind!=='schedule').sort((a:any,b:any)=>String(b.updated_at??b.created_at).localeCompare(String(a.updated_at??a.created_at)))
  const waiting=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  return <>
    <button type="button" className="page-add" disabled={!connected||pending.current.has('create')} aria-busy={pending.current.has('create')} onClick={()=>void act('create',()=>c.create())}><Plus size={14} aria-hidden="true"/>{t('创建任务')}</button>
    {[true,false].map(recent=>{const group=items.filter((item:any)=>(now-Date.parse(item.updated_at??item.created_at)<7*86400000)===recent);return group.length?<Fragment key={String(recent)}><h3>{t(recent?'近 7 天':'更早')}</h3>{group.map((item:any)=>{
      const messages=(c.snapshot?.conversations?.messages??[]).filter((message:any)=>message.conversation_id===item.id),last=messages.at(-1)
      const records=(c.snapshot?.tasks??[]).filter((task:any)=>task.conversation_id===item.id&&!isSourceProcessingTask(task))
      const generation=item.generation_status??last?.generation_status,pendingDecision=records.some((task:any)=>task.phase==='waiting')||waiting.some((row:any)=>row.conversation_id===item.id)||['awaiting_approval','paused','outcome_unknown'].includes(item.build?.status)
      const failed=item.build?.status==='failed'||generation==='failed',latest=[...records].sort((a:any,b:any)=>String(b.updated_at??b.created_at??'').localeCompare(String(a.updated_at??a.created_at??'')))[0]
      const active=records.some((task:any)=>['queued','running','verifying','waiting'].includes(task.phase))||c.state(item.id).submission||['running','idle'].includes(item.build?.status)||generation==='pending'
      const status=pendingDecision?'待你处理':failed?'失败':active?'进行中':latest?.phase==='cancelled'?'已停止':'已完成',state=({'待你处理':'waiting','失败':'failed','已停止':'cancelled','进行中':'running','已完成':'completed'} as any)[status]
      const summary=(item.last_message??last?.text??'').slice(0,160)
      return <Fragment key={item.id}><button type="button" className="conversation-task" data-state={state} data-conversation-id={item.id} aria-current={item.id===c.selectedId} aria-busy={pending.current.has(item.id)} disabled={!connected||pending.current.has(item.id)} onClick={()=>void act(item.id,()=>c.select(item.id))}><span className="conversation-task-title">{item.title??t('对话')}</span><span className="conversation-task-meta"><span className="conversation-task-status">{t(status)}</span>{!!item.unread_count&&<span className="unread-badge">{item.unread_count}</span>}{item.id===c.voiceId&&<span className="conversation-badge">{t('语音中')}</span>}{c.state(item.id).submission&&<span className="conversation-badge">{t('发送中')}</span>}</span><span className="conversation-task-summary" hidden={!summary}>{summary}</span></button>{item.id===c.selectedId&&openTask&&!!records.length&&<details open={c.state(item.id).taskRecordsOpen===true} onToggle={e=>{c.state(item.id).taskRecordsOpen=e.currentTarget.open}}><summary>{t('委托任务记录')}</summary>{records.map((task:any)=><button key={task.id} type="button" disabled={!connected||pending.current.has(`detail:${task.id}`)} onClick={()=>void act(`detail:${task.id}`,()=>openTask(task.id))}>{task.goal}</button>)}</details>}</Fragment>
    })}</Fragment>:null})}
    {!items.length&&<p className="empty-state">{t('暂无任务')}</p>}{error&&<p role="alert">{error}</p>}
  </>
}

export type ExecutorFloatHandle = {receive(frame:any):void;reset():void}
type ExecutorFloatProps = {tasks?:any[];frame?:any;openTask:(id:string)=>any;taskFor?:(work:string)=>string|null}
/** The existing executor progress pill, with React owning its expanded cards. */
export const ExecutorFloat=forwardRef<ExecutorFloatHandle,ExecutorFloatProps>(function ExecutorFloat({tasks,frame,openTask,taskFor},ref){
  const [snapshot,setSnapshot]=useState<any>({revision:-1,tasks:[]}),[expanded,setExpanded]=useState(false),revision=useRef(-1)
  function receive(frame:any){const next=parseExecutorTaskSnapshot(frame);if(!next||next.revision<revision.current)return;revision.current=next.revision;setSnapshot(next);if(!next.tasks.some((task:any)=>!['completed','cancelled'].includes(task.phase)))setExpanded(false)}
  useImperativeHandle(ref,()=>({receive,reset:()=>{revision.current=-1;setSnapshot({revision:-1,tasks:[]});setExpanded(false)}}))
  useEffect(()=>{if(frame)receive(frame)},[frame])
  const active=(tasks??snapshot.tasks).filter((task:any)=>!['completed','cancelled'].includes(task.phase)),first=active[0],labels:any={started:'已开始',working:'进行中',failed:'执行失败',refused:'未执行',unknown:'结果待确认'}
  return <aside className="executor-float" hidden={!active.length} data-expanded={String(expanded)} aria-label={t('执行器进展')} aria-live="polite">{first&&<><button type="button" className="executor-float-pill" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{active.length>1?t('{0} · {1} 个任务',first.executor,active.length):`${first.executor} · ${t(labels[first.phase]??first.phase)}`}</button>{expanded&&active.map((task:any)=>{const id=taskFor?.(task.work_id);return <article key={task.work_id} className="executor-float-task"><strong>{task.title}</strong><small>{task.executor} · {task.project} · {t(labels[task.phase]??task.phase)}</small><p className="executor-float-output">{task.summary}</p>{id&&<button type="button" onClick={()=>openTask(id)}>{t('查看详情')}</button>}</article>})}</>}</aside>
})
