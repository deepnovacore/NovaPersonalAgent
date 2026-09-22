import {t} from './locale.mjs'
import {TASK_PHASE_LABEL} from './tasks-page.mjs'
export const taskDraftKey=(clientId,taskId,sessionId)=>`nova:task-draft:${JSON.stringify([clientId,taskId,sessionId])}`
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
/** A persistent inspector. Only receipted host control opens the separate executor composer. */
export function mountTaskDetail(root,{command,onClose,onViewed=()=>{},after=0,storage=globalThis.localStorage}){
 let cursor=after,viewedCursor=after,visible=true,incomplete=false,truncated=false;const publicEvents=new Map()
 let detail=null,session='',draftState={},busy=false,disposed=false,eventKey='',approvalKey='',refreshing=null,refreshAgain=false
 const changes=el('p'),title=el('h2'),status=el('p'),summary=el('p'),recipient=el('p'),notice=el('p'),error=el('p'),activity=el('section'),artifacts=el('section'),approvals=el('section'),controls=el('div'),composer=el('div')
 root.className='task-detail';status.setAttribute('role','status');status.setAttribute('aria-live','polite');error.setAttribute('role','alert');activity.setAttribute('aria-label',t('公开活动'));approvals.setAttribute('aria-label',t('任务审批'))
 const button=(label,action,parent=controls)=>{const b=el('button',t(label));b.type='button';b.addEventListener('click',action);parent.append(b);return b}
 const back=button('返回任务卡片',()=>onClose(),root)
 const select=el('select');select.setAttribute('aria-label',t('执行器会话'));select.addEventListener('change',()=>{save();session=select.value;load();render()})
 const draft=el('textarea');draft.maxLength=16000;draft.setAttribute('aria-label',t('回复执行器'));draft.addEventListener('input',()=>{draftState.text=draft.value;draftState.control_revision=detail?.control_revision;save();render()})
 const fence=()=>({task_id:detail.id,control_revision:detail.control_revision,goal_revision:detail.goal_revision})
 const owned=()=>detail?.controller.kind==='user'&&detail.controller.client_id===detail.viewer?.client_id
 const key=()=>detail?.viewer?.client_id&&session?taskDraftKey(detail.viewer.client_id,detail.id,session):null
 function save(){const k=key();if(k)try{storage?.setItem(k,JSON.stringify(draftState))}catch{error.textContent=t('无法保存本地草稿，请保留此窗口。')}}
 function load(){draftState={};const k=key();if(k)try{draftState=JSON.parse(storage?.getItem(k)||'{}')}catch{}draft.value=draftState.text??''}
 async function refresh(){if(disposed||!detail)return;if(refreshing){refreshAgain=true;return refreshing}refreshing=(async()=>{do{refreshAgain=false;const result=await command('tasks.get',{task_id:detail.id,after:cursor,...(draftState.pending?{input_request_id:draftState.pending.request_id}:{})});if(!disposed)update(result)}while(refreshAgain&&!disposed)})();try{await refreshing}finally{refreshing=null}}
 async function act(method,params){if(busy)return;busy=true;error.textContent='';render();try{const result=await command(method,params);if(result?.id)update({...detail,...result});await refresh()}catch(e){error.textContent=e.message;await refresh().catch(()=>{})}finally{busy=false;render()}}
 const take=button('接管并回复',()=>act('tasks.control',{...fence(),action:'takeover'}))
 const handback=button('交还 Nova',()=>act('tasks.control',{...fence(),action:'return'}))
 const stop=button('停止任务',()=>act('tasks.cancel',fence()))
 const resume=button('继续任务',()=>act('tasks.continue',fence()))
 const reconcile=button('刷新发送状态',()=>refresh().catch(e=>{error.textContent=e.message}))
 const submit=button('发送给执行器',async()=>{
  if(draft.disabled||!draft.value.trim())return
  const sentSession=session,sentKey=key(),state=draftState,params={...fence(),session_id:session,text:draft.value},request_id=crypto.randomUUID()
  state.pending={request_id,params};save();busy=true;render()
  try{const receipt=await command('tasks.input',params,{request_id});if(receipt?.status==='accepted'){state.text='';delete state.pending;if(session===sentSession)draft.value=''}else error.textContent=t('发送状态待确认，草稿已保留。')}
  catch(e){error.textContent=e.message;if(e.input_status==='failed')delete state.pending}
  finally{if(sentKey)try{storage?.setItem(sentKey,JSON.stringify(state))}catch{}busy=false;render();await refresh().catch(()=>{})}
 },composer)
 composer.append(recipient,draft);root.append(title,status,changes,summary,select,notice,controls,approvals,activity,artifacts,composer,error)
 function render(){
  if(!detail)return
  const caps=detail.capabilities??{},terminal=['completed','cancelled'].includes(detail.phase)
  title.textContent=detail.goal;summary.textContent=(detail.acceptance??[]).join('\n');const statusText=`${t(TASK_PHASE_LABEL[detail.phase]??detail.phase)} · ${owned()?t('由你控制'):detail.controller.kind==='nova'?t('Nova 控制'):t('由另一客户端控制')}${detail.waiting_reason?` · ${detail.waiting_reason}`:''}${detail.todo_sync==='conflict'?t(' · Todo 已变更，未自动完成'):''}`;if(status.textContent!==statusText)status.textContent=statusText
  notice.textContent=caps.detail==='summary-only'?t('此执行器仅提供任务摘要。'):caps.input===false?t('执行器输入暂不可用，请先确认恢复状态。'):''
  recipient.textContent=t('发送至执行器会话：{0}{1}',session||t('尚无会话'),draftState.text&&draftState.control_revision!==detail.control_revision?t(' · 上一控制期间的草稿（不会自动发送）'):'')
  draft.disabled=busy||!owned()||!detail.viewer?.client_id||!session||!caps.input||terminal||Boolean(draftState.pending);submit.disabled=draft.disabled||!draft.value?.trim()
  take.hidden=owned()||terminal;take.disabled=busy||!detail.viewer?.can_takeover;handback.hidden=!owned();handback.disabled=busy
  stop.hidden=terminal;stop.disabled=busy||!owned();resume.hidden=!(detail.phase==='waiting'||(detail.phase==='completed'&&caps.todo_retry));resume.disabled=busy||(!owned()&&!caps.todo_retry)
  reconcile.hidden=!draftState.pending;select.disabled=busy||!(detail.session_ids??[]).length
 }
 function update(next){
  if(disposed||!next)return
  const oldKey=key(),prior=detail;detail=next
  if(!next.session_ids?.includes(session))session=next.session_ids?.[0]??''
  if(JSON.stringify(prior?.session_ids)!==JSON.stringify(next.session_ids)){select.replaceChildren();for(const id of next.session_ids??[]){const opt=el('option',id);opt.value=id;select.append(opt)}}select.value=session
  if(oldKey!==key())load()
  if(draftState.pending&&next.input_receipt?.request_id===draftState.pending.request_id){if(next.input_receipt.status==='accepted'){draft.value='';draftState.text='';delete draftState.pending;save()}else if(next.input_receipt.status==='failed'){delete draftState.pending;save()}}
  const events=next.events??{items:[]};incomplete||=Boolean(events.incomplete);truncated||=Boolean(events.truncated);for(const event of events.items??[])if(Number.isSafeInteger(event.seq))publicEvents.set(event.seq,event);if(Number.isSafeInteger(events.next))cursor=Math.max(cursor,events.next);changes.textContent=t('自上次查看后有 {0} 条新活动',[...publicEvents.keys()].filter(seq=>seq>viewedCursor).length);if(visible)onViewed(detail.id,cursor);const newKey=JSON.stringify([[...publicEvents.values()],incomplete,truncated,next.artifact_refs]);if(newKey!==eventKey){eventKey=newKey;activity.replaceChildren();if(incomplete)activity.append(el('p',t('部分公开活动缺失，请核对执行器与任务结果。')));if(truncated)activity.append(el('p',t('较早活动已截断；任务与发送回执仍保留。')));for(const event of publicEvents.values()){const row=el('article');row.append(el('small',`${event.sender??event.kind}${event.session_id?` · ${event.session_id}`:''}`),el('p',event.text));activity.append(row)}artifacts.replaceChildren();if(next.artifact_refs?.length)artifacts.append(el('h3',t('产物引用')));for(const ref of next.artifact_refs??[])artifacts.append(el('p',ref))}
  const approvalJSON=JSON.stringify(next.approvals);if(approvalJSON!==approvalKey){approvalKey=approvalJSON;approvals.replaceChildren();for(const approval of next.approvals??[]){const row=el('article');row.append(el('p',approval.operation_summary??t('等待审批')));if(approval.local_detail)row.append(el('pre',JSON.stringify(approval.local_detail,null,2)));for(const [decision,label]of [['accept','允许一次'],['decline','拒绝']]){if(approval.allowed_decisions&&!approval.allowed_decisions.includes(decision))continue;const b=button(label,()=>act('conversations.approve',{id:next.conversation_id,approval_id:approval.pending_approval_id,approved:decision==='accept'}),row);b.disabled=approval.pending_approval_busy}approvals.append(row)}}
  render()
 }
 const escape=e=>{if(e.key==='Escape'){e.preventDefault();onClose()}};root.addEventListener('keydown',escape)
 return {update,setVisible(value){if(visible===value)return;if(!value)viewedCursor=cursor;visible=value;if(value){onViewed(detail?.id,cursor);void refresh().catch(e=>{error.textContent=e.message})}},focus(){back.focus()},receive:frame=>{if(frame.type==='personal.state'&&detail&&visible){const latest=frame.tasks?.find(t=>t.id===detail.id);if(latest)update({...detail,...latest});void refresh().catch(e=>{error.textContent=e.message})}},dispose(){save();disposed=true;root.removeEventListener?.('keydown',escape)},focusApproval(){(approvals.querySelector?.('button')??back).focus()}}
}
