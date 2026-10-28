import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { t } from '../../locale.mjs'
import { TASK_PHASE_LABEL, taskWaitingLabel, taskDraftKey, taskErrorText, taskHeadline, sessionLabel, evidenceLabel, publicEventSummary, artifactLabel } from './helpers.mjs'

export type TaskHistory = { items: Map<number, any>; cursor: number; incomplete: boolean; truncated: boolean }
export type TaskDetailHandle = { receive(frame: any): Promise<void> | void; refresh(): Promise<void>; focus(): void; focusApproval(): void }
export type TaskDetailProps = { id: string; c: any; run?: (fn: () => any) => any; onClose: () => void; onViewed?: (id: string, cursor: number, phase: string) => void; focusApproval?: boolean; history?: TaskHistory; after?: number; storage?: Pick<Storage, 'getItem' | 'setItem'>; visible?: boolean }
const histories = new WeakMap<object, Map<string, TaskHistory>>()
function historyFor(c: any, id: string) {
  let rows = histories.get(c)
  if (!rows) { rows = new Map(); histories.set(c, rows) }
  let item = rows.get(id)
  if (!item) { item = {items:new Map(),cursor:0,incomplete:false,truncated:false}; rows.set(id, item) }
  return item
}
function localStorageOrNull() { try { return globalThis.localStorage ?? globalThis.window?.localStorage } catch { return undefined } }

/** A key gives each task an independent request lifetime, composer and session selection. */
export const TaskDetail = forwardRef<TaskDetailHandle, TaskDetailProps>(function TaskDetail(props, ref) {
  return <TaskDetailView key={props.id} {...props} ref={ref} />
})
const TaskDetailView = forwardRef<TaskDetailHandle, TaskDetailProps>(function TaskDetailView(props, ref) {
  const latest = useRef(props); latest.current = props
  const approvalFocusDone=useRef(false)
  const [, redraw] = useState(0)
  const back = useRef<HTMLButtonElement>(null), approvals = useRef<HTMLElement>(null)
  const state = useRef<any>(null)
  if (!state.current) state.current = {detail:null,session:'',draft:{},busy:false,error:'',refreshing:null,refreshAgain:false,disposed:false,more:false,history:props.history ?? historyFor(props.c,props.id),viewedCursor:props.after??0,visible:props.visible!==false,epoch:0}
  const m = state.current
  const storage = props.storage ?? localStorageOrNull()
  const emit = useCallback(() => { if (!m.disposed) redraw(n=>n+1) }, [m])
  const key = () => m.detail?.viewer?.client_id && m.session ? taskDraftKey(m.detail.viewer.client_id, props.id, m.session) : null
  function save(state=m.draft, storageKey=key()) {
    if (storageKey) try { storage?.setItem(storageKey,JSON.stringify(state)) } catch { m.error=t('无法保存本地草稿，请保留此窗口。') }
  }
  function load() {
    m.draft={}
    const k=key()
    if(k)try { const value=JSON.parse(storage?.getItem(k)||'{}'); if(value&&typeof value==='object')m.draft=value } catch {}
  }
  function viewed() { if(m.visible&&m.detail)latest.current.onViewed?.(m.detail.id,m.history.cursor,m.detail.phase) }
  function update(next:any) {
    if(m.disposed||!next||next.id!==props.id)return
    const oldKey=key();m.detail=next
    if(!next.session_ids?.includes(m.session))m.session=next.session_ids?.includes(next.primary_session_id)?next.primary_session_id:next.session_ids?.[0]??''
    if(oldKey!==key())load()
    const receipt=next.input_receipt
    if(m.draft.pending&&receipt?.request_id===m.draft.pending.request_id&&['accepted','failed'].includes(receipt.status)) {
      if(receipt.status==='accepted')m.draft.text=''
      delete m.draft.pending;save()
    }
    const events=next.events??{items:[]}, h=m.history
    m.more=(events.items??[]).length>=100;h.incomplete ||= !!events.incomplete;h.truncated ||= !!events.truncated
    for(const event of events.items??[])if(Number.isSafeInteger(event.seq))h.items.set(event.seq,event)
    if(Number.isSafeInteger(events.next))h.cursor=Math.max(h.cursor,events.next)
    viewed();emit()
  }
  async function refresh() {
    if(m.disposed)return
    if(m.refreshing){m.refreshAgain=true;return m.refreshing}
    const epoch=m.epoch
    m.refreshing=(async()=>{
      do {
        m.refreshAgain=false
        const next=await latest.current.c.command('tasks.get',{task_id:props.id,after:m.history.cursor,...(m.draft.pending?{input_request_id:m.draft.pending.request_id}:{})})
        if(epoch===m.epoch)update(next)
      }while(m.refreshAgain&&!m.disposed&&epoch===m.epoch)
    })()
    emit()
    try { await m.refreshing } finally { if(epoch===m.epoch){m.refreshing=null;emit()} }
  }
  const fail = (e:any) => { m.error=taskErrorText(e.refusal_code??e.message);emit() }
  async function act(method:string,params:any) {
    if(m.busy||latest.current.c.connected===false)return
    m.busy=true;m.error='';emit()
    try { const next=await latest.current.c.command(method,params);if(next?.id)update({...m.detail,...next});await refresh() }
    catch(e){fail(e);await refresh().catch(()=>{})}
    finally {m.busy=false;emit()}
  }
  const fence=()=>({task_id:m.detail.id,control_revision:m.detail.control_revision,goal_revision:m.detail.goal_revision})
  async function send() {
    const detail=m.detail, owned=detail?.controller?.kind==='user'&&detail.controller.client_id===detail.viewer?.client_id
    if(m.busy||m.draft.pending||!owned||!detail.capabilities?.input||!m.session||!m.draft.text?.trim()||latest.current.c.connected===false||['completed','cancelled'].includes(detail.phase))return
    const sent=m.draft, sentKey=key(),params={...fence(),session_id:m.session,text:sent.text},request_id=crypto.randomUUID()
    sent.pending={request_id,params};save();m.busy=true;m.error='';emit()
    try {
      const receipt=await latest.current.c.command('tasks.input',params,{request_id})
      if(receipt?.status==='accepted'){sent.text='';delete sent.pending}
      else m.error=t('发送状态待确认，草稿已保留。')
    }catch(e:any){m.error=taskErrorText(e.refusal_code??e.message);if(e.input_status==='failed')delete sent.pending}
    finally { save(sent,sentKey);m.busy=false;emit();await refresh().catch(()=>{}) }
  }
  useImperativeHandle(ref,()=>({
    refresh,
    receive:async frame=>{
      if(frame?.type!=='personal.state'||!m.visible||m.disposed)return
      const next=frame.tasks?.find((row:any)=>row.id===props.id)
      if(next&&m.detail)update({...m.detail,...next})
      await refresh().catch(fail)
    },
    focus:()=>back.current?.focus(),focusApproval:()=>((approvals.current?.querySelector('button:not(:disabled)') as HTMLButtonElement)??back.current)?.focus()
  }))
  useEffect(()=>{
    m.disposed=false;m.epoch++
    back.current?.focus()
    void refresh().catch(fail)
    return()=>{save();m.disposed=true;m.epoch++;m.refreshing=null}
  },[])
  useEffect(()=>{
    const visible=props.visible!==false
    if(m.visible===visible)return
    if(!visible)m.viewedCursor=m.history.cursor
    m.visible=visible
    if(visible){viewed();void refresh().catch(fail)}
  },[props.visible])
  useEffect(()=>{if(!props.focusApproval){approvalFocusDone.current=false;return}if(m.detail&&!approvalFocusDone.current){approvalFocusDone.current=true;((approvals.current?.querySelector('button:not(:disabled)') as HTMLButtonElement)??back.current)?.focus()}},[props.focusApproval,m.detail?.approvals])
  const detail=m.detail, caps=detail?.capabilities??{},terminal=['completed','cancelled'].includes(detail?.phase)
  const owned=detail?.controller?.kind==='user'&&detail.controller.client_id===detail.viewer?.client_id,decide=owned||detail?.controller?.kind==='nova'
  const disabled=m.busy||props.c.connected===false, noSession=!detail?.session_ids?.length
  const draftDisabled=disabled||!owned||!detail?.viewer?.client_id||!m.session||!caps.input||terminal||!!m.draft.pending
  function control(label:string,method:string,params:()=>any,hidden=false,otherDisabled=false,title?:string){return <button type="button" hidden={hidden} disabled={disabled||otherDisabled} title={title} onClick={()=>void act(method,params())}>{t(label)}</button>}
  return <section className="task-detail" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();props.onClose()}}}>
    <button ref={back} type="button" onClick={props.onClose}><ArrowLeft size={14} aria-hidden="true" />{t('返回任务卡片')}</button>
    {!detail&&<p role="status">{t('正在加载…')}</p>}
    {detail&&<>
      <h2 className="task-title">{taskHeadline(detail.goal)}</h2>
      <p className="task-status" role="status" aria-live="polite" aria-busy={m.busy}>{m.busy?`${t('正在处理…')} · `:''}{t(TASK_PHASE_LABEL[detail.phase]??detail.phase)} · {owned?t('由你控制'):detail.controller?.kind==='nova'?t('Nova 控制'):t('由另一客户端控制')}{detail.waiting_reason?` · ${taskWaitingLabel(detail.waiting_reason)}`:''}{detail.todo_sync==='conflict'?t(' · Todo 已变更，未自动完成'):''}</p>
      <details className="task-goal-details" hidden={taskHeadline(detail.goal)===detail.goal}><summary>{t('完整任务描述')}</summary><p className="task-goal">{detail.goal}</p></details>
      <div className="task-meta"><p className="task-changes">{t('自上次查看后有 {0} 条新活动',[...m.history.items.keys()].filter(seq=>seq>m.viewedCursor).length)}</p><select aria-label={t('执行器会话')} hidden={noSession} value={m.session} disabled={disabled||noSession} onChange={e=>{save();m.session=e.target.value;load();emit()}}>{(detail.session_ids??[]).map((id:string)=><option key={id} value={id} title={id}>{sessionLabel(detail.session_ids,id,detail)}</option>)}</select></div>
      <p className="task-notice">{noSession&&detail.execution_route==='nova'?t('此任务由 Nova 直接交付，无执行器会话。'):caps.detail==='summary-only'?t('此执行器仅提供任务摘要。'):caps.input===false?t('执行器输入暂不可用，请先确认恢复状态。'):''}</p>
      <section className="task-section task-criteria-section" hidden={!detail.acceptance?.length}><h3>{t('验收条件')}</h3><ul className="task-criteria">{(detail.acceptance??[]).map((text:string,i:number)=>{const refs=detail.criteria_evidence?.find((e:any)=>e.index===i)?.evidence_refs;return <li key={i}>{text}{!!refs?.length&&<small title={refs.join('\n')}> · {t('依据：{0}',[...new Set(refs.map(evidenceLabel))].join('、'))}</small>}</li>})}</ul></section>
      <div className="task-controls">
        {control(noSession?'接管任务':'接管并回复','tasks.control',()=>({...fence(),action:'takeover'}),owned||terminal,!detail.viewer?.can_takeover)}
        <p className="task-take-hint" hidden={owned||terminal}>{t('接管后由你直接给执行器发消息，Nova 暂停自动修正；交还后 Nova 继续推进。')}</p>
        {control('交还 Nova','tasks.control',()=>({...fence(),action:'return'}),!owned)}
        {control('停止任务','tasks.cancel',fence,terminal,!decide)}
        {control('继续任务','tasks.continue',fence,!(detail.phase==='waiting'||detail.phase==='completed'&&caps.todo_retry),!!caps.reconcile||!decide&&!caps.todo_retry)}
        {control('已核对：已执行','tasks.reconcile',()=>({...fence(),resolution:'done'}),!(detail.phase==='waiting'&&caps.reconcile),!decide,t('Nova 无法确认上一步是否已执行；请在项目中核对后选择'))}
        {control('已核对：未执行','tasks.reconcile',()=>({...fence(),resolution:'not_run'}),!(detail.phase==='waiting'&&caps.reconcile),!decide,t('Nova 无法确认上一步是否已执行；请在项目中核对后选择'))}
        {control('标记 Todo 完成','tasks.complete_todo',()=>({...fence(),todo_version:caps.todo?.version}),!(detail.phase==='completed'&&caps.todo_conflict&&caps.todo),false,caps.todo?t('将 Todo「{0}」标记为完成',caps.todo.title):undefined)}
        <button type="button" hidden={!m.draft.pending} disabled={disabled||!!m.refreshing} onClick={()=>void refresh().catch(fail)}>{t('刷新发送状态')}</button>
      </div>
      <section ref={approvals} className="task-section" aria-label={t('任务审批')}>{(detail.approvals??[]).map((approval:any,index:number)=><article key={approval.pending_approval_id??index}><p>{approval.operation_summary??t('等待审批')}</p>{approval.local_detail&&<pre>{JSON.stringify(approval.local_detail,null,2)}</pre>}{[['accept','允许一次'],['decline','拒绝']].filter(([decision])=>!approval.allowed_decisions||approval.allowed_decisions.includes(decision)).map(([decision,label])=><button key={decision} type="button" disabled={disabled||approval.pending_approval_busy} onClick={()=>void act('conversations.approve',{id:detail.conversation_id,approval_id:approval.pending_approval_id,approved:decision==='accept'})}>{t(label)}</button>)}</article>)}</section>
      <section className="task-section" aria-label={t('公开活动')}>
        {m.history.incomplete&&<p>{t('部分公开活动缺失，请核对执行器与任务结果。')}</p>}{m.history.truncated&&<p>{t('较早活动已截断；任务与发送回执仍保留。')}</p>}
        {[...m.history.items.values()].map((event:any)=>{const readable=publicEventSummary(event);return <article key={event.seq}><small>{t(({nova:'Nova','user-to-executor':'你 → 执行器',executor:'执行器',verification:'验证',control:'控制',status:'状态',tool:'工具',artifact:'产物'} as any)[event.sender??event.kind]??event.kind??'活动')}{event.session_id?` · ${sessionLabel(detail.session_ids,event.session_id,undefined)}`:''}</small><p>{readable??event.text}</p>{(readable!==null||!!event.refs?.length)&&<details><summary>{t('公开回执与依据')}</summary><pre>{[event.text,...event.refs??[]].join('\n')}</pre></details>}</article>})}
      </section>
      <div><button type="button" hidden={!m.more} disabled={!!m.refreshing||props.c.connected===false} onClick={()=>void refresh().catch(fail)}>{t('加载更多活动')}</button></div>
      <section className="task-section">{!!detail.artifact_refs?.length&&<h3>{t('产物引用')}</h3>}{(detail.artifact_refs??[]).map((value:string,i:number)=><p key={i} title={String(value)}>{artifactLabel(value)}</p>)}</section>
      <div className="task-section" hidden={noSession}><button type="button" disabled={draftDisabled||!m.draft.text?.trim()} onClick={()=>void send()}>{t('发送给执行器')}</button><p>{t('发送至执行器会话：{0}{1}',m.session?sessionLabel(detail.session_ids,m.session,detail):t('尚无会话'),m.draft.text&&m.draft.control_revision!==detail.control_revision?t(' · 上一控制期间的草稿（不会自动发送）'):'')}</p><textarea aria-label={t('回复执行器')} maxLength={16000} disabled={draftDisabled} value={m.draft.text??''} onChange={e=>{m.draft.text=e.target.value;m.draft.control_revision=detail.control_revision;save();emit()}} /></div>
    </>}
    <p role="alert">{m.error}</p>
  </section>
})
