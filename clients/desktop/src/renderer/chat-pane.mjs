import {t} from './locale.mjs'
import {TASK_PHASE_LABEL} from './tasks-page.mjs'
import {renderMarkdown} from './markdown.mjs'
import {renderFeedCard,sendPresented} from './feed-card.mjs'

/**
 * Confirms the proactive conversation as read only when the newest message is
 * actually on screen: pane open, workbench expanded, window visible and
 * focused, list scrolled to the bottom. The tray unread count is a host-side
 * projection of the same fact, so nothing here touches it directly.
 */
export function markVisibleRead({c,document,history,readMessages,chatOpen=true}){
 if(!chatOpen||!c.connected||c.collapsed||document.visibilityState!=='visible'||!document.hasFocus()||history.scrollHeight-history.scrollTop-history.clientHeight>24)return
 const data=c.snapshot?.conversations,item=data?.items?.find(row=>row.id===c.selectedId)
 if(!item?.unread_count)return
 const message=data.messages?.filter(row=>row.conversation_id===c.selectedId).at(-1)
 if(!message?.id||readMessages.has(message.id))return
 readMessages.add(message.id)
 void c.command('conversations.read',{id:c.selectedId,through_message_id:message.id}).catch(()=>readMessages.delete(message.id))
}

export const conversationTitle=item=>item?.kind==='proactive'?'主动提醒':item?.title??'对话'

/** The right-hand Nova pane: conversation switcher, transcript, three-state composer. */
export function mountChatPane(columns,{c,el,button,run,api,chips,openTask,onOpenChange=()=>{}}){
 const pane=el('aside',undefined,'chat-pane');pane.id='chat-pane';pane.setAttribute('aria-label','Nova 对话');columns.append(pane)
 const head=el('header',undefined,'chat-head');pane.append(head)
 head.append(el('span','✦ Nova','chat-brand'))
 const switcher=el('details',undefined,'conversation-switcher');const summary=el('summary');summary.setAttribute('aria-label','切换会话');const summaryTitle=el('span','对话','switcher-title');const unreadBadge=el('span','','unread-badge');unreadBadge.hidden=true;summary.append(summaryTitle,unreadBadge);switcher.append(summary)
 const conversationList=el('nav');conversationList.setAttribute('aria-label','会话列表');switcher.append(conversationList);head.append(switcher)
 const closeButton=button('收起对话栏',()=>setOpen(false),head);closeButton.className='chat-close';closeButton.setAttribute('aria-label','收起对话栏');closeButton.setAttribute('aria-controls',pane.id)
 const targetRow=el('div',undefined,'chat-target');const targetLabel=el('span','未绑定项目会话');targetRow.append(targetLabel)
 const targetSelect=el('select');targetSelect.setAttribute('aria-label','此对话的编程目标');targetRow.append(targetSelect);pane.append(targetRow)
 let targetConversation=null,targetOptions=null,targetKey='',targetLoading=false
 const targetValue=target=>target?JSON.stringify({workspace_id:target.workspace_id,session_id:target.session_id}):''
 const loadTargets=button('选择项目会话',async()=>{
  const id=c.selectedId;if(!id)return;targetLoading=true;update()
  try{const data=await c.command('conversations.targets',{});if(c.selectedId===id){targetOptions=data.targets;targetKey=''}}finally{targetLoading=false;update()}
 },targetRow)
 targetSelect.addEventListener('change',()=>{
  const id=targetConversation,value=targetSelect.value;if(!id||id!==c.selectedId)return
  void run(async()=>{try{await c.command('conversations.target',{id,target:value?JSON.parse(value):null})}finally{targetKey='';update()}})
 })
 function renderTarget(){
  const current=c.snapshot?.conversations?.items?.find(item=>item.id===c.selectedId)?.coding_target??null
  if(targetConversation!==c.selectedId){targetConversation=c.selectedId;targetOptions=null;targetKey=''}
  targetLabel.textContent=current?`${current.project} / ${current.title} · ${current.executor}`:'未绑定项目会话'
  const bound=(c.snapshot?.tasks??[]).filter(t=>t.conversation_id===c.selectedId&&!['completed','cancelled'].includes(t.phase));if(bound.length)targetLabel.textContent+=t(' · {0} 个任务已绑定（此处选择仅用于向 Nova 提问）',bound.length)
  const key=JSON.stringify([targetConversation,current,targetOptions])
  if(key!==targetKey){
   targetKey=key;targetSelect.replaceChildren();const empty=el('option','不绑定项目会话');empty.value='';targetSelect.append(empty)
   const options=[...(targetOptions??[])];if(current&&!options.some(item=>targetValue(item)===targetValue(current)))options.unshift(current)
   for(const item of options){const option=el('option',`${item.project} / ${item.title} · ${item.executor}`);option.value=targetValue(item);targetSelect.append(option)}
   targetSelect.value=targetValue(current)
  }
  targetSelect.disabled=!c.connected||!c.presentationReady||!targetConversation||targetLoading||(!targetOptions&&!current)
  loadTargets.disabled=!c.connected||!c.presentationReady||!c.selectedId||targetLoading
 }
 const voiceLine=el('div',undefined,'chat-voice');const voiceStatus=el('span','','conversation-voice-status');voiceLine.append(voiceStatus);const resumeVoice=button('恢复语音',()=>c.resumeVoice(),voiceLine);resumeVoice.hidden=true;const endVoice=button('结束语音',()=>c.stopVoice(),voiceLine);endVoice.hidden=true;pane.append(voiceLine)
 const intro=el('div',undefined,'chat-intro');intro.append(el('h1','有什么需要帮忙？'),el('p','交办一件事、问一个问题，或从左侧的待办与资讯里「接着聊」。','hint'))
 const history=el('div',undefined,'chat-history');history.setAttribute('role','log');history.append(intro);pane.append(history)
 const taskCards=el('section',undefined,'conversation-task-cards');taskCards.setAttribute('aria-label',t('此对话的任务'));pane.append(taskCards);const cardNodes=new Map()
 const composer=el('div',undefined,'composer');const draft=el('textarea');draft.placeholder='输入消息…';draft.maxLength=4000;draft.setAttribute('aria-label','消息草稿');draft.rows=3
 draft.addEventListener('input',()=>{c.draft=draft.value;if(!draft.value.trim())c.state().source_todo=null;renderSource()})
 draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void run(()=>c.submit())}})
 const inputActions=el('div',undefined,'composer-actions');const dictate=button('按住说话',()=>{},inputActions);dictate.className='composer-dictate';dictate.setAttribute('aria-label','按住说话');dictate.title='按住说话'
 dictate.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();dictate.setPointerCapture(e.pointerId);void run(()=>c.dictate())})
 dictate.addEventListener('pointerup',()=>run(()=>c.finish()));dictate.addEventListener('pointercancel',()=>run(()=>c.text()))
 dictate.addEventListener('keydown',e=>{if([' ','Enter'].includes(e.key)&&!e.repeat){e.preventDefault();void run(()=>c.dictate())}})
 dictate.addEventListener('keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();void run(()=>c.finish())}})
 const voice=button('持续对话',()=>c.isVoiceConversation?c.stopVoice():c.voice(),inputActions);voice.className='composer-voice';const submit=button('↑',()=>c.submit(),inputActions);submit.className='composer-submit';submit.setAttribute('aria-label','发送消息')
 const sourceChip=button(t('移除关联待办'),()=>{c.state().source_todo=null;renderSource()},composer)
 function renderSource(){const source=c.state().source_todo;sourceChip.hidden=!source;sourceChip.textContent=source?t('关联待办 · {0}（移除）',c.snapshot?.life?.todos?.find(t=>t.id===source.id)?.title??source.id):''}
 const hint=el('p','','hint composer-hint');composer.append(draft,inputActions,hint);pane.append(composer)

 let open=true
 function setOpen(value){open=value;pane.hidden=!value;onOpenChange(value);if(value){renderHistory(true);deliverPresented();read()}}
 const readMessages=new Set(),presented=new Set(),liveCaptions=new Map()
 const read=()=>markVisibleRead({c,document,history,readMessages,chatOpen:open})
 history.addEventListener('scroll',read);const visible=()=>{deliverPresented();read()};document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible)

 let renderedNavigation='',renderedMessages='',renderedConversation=null
 function renderConversations(){
  const items=c.snapshot?.conversations?.items??[]
  const waiting=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  const navKey=JSON.stringify([c.connected,c.selectedId,c.voiceId,items,waiting,items.map(item=>Boolean(c.state(item.id).submission))])
  if(navKey!==renderedNavigation){
   renderedNavigation=navKey;conversationList.replaceChildren()
   for(const item of [...items].sort((a,b)=>Number(b.kind==='proactive')-Number(a.kind==='proactive'))){
    const b=button(conversationTitle(item),()=>{switcher.open=false;return c.select(item.id)},conversationList)
    b.className='conversation-item';b.setAttribute('aria-current',String(item.id===c.selectedId));b.disabled=!c.connected
    if(waiting.some(row=>row.conversation_id===item.id))b.append(el('span','待确认','conversation-badge'))
    if(item.unread_count)b.append(el('span',String(item.unread_count),'unread-badge'))
    if(item.id===c.voiceId){b.append(el('span','语音中','conversation-badge'));b.setAttribute('aria-label',`${conversationTitle(item)}，语音中`)}
    else if(c.state(item.id).submission)b.append(el('span','发送中','conversation-badge'))
   }
   const create=button('新对话',()=>{switcher.open=false;return c.create()},conversationList);create.className='conversation-item conversation-new';create.disabled=!c.connected
   if(!items.length)conversationList.append(el('p',c.connected?'正在加载会话…':'尚未连接','hint'))
  }
  const active=items.find(item=>item.id===c.selectedId)
  summaryTitle.textContent=conversationTitle(active)
  const unread=items.reduce((sum,item)=>sum+(item.unread_count??0),0)
  unreadBadge.hidden=!unread;unreadBadge.textContent=unread?String(unread):''
  const voiceConversation=items.find(item=>item.id===c.voiceId)
  voiceStatus.textContent=c.voiceId?`语音：${conversationTitle(voiceConversation)??'另一会话'}`:''
  resumeVoice.hidden=!c.voiceId||c.mode!=='text';resumeVoice.disabled=!c.connected||!c.presentationReady;
  endVoice.hidden=!c.voiceId;endVoice.disabled=!c.connected;voiceLine.hidden=!c.voiceId
 }
 const openLink=api?.personal?.openArticle?(url=>api.personal.openArticle(url)):undefined
 function renderMessage(message){
  const feedId=typeof message.id==='string'&&message.id.startsWith('feed:')?message.id.slice(5):null
  const feed=feedId?c.snapshot?.feed?.find(item=>item.id===feedId):null
  if(feed){const holder=el('article',undefined,'message assistant message-feed');holder.append(el('small','Nova','message-role'));renderFeedCard(holder,feed,{el,button,chips,command:(m,p)=>c.command(m,p),openFeed:(id,label)=>run(()=>c.openFeed(id,label)),visible:false,presented,body:text=>renderMarkdown(text,{openLink})});return holder}
  const node=el('article',undefined,`message ${message.role==='user'?'user':'assistant'}`);node.append(el('small',message.role==='user'?'你':'Nova','message-role'))
  if(message.role==='user')node.append(el('p',message.text));else node.append(renderMarkdown(message.text,{openLink}))
  const generationLabel={pending:'正在回复…',failed:'回复失败，请重新发送',interrupted:'回复已中断，请重新发送'}[message.generation_status];if(generationLabel)node.append(el('small',generationLabel,'hint'))
  return node
 }
 function renderHistory(force=false){
  const persisted=(c.snapshot?.conversations?.messages??[]).filter(message=>message.conversation_id===c.selectedId)
  const turns=new Set(persisted.map(message=>message.turn_id).filter(Boolean))
  const live=[...liveCaptions.values()].filter(frame=>frame.conversation_id===c.selectedId&&(frame.role!=='user'||frame.conversation_id===c.voiceId)&&!turns.has(frame.turn_id))
  const key=JSON.stringify([c.selectedId,persisted,live,c.snapshot?.feed])
  if(key===renderedMessages&&!force)return
  const changedConversation=renderedConversation!==c.selectedId;const nearBottom=history.scrollHeight-history.scrollTop-history.clientHeight<80
  history.replaceChildren()
  if(!persisted.length&&!live.length)history.append(intro)
  for(const message of [...persisted,...live])history.append(renderMessage(message))
  renderedMessages=key;renderedConversation=c.selectedId
  if(changedConversation||nearBottom||force)history.scrollTop=history.scrollHeight
 }
 /** Receipts follow visibility, not transcript rebuilds: expanding the workbench or reopening the pane re-checks every rendered card. */
 function deliverPresented(){
  if(!open||c.collapsed||!c.connected||document.visibilityState!=='visible'||!document.hasFocus())return
  for(const message of c.snapshot?.conversations?.messages??[]){
   if(message.conversation_id!==c.selectedId||typeof message.id!=='string'||!message.id.startsWith('feed:'))continue
   const feed=c.snapshot?.feed?.find(item=>item.id===message.id.slice(5));if(feed)sendPresented(feed,{presented,command:(m,p)=>c.command(m,p)})
  }
 }
 function update(){
  renderSource()
  const tasks=(c.snapshot?.tasks??[]).filter(t=>t.conversation_id===c.selectedId)
  for(const [id,node]of cardNodes)if(!tasks.some(t=>t.id===id)){node.remove?.();cardNodes.delete(id)}
  for(const task of tasks){let node=cardNodes.get(task.id);if(!node){node=button('',()=>openTask?.(task.id),taskCards);node.className='task-card';cardNodes.set(task.id,node)}node.title=task.goal;node.textContent=`${task.goal} · ${t(TASK_PHASE_LABEL[task.phase]??task.phase)} · ${task.controller.kind==='nova'?t('Nova 控制'):t('用户控制')}`}
  if(draft.value!==c.draft)draft.value=c.draft
  const localDictation=c.dictationConversationId===c.selectedId&&Boolean(c.dictationId)
  draft.disabled=!c.presentationReady||!c.connected||!c.selectedId||!c.inputInstance||Boolean(c.submittedRequestId)||c.isVoiceConversation||localDictation||!c.capabilities.includes('text_input')
  submit.disabled=draft.disabled
  dictate.disabled=!c.presentationReady||!c.connected||!c.selectedId||Boolean(c.voiceId)||(c.mode!=='text'&&c.dictationConversationId!==c.selectedId)||c.mode==='transcribing'||!c.capabilities.includes('dictation')
  voice.disabled=!c.presentationReady||!c.connected||!c.selectedId||(Boolean(c.voiceId)&&!c.isVoiceConversation)||(c.mode!=='text'&&!c.isVoiceConversation)
  voice.textContent=c.isVoiceConversation?'结束语音':'持续对话';voice.setAttribute('aria-pressed',String(c.isVoiceConversation))
  hint.textContent=!c.connected?'连接已断开，草稿已保留':c.submittedRequestId?'正在确认发送状态…':c.isVoiceConversation?'此会话正在语音对话，结束后可输入文字。':localDictation?(c.mode==='transcribing'?'正在识别，草稿不会自动发送':'正在录音 · 松开后生成草稿'):c.voiceId?'另一会话正在语音对话；这里可以输入文字。':!c.capabilities.includes('text_input')?'正在确认文字输入能力…':'Enter 发送 · Shift + Enter 换行'
  renderTarget();renderConversations();renderHistory();deliverPresented();read()
 }
 async function focusDraft(text,source=null){if(!c.selectedId||c.isVoiceConversation)await c.create();if(text!==undefined)c.draft=text;c.state().source_todo=source;setOpen(true);update();draft.focus()}
 function reveal(){setOpen(true);update();draft.focus()}
 function receive(frame){
  if(frame.type==='caption'&&typeof frame.text==='string'&&frame.conversation_id&&frame.turn_id&&(frame.role!=='user'||frame.conversation_id===c.voiceId)){
   const key=`${frame.conversation_id}:${frame.turn_id}`
   if(frame.text)liveCaptions.set(key,frame)
   while(liveCaptions.size>128)liveCaptions.delete(liveCaptions.keys().next().value)
  }
  if(frame.type==='personal.state')for(const message of frame.conversations?.messages??[])if(message.turn_id)liveCaptions.delete(`${message.conversation_id}:${message.turn_id}`)
 }
 return {element:pane,update,receive,focusDraft,reveal,setOpen,get open(){return open},history}
}
