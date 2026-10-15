import {TASK_PHASE_LABEL,taskNextStep} from './tasks-page.mjs'
import {renderMarkdown} from './markdown.mjs'
import {disposeSources} from './source-popover.mjs'
import {renderFeedCard,sendPresented} from './feed-card.mjs'
import {currentLanguage,t} from './locale.mjs'
import {mountExecutionCard} from './execution-card.mjs'
import {mountCodingTargetMenu} from './coding-target-menu.mjs'
import {createOrbVisualSafe} from './orb-visual.mjs'
import {ORB_STATE_NAMES} from './state.mjs'

/**
 * Confirms the proactive conversation as read only when the newest message is
 * actually on screen: pane open, workbench expanded, window visible and
 * focused, list scrolled to the bottom. The tray unread count is a host-side
 * projection of the same fact, so nothing here touches it directly.
 */
export function markVisibleRead({c,document,history,readMessages,chatOpen=true}){
 if(!chatOpen||!c.connected||c.collapsed||document.visibilityState!=='visible'||!document.hasFocus()||history.scrollHeight-history.scrollTop-history.clientHeight>24)return
 const data=c.snapshot?.conversations,messages=c.selectedId==='chat:main'?homeTranscript(data):data?.messages
 const ids=c.selectedId==='chat:main'?['chat:main','chat:proactive']:[c.selectedId]
 for(const id of ids){
 const item=data?.items?.find(row=>row.id===id)
 if(!item?.unread_count)continue
 const message=messages?.filter(row=>row.conversation_id===id&&messageVisible(history,row.id)).at(-1)
 if(!message?.id||readMessages.has(message.id))continue
 readMessages.add(message.id)
 void c.command('conversations.read',{id,through_message_id:message.id}).catch(()=>readMessages.delete(message.id))
 }
}

export function homeTranscript(conversations){
 const rows=[...(conversations?.messages??[]).filter(message=>['chat:main','chat:proactive'].includes(message.conversation_id)),...(conversations?.home_messages??[])];
 return [...new Map(rows.map(message=>[message.id,message])).values()].sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??''))
}
function messageVisible(history,id){
 if(!history.getBoundingClientRect)return true
 const node=[...history.children].find(node=>node.dataset.messageId===id)
 if(!node?.getBoundingClientRect)return false
 const box=node.getBoundingClientRect(),viewport=history.getBoundingClientRect()
 return box.bottom>viewport.top&&box.top<viewport.bottom
}

const STAGE_ORB_SIZE=96
const SVG_NS='http://www.w3.org/2000/svg'
const GLYPH={
 mic:'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
 wave:'M5 10v4M9 6v12M13 8v8M17 4v16M21 10v4',
 stop:'M7 7l10 10M17 7L7 17',
 send:'M12 19V5M5 12l7-7 7 7',
}
/** Inline SVG: the page CSP allows no image sources. */
function glyph(path){const svg=document.createElementNS(SVG_NS,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const p=document.createElementNS(SVG_NS,'path');p.setAttribute('d',path);svg.append(p);return svg}

export const conversationTitle=item=>item?.id==='chat:main'?t('主对话'):item?.kind==='proactive'?t('主动提醒'):item?.title??t('对话')

/** The persistent Nova pane: conversation switcher, transcript, three-state composer. */
export function mountChatPane(columns,{c,el,button,run,api,chips,openTask,openSchedule,onOpenChange=()=>{},onHome=()=>{},speakingLevel=null}){
 const pane=el('aside',undefined,'chat-pane');pane.id='chat-pane';pane.setAttribute('aria-label',t('Nova 对话'));columns.append(pane)
 const head=el('header',undefined,'chat-head');pane.append(head)
 const homeButton=button('✦ Nova',onHome,head);homeButton.className='chat-brand';homeButton.title=t('返回主对话')
 const switcher=el('details',undefined,'conversation-switcher');const summary=el('summary');summary.setAttribute('aria-label',t('切换会话'));const summaryTitle=el('span',t('对话'),'switcher-title');const unreadBadge=el('span','','unread-badge');unreadBadge.hidden=true;summary.append(summaryTitle,unreadBadge);switcher.append(summary)
 const conversationList=el('nav');conversationList.setAttribute('aria-label',t('会话列表'));switcher.append(conversationList);head.append(switcher)
 const voiceLine=el('div',undefined,'chat-voice');const voiceStatus=el('span','','conversation-voice-status');voiceLine.append(voiceStatus);const resumeVoice=button(t('恢复语音'),()=>c.resumeVoice(),voiceLine);resumeVoice.hidden=true;const endVoice=button(t('结束语音'),()=>c.stopVoice(),voiceLine);endVoice.hidden=true;pane.append(voiceLine)
 const intro=el('div',undefined,'chat-intro');intro.append(el('h1',t('有什么需要帮忙？')),el('p',t('你的安排、想法和新发现，都可以从这里接着聊。'),'hint'))
 const history=el('div',undefined,'chat-history');history.setAttribute('role','log');history.append(intro);pane.append(history)
 const stage=el('div',undefined,'voice-stage');stage.hidden=true
 const stageCanvas=el('canvas',undefined,'voice-stage-orb');stageCanvas.setAttribute('aria-hidden','true')
 const stageLabel=el('p','','voice-stage-label');stageLabel.setAttribute('role','status');stage.append(stageCanvas,stageLabel);pane.append(stage)
 const taskCards=el('section',undefined,'conversation-task-cards');taskCards.setAttribute('aria-label',t('此对话的任务'));pane.append(taskCards);const cardNodes=new Map()
 const executionCard=mountExecutionCard(pane,{el,command:(m,p)=>c.command(m,p),submitText:(text,id)=>c.submitText(text,id),run})
 const composer=el('div',undefined,'composer');const draft=el('textarea');draft.placeholder=t('输入消息…');draft.maxLength=4000;draft.setAttribute('aria-label',t('消息草稿'));draft.rows=3
 draft.addEventListener('input',()=>{c.draft=draft.value;if(!draft.value.trim())c.state().source_todo=null;renderSource();syncActions()})
 draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void run(()=>c.submit())}})
 const inputActions=el('div',undefined,'composer-actions');const targetMenu=mountCodingTargetMenu(inputActions,{c,el,run})
 const dictate=el('button',undefined,'composer-dictate');dictate.type='button';dictate.append(glyph(GLYPH.mic));inputActions.append(dictate)
 const recordingHere=()=>Boolean(c.dictationId)&&c.dictationConversationId===c.selectedId
 dictate.addEventListener('click',()=>run(()=>recordingHere()?c.finish():c.dictate()))
 const voice=el('button',undefined,'composer-voice');voice.type='button';voice.addEventListener('click',()=>run(()=>c.isVoiceConversation?c.stopVoice():c.voice()));inputActions.append(voice)
 const submit=el('button',undefined,'composer-submit');submit.type='button';submit.append(glyph(GLYPH.send));submit.setAttribute('aria-label',t('发送消息'));submit.title=t('发送消息');submit.addEventListener('click',()=>run(()=>c.submit()));inputActions.append(submit)
 /** The round action is the send arrow once there is a draft, otherwise continuous voice (its stop cross while voice runs). */
 let voiceGlyph=null
 function syncActions(){
  const sending=Boolean((draft.value??'').trim())&&!c.isVoiceConversation
  submit.hidden=!sending;voice.hidden=sending
  const stop=c.isVoiceConversation,label=t(stop?'结束语音':'持续对话')
  if(voiceGlyph!==stop){voiceGlyph=stop;voice.replaceChildren(glyph(stop?GLYPH.stop:GLYPH.wave))}
  voice.setAttribute('aria-label',label);voice.title=label;voice.setAttribute('aria-pressed',String(stop))
  const recording=recordingHere(),dictateLabel=t(recording?'停止录音':'语音输入')
  dictate.setAttribute('aria-label',dictateLabel);dictate.title=dictateLabel;dictate.setAttribute('aria-pressed',String(recording))
 }
 const recovery=el('details',undefined,'composer-recovery');recovery.hidden=true;composer.append(recovery)
 const referenceChips=el('div',undefined,'composer-references');composer.append(referenceChips)
 const sourceChip=button(t('移除关联待办'),()=>{c.state().source_todo=null;renderSource()},composer)
 function renderSource(){
  const source=c.state().source_todo;sourceChip.hidden=!source;sourceChip.textContent=source?t('关联待办 · {0}（移除）',c.snapshot?.life?.todos?.find(t=>t.id===source.id)?.title??source.id):''
  recovery.replaceChildren();const failed=c.state().failed_card;recovery.hidden=!failed
  if(failed){recovery.append(el('summary',t('未发送的卡片请求')),el('p',failed.text));const restore=button(t('放入空草稿'),()=>{c.draft=failed.text;c.state().references=failed.references??[];c.state().failed_card=null;update();draft.focus()},recovery);restore.disabled=Boolean(c.draft.trim()||c.submittedRequestId||c.isVoiceConversation);button(t('关闭'),()=>{c.state().failed_card=null;renderSource()},recovery)}
  referenceChips.replaceChildren()
  for(const ref of c.state().references??[]){
   const list=ref.kind==='todo'?c.snapshot?.life?.todos:ref.kind==='goal'?c.snapshot?.life?.goals:ref.kind==='feed'?c.snapshot?.feed:[...(c.snapshot?.news?.items??[]),...(c.snapshot?.news?.saved??[])]
   const title=list?.find(item=>item.id===ref.id)?.title??ref.id
   const chip=button(t('引用 · {0} ×',title),()=>{c.state().references=c.state().references.filter(item=>item!==ref);renderSource()},referenceChips);chip.className='reference-chip';chip.setAttribute('aria-label',t('移除引用：{0}',title))
  }
 }
 const hint=el('p','','hint composer-hint');composer.append(draft,inputActions,hint);pane.append(composer)

 /** The floating orb of a continuous conversation lives only while it is visible: a hidden pane must not keep an animation loop running. */
 let orb=null,orbState={name:'idle',statusLine:'',codexWorking:false}
 const media=query=>Boolean(globalThis.matchMedia?.(query)?.matches)
 function syncStage(){
  const show=open&&!c.collapsed&&c.isVoiceConversation
  stage.hidden=!show
  if(show&&!orb){orb=createOrbVisualSafe(stageCanvas,{size:STAGE_ORB_SIZE,palette:'ember',reducedMotion:media('(prefers-reduced-motion: reduce)'),highContrast:media('(prefers-contrast: more)'),...(speakingLevel?{getSpeakingLevel:speakingLevel}:{})});orb.setState(orbState.name,{codexWorking:orbState.codexWorking})}
  else if(!show&&orb){orb.destroy();orb=null}
 }
 function setOrb({name,statusLine,codexWorking}={}){
  orbState={name:ORB_STATE_NAMES.includes(name)?name:'idle',statusLine:typeof statusLine==='string'?statusLine:'',codexWorking:codexWorking===true}
  stageLabel.textContent=orbState.statusLine
  orb?.setState(orbState.name,{codexWorking:orbState.codexWorking})
 }
 const setOrbLevel=level=>orb?.setLevel(level)

 let open=true
 function setOpen(value){open=value;pane.hidden=!value;onOpenChange(value);syncStage();if(value){renderHistory(true);deliverPresented();read()}}
 const readMessages=new Set(),presented=new Set(),liveCaptions=new Map(),positions=new Map()
 const newMessages=button(t('查看新消息'),()=>{history.scrollTop=history.scrollHeight;newMessages.hidden=true;deliverPresented();read()},pane);newMessages.className='chat-new-messages';newMessages.hidden=true
 const read=()=>markVisibleRead({c,document,history,readMessages,chatOpen:open})
 history.addEventListener('scroll',()=>{if(history.scrollHeight-history.scrollTop-history.clientHeight<24)newMessages.hidden=true;deliverPresented();read()});const visible=()=>{deliverPresented();read()};document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible)

 const feedNodes=new Map()
 let renderedNavigation='',renderedMessages='',renderedConversation=null
 function renderConversations(){
  const items=c.snapshot?.conversations?.items??[]
  const waiting=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  const navKey=JSON.stringify([c.connected,c.selectedId,c.voiceId,items,waiting,items.map(item=>Boolean(c.state(item.id).submission))])
  if(navKey!==renderedNavigation){
   renderedNavigation=navKey;conversationList.replaceChildren()
   const groups=new Map(),labels=new Map()
   for(const item of items){const title=conversationTitle(item);if(!groups.has(title))groups.set(title,[]);groups.get(title).push(item);labels.set(item.id,title)}
   for(const [title,group]of groups){
    if(group.length<2)continue
    const times=group.map(item=>new Date(item.created_at).toLocaleString(currentLanguage(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}))
    for(const [index,item]of group.entries()){
     const label=t('{0} · {1}',title,times[index])
     labels.set(item.id,times.indexOf(times[index])===times.lastIndexOf(times[index])?label:t('{0} ({1})',label,index+1))
    }
   }
   for(const item of [...items].sort((a,b)=>Number(b.kind==='proactive')-Number(a.kind==='proactive'))){
    const label=labels.get(item.id),b=button(label,()=>{switcher.open=false;return c.select(item.id)},conversationList)
    b.className='conversation-item';b.setAttribute('aria-current',String(item.id===c.selectedId));b.disabled=!c.connected
    if(waiting.some(row=>row.conversation_id===item.id))b.append(el('span','待确认','conversation-badge'))
    if(item.unread_count)b.append(el('span',String(item.unread_count),'unread-badge'))
    if(item.id===c.voiceId){b.append(el('span','语音中','conversation-badge'));b.setAttribute('aria-label',t('{0}，语音中',label))}
    else if(c.state(item.id).submission)b.append(el('span','发送中','conversation-badge'))
   }
   const create=button(t('新对话'),()=>{switcher.open=false;return c.create()},conversationList);create.className='conversation-item conversation-new';create.disabled=!c.connected
   if(!items.length)conversationList.append(el('p',c.connected?'正在加载会话…':'尚未连接','hint'))
  }
  const active=items.find(item=>item.id===c.selectedId)
  summaryTitle.textContent=conversationTitle(active);pane.dataset.main=String(c.selectedId==='chat:main');homeButton.title=c.selectedId==='chat:main'?t('主对话'):t('返回主对话')
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
  if(feed){const {delivery,...content}=feed,memory=c.snapshot?.memory?.entries?.filter(entry=>feed.memory_refs?.some(ref=>ref.entry_id===entry.id)),key=JSON.stringify([message,content,memory,c.connected,Boolean(feed.expires_at&&Date.parse(feed.expires_at)<=Date.now()),Boolean(feed.snooze_until&&Date.parse(feed.snooze_until)>Date.now())]),cached=feedNodes.get(message.id);if(cached?.key===key)return cached.node;const holder=el('article',undefined,'message assistant message-feed');holder.dataset.messageId=message.id;holder.append(el('small','Nova','message-role'));renderFeedCard(holder,feed,{el,button,chips,command:(m,p)=>c.command(m,p),openFeed:(id,label)=>run(async()=>{const feed=c.snapshot?.feed?.find(item=>item.id===id);if(feed?.task_ref){const work=feed.task_ref.work_id,task=c.snapshot?.tasks?.find(task=>task.id===work||task.work_ids?.includes(work)||work.startsWith('verified:'+task.id+':'));if(!task)throw Error(t('任务记录暂不可用，请在任务页核对。'));await openTask?.(task.id);return}await onHome();await focusReference([{kind:'feed',id,updated_at:feed.updated_at}])}),visible:false,presented,memory:c.snapshot?.memory?.entries,connected:c.connected,currentItem:()=>c.snapshot?.feed?.find(item=>item.id===feed.id),body:text=>renderMarkdown(text,{openLink})});feedNodes.set(message.id,{key,node:holder});return holder}
  const node=el('article',undefined,`message ${message.role==='user'?'user':'assistant'}`);node.dataset.messageId=message.id;node.append(el('small',message.role==='user'?'你':'Nova','message-role'))
  if(message.role==='user')node.append(el('p',message.text));else node.append(renderMarkdown(message.text,{openLink}))
  if(message.schedule_ref&&openSchedule){const ref=message.schedule_ref,card=el('div',undefined,'message-schedule');card.dataset.scheduleId=ref.schedule_id;const schedule=c.snapshot?.schedules?.items?.find(item=>item.id===ref.schedule_id);card.append(el('span','◷','schedule-emblem'));button(schedule?.title??t('查看定时任务'),()=>openSchedule(ref.schedule_id),card);if(ref.task_id)button(t('查看任务'),()=>openTask(ref.task_id),card);node.append(card)}
  if(message.references?.length)node.append(el('small',t('引用 {0} 个事项',message.references.length),'message-reference'));
  const generationLabel={pending:'正在回复…',failed:'回复失败，请重新发送',interrupted:'回复已中断，请重新发送'}[message.generation_status];if(generationLabel)node.append(el('small',generationLabel,'hint'))
  return node
 }
 function renderHistory(force=false){
  const persisted=c.selectedId==='chat:main'?homeTranscript(c.snapshot?.conversations):(c.snapshot?.conversations?.messages??[]).filter(message=>message.conversation_id===c.selectedId)
  const turns=new Set(persisted.map(message=>message.turn_id).filter(Boolean))
  const live=[...liveCaptions.values()].filter(frame=>frame.conversation_id===c.selectedId&&(frame.role!=='user'||frame.conversation_id===c.voiceId)&&!turns.has(frame.turn_id))
  const key=JSON.stringify([c.selectedId,persisted,live,c.snapshot?.feed,c.snapshot?.memory,c.connected,c.snapshot?.settings?.timezone])
  if(key===renderedMessages&&!force)return
  const changedConversation=renderedConversation!==c.selectedId,previousTop=history.scrollTop;const nearBottom=history.scrollHeight-history.scrollTop-history.clientHeight<80
  if(changedConversation&&renderedConversation)positions.set(renderedConversation,{top:previousTop,bottom:nearBottom})
  const previousNodes=[...history.children],focused=history.contains(document.activeElement)?document.activeElement:null
  history.replaceChildren()
  if(c.selectedId==='chat:main'&&c.snapshot?.conversations?.home_truncated)history.append(el('p',t('部分提醒历史已收起，可从会话列表查看原对话。'),'hint'))
  if(!persisted.length&&!live.length)history.append(intro)
  let day=null
  for(const message of [...persisted,...live]){
   if(c.selectedId==='chat:main'&&message.created_at){const date=new Date(message.created_at),timezone=c.snapshot?.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,stamp=date.toLocaleDateString('en-CA',{timeZone:timezone});if(stamp!==day){day=stamp;const separator=el('div',date.toLocaleDateString(currentLanguage(),{month:'short',day:'numeric',weekday:'short',timeZone:timezone}),'message-date');separator.setAttribute('role','separator');history.append(separator)}}
   history.append(renderMessage(message))
  }
  for(const node of previousNodes)if(!history.contains(node))disposeSources(node)
  for(const [id,{node}]of feedNodes)if(!history.contains(node))feedNodes.delete(id)
  if(focused&&history.contains(focused))focused.focus()
  renderedMessages=key;renderedConversation=c.selectedId
  const position=changedConversation?positions.get(c.selectedId):null
  history.scrollTop=changedConversation?(position&&!position.bottom?position.top:history.scrollHeight):nearBottom?history.scrollHeight:previousTop
  newMessages.hidden=changedConversation||nearBottom
 }
 /** Receipts follow visibility, not transcript rebuilds: expanding the workbench or reopening the pane re-checks every rendered card. */
 function deliverPresented(){
  if(!open||c.collapsed||!c.connected||document.visibilityState!=='visible'||!document.hasFocus())return
  for(const message of c.selectedId==='chat:main'?homeTranscript(c.snapshot?.conversations):c.snapshot?.conversations?.messages??[]){
   if((c.selectedId!=='chat:main'&&message.conversation_id!==c.selectedId)||!messageVisible(history,message.id)||typeof message.id!=='string'||!message.id.startsWith('feed:'))continue
   const feed=c.snapshot?.feed?.find(item=>item.id===message.id.slice(5));if(feed)sendPresented(feed,{presented,command:(m,p)=>c.command(m,p)})
  }
 }
 function update(){
  renderSource()
  const tasks=(c.snapshot?.tasks??[]).filter(t=>c.selectedId==='chat:main'||t.conversation_id===c.selectedId)
  for(const [id,node]of cardNodes)if(!tasks.some(t=>t.id===id)){node.remove?.();cardNodes.delete(id)}
  for(const task of tasks){let node=cardNodes.get(task.id);if(!node){node=button('',()=>openTask?.(task.id),taskCards);node.className='task-card';cardNodes.set(task.id,node)}const criteria=task.acceptance??[];node.title=[task.goal,...(criteria.length?[t('验收条件'),...criteria.map(item=>'• '+item)]:[])].join('\n');node.textContent=`${task.goal.length>60?task.goal.slice(0,59)+'…':task.goal} · ${t(TASK_PHASE_LABEL[task.phase]??task.phase)} · ${taskNextStep(task)}${criteria.length?' · '+t('验收 {0} 条',criteria.length):''}`}
  if(draft.value!==c.draft)draft.value=c.draft
  const localDictation=c.dictationConversationId===c.selectedId&&Boolean(c.dictationId)
  draft.disabled=!c.presentationReady||!c.connected||!c.selectedId||!c.inputInstance||Boolean(c.submittedRequestId)||c.isVoiceConversation||localDictation||!c.capabilities.includes('text_input')
  submit.disabled=draft.disabled
  dictate.disabled=!c.presentationReady||!c.connected||!c.selectedId||Boolean(c.voiceId)||(c.mode!=='text'&&c.dictationConversationId!==c.selectedId)||c.mode==='transcribing'||!c.capabilities.includes('dictation')
  voice.disabled=!c.presentationReady||!c.connected||!c.selectedId||(Boolean(c.voiceId)&&!c.isVoiceConversation)||(c.mode!=='text'&&!c.isVoiceConversation)
  syncActions();syncStage()
  hint.textContent=t(!c.connected?(c.everConnected?'连接已断开，草稿已保留':'正在连接…'):c.submittedRequestId?'正在确认发送状态…':c.isVoiceConversation?'此会话正在语音对话，结束后可输入文字。':localDictation?(c.mode==='transcribing'?'正在识别，草稿不会自动发送':'正在录音 · 再点一下麦克风结束'):c.voiceId?'另一会话正在语音对话；这里可以输入文字。':!c.capabilities.includes('text_input')?'正在确认文字输入能力…':'Enter 发送 · Shift + Enter 换行')
  targetMenu.update();if(c.selectedId==='chat:main')targetMenu.element.hidden=true;executionCard.update((c.snapshot?.pending_confirmations??[]).find(item=>item.proposal_id&&item.workspace&&item.conversation_id===c.selectedId)??null,c.selectedId);renderConversations();renderHistory();deliverPresented();read()
 }
 async function focusDraft(text,source=null){
  if(source&&c.snapshot?.conversations?.items?.some(item=>item.id==='chat:main'))return focusReference([{kind:'todo',...source}],text)
  if(c.snapshot?.conversations?.items?.some(item=>item.id==='chat:main'))await onHome()
  else if(!c.selectedId||c.isVoiceConversation)await c.create()
  if(text!==undefined){const next=[c.draft,text].filter(Boolean).join('\n');if(next.length>4000)throw Error(t('草稿超过 4000 字符，请先缩短内容。'));c.draft=next}
  if(source)c.state().source_todo=source;setOpen(true);update();draft.focus()
 }
 async function focusReference(references,text){
  await onHome();await c.home();if(c.isVoiceConversation)throw Error(t('请先结束主对话语音，再引用事项。'))
  const state=c.state(),next=text===undefined?c.draft:[c.draft,text].filter(Boolean).join('\n')
  if(next.length>4000)throw Error(t('草稿超过 4000 字符，请先缩短内容。'))
  const merged=new Map([...state.references??[],...(state.source_todo?[{kind:'todo',...state.source_todo}]:[]),...references].map(ref=>[`${ref.kind}:${ref.id}`,ref]))
  if(merged.size>2)throw Error(t('最多引用 2 个事项，请先移除一个引用。'))
  c.draft=next;state.references=[...merged.values()];state.source_todo=null;setOpen(true);update();draft.focus()
 }
 function reveal(){setOpen(true);update();draft.focus()}
 function receive(frame){
  targetMenu.receive(frame)
  if(frame.type==='caption'&&typeof frame.text==='string'&&frame.conversation_id&&frame.turn_id&&(frame.role!=='user'||frame.conversation_id===c.voiceId)){
   const key=`${frame.conversation_id}:${frame.turn_id}`
   if(frame.text)liveCaptions.set(key,frame)
   while(liveCaptions.size>128)liveCaptions.delete(liveCaptions.keys().next().value)
  }
  if(frame.type==='personal.state')for(const message of frame.conversations?.messages??[])if(message.turn_id)liveCaptions.delete(`${message.conversation_id}:${message.turn_id}`)
 }
 return {element:pane,update,receive,focusDraft,focusReference,reveal,setOpen,setOrb,setOrbLevel,get open(){return open},history}
}
