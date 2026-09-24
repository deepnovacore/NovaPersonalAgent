import {renderLife,renderProfile} from './life-view.mjs'
import {renderNews} from './news-view.mjs'
import {PersonalController} from './personal-controller.mjs'
import {mountRail,RAIL_ITEMS} from './workbench-rail.mjs'
import {mountChatPane} from './chat-pane.mjs'
import {renderMemorySection} from './memory-page.mjs'
import {renderTasksPage,activeTaskCount} from './tasks-page.mjs'
import {renderSourceSuggestions} from './workbench-suggestions.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node}
const PAGE_TITLE=Object.fromEntries(RAIL_ITEMS.map(item=>[item.id,`${item.label} · ${item.title}`]))
/** The workbench: icon rail, personal-object pages in the middle, Nova as a collapsible pane on the right. */
export function mountPersonalView({send,start,stop,tasks,taskAction,results,openResults,api,applyPresentation}) {
 const lifeLocal={},newsLocal={},preferencesLocal={}
 let unreadProjection=null
 const root=el('main',undefined,'workbench personal-workspace');root.id='personal-workspace';document.body.prepend(root)
 const run=async(action)=>{try{c.error='';await action()}catch(e){c.error=e.message;if(c.presentationMode==='background')void api.personal.showPresentationError?.(e.message);if(/conflict|version/i.test(e.message)&&c.connected)await c.command('state').catch(()=>{})}update()}
 const button=(label,action,parent)=>{const b=el('button',label);b.type='button';b.addEventListener('click',()=>run(action));parent.append(b);return b}
 const chips=(parent,values)=>{const row=el('div',undefined,'chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 const c=new PersonalController({send,start,stop,applyPresentation,changed:update})
 const openSettings=category=>api.orbMenu.openSettings?.(category)
 // Rail
 let selected='todos'
 const rail=mountRail(root,{onSelect:id=>{selected=id;renderPanel()},footer:[
  {label:'收起',title:'收起为悬浮球',icon:'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',onClick:()=>run(()=>collapse(true))},
  {label:'设置',title:'打开设置',icon:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',onClick:()=>openSettings()},
 ]})
 // Workspace
 const workspace=el('section',undefined,'workspace');workspace.setAttribute('aria-label','工作区');root.append(workspace)
 const pageHead=el('header',undefined,'page-head');const pageTitle=el('h2','','page-title');const status=el('span','正在连接','workbench-status');status.setAttribute('role','status')
 const chatToggle=el('button','收起对话栏','chat-toggle');chatToggle.type='button';chatToggle.setAttribute('aria-controls','chat-pane');chatToggle.addEventListener('click',()=>chat.setOpen(!chat.open))
 const presentation=el('select');presentation.setAttribute('aria-label','显示模式');for(const [value,label]of [['workbench','工作台'],['orb','悬浮球'],['background','后台']]){const option=el('option',label);option.value=value;presentation.append(option)}presentation.addEventListener('change',()=>run(()=>c.setPresentation(presentation.value)))
 pageHead.append(pageTitle,status,presentation,chatToggle);workspace.append(pageHead)
 const error=el('p','','page-error');error.setAttribute('role','alert');error.hidden=true;workspace.append(error)
 const waiting=el('div',undefined,'presentation-waiting');workspace.append(waiting)
 const panel=el('div',undefined,'workbench-page');workspace.append(panel)
 // Chat pane
 const chat=mountChatPane(root,{c,el,button,run,api,chips,onOpenChange:value=>{root.dataset.chatOpen=String(value);chatToggle.textContent=value?'收起对话栏':'展开对话栏';chatToggle.setAttribute('aria-expanded',String(value))}})
 chat.setOpen(true)
 const expand=el('button','展开 Nova');expand.id='personal-expand';expand.type='button';expand.addEventListener('click',()=>run(()=>collapse(false)));const orbModes=el('div',undefined,'personal-orb-modes');orbModes.append(expand);document.querySelector('#shell').append(orbModes)
 const orbVoice=button('开始语音',()=>c.mode==='voice'?c.stopVoice():c.voiceId?c.resumeVoice():c.voice(),orbModes)
 button('后台',()=>c.setPresentation('background'),orbModes)
 const orbError=el('p','','personal-orb-error');orbError.setAttribute('role','alert');document.querySelector('#shell').append(orbError)
 panel.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains?.(document.activeElement))update()},0))
 const card=(title,summary)=>{const a=el('article',undefined,'card');a.append(el('h3',title));if(summary)a.append(el('p',summary));panel.append(a);return a}
 const continueChat=text=>chat.focusDraft(`关于「${text}」：`)
 let renderedPageKey=null
 const pageKey=()=>{
  const s=c.snapshot,sourceStates=s?.sources?.map(source=>[source.id,source.state,source.health,source.processing_consent_required])
  if(['todos','ideas','goals'].includes(selected))return JSON.stringify([selected,s?.life,s?.understanding,s?.workbench_context,sourceStates,c.connected])
  if(selected==='feeds')return JSON.stringify([selected,s?.news,s?.profile_preparation,c.connected])
  if(selected==='tasks')return JSON.stringify([selected,tasks(),s?.feed,c.connected])
  return JSON.stringify([selected,s?.life,s?.memory,s?.profile_preparation,s?.news,s?.capabilities,c.connected])
 }
 function renderPanel(){
  const focused=panel.contains?.(document.activeElement)?document.activeElement:null,focusLabel=focused?.getAttribute?.('aria-label'),focusText=focused?.tagName==='BUTTON'?focused.textContent:null
  const fields=[...panel.querySelectorAll('input,textarea,select')],focusIndex=focused?fields.indexOf(focused):-1
  const edit=focusIndex>=0?{index:focusIndex,key:focused.getAttribute?.('data-editor-key'),tag:focused.tagName??focused.tag,label:focusLabel,value:focused.value,start:focused.selectionStart,end:focused.selectionEnd,scrollTop:focused.scrollTop}:null
  const panelScroll=panel.scrollTop
  panel.replaceChildren();rail.select(selected);pageTitle.textContent=PAGE_TITLE[selected]??selected
  const s=c.snapshot;const caps=s?.capabilities??{}
  const candidateKind=({todos:'todo',ideas:'idea',goals:'goal',profile:'profile'})[selected]
  const pending=el('section',undefined,'pending-group');pending.setAttribute('aria-label','待确认')
  if(s?.understanding?.error&&candidateKind)pending.append(el('p','这条发言暂时没能记下来，你仍可以手动添加。','hint'))
  if(selected==='todos')for(const item of s?.understanding?.recorded??[]){const a=el('article',undefined,'card pending');a.append(el('h3','已记下待办'),el('p',item.text));pending.append(a);const current=s.life?.todos?.find(t=>t.id===item.object_id);if(current?.version===item.version)button('撤销记录',()=>c.command('understanding.action',{id:item.id,action:'undo'}),a)}
  for(const item of s?.understanding?.items??[]){if(item.kind!==candidateKind)continue;const a=el('article',undefined,'card pending');a.append(el('h3','可能想记下'),el('p',item.text),el('p',`依据：${item.quote}`,'hint'));if(item.kind==='profile')a.append(el('p','确认后将追加到个人介绍，不会替换已有内容。','hint'));const edit=el('textarea');edit.value=lifeLocal['candidate:'+item.id]??item.text;edit.maxLength=1000;edit.setAttribute('aria-label','候选内容');edit.setAttribute('data-editor-key',`candidate:${item.id}:content`);edit.addEventListener('input',()=>{lifeLocal['candidate:'+item.id]=edit.value});a.append(edit);button('记下来',()=>c.command('understanding.action',{id:item.id,action:'accept',text:edit.value,...(item.kind==='profile'?{expected_profile_version:s.life.profile.version}:{})}),a);button('略过',()=>c.command('understanding.action',{id:item.id,action:'dismiss'}),a);pending.append(a)}
  if(['todos','ideas','goals'].includes(selected)){
   renderLife(panel,{kind:({todos:'todo',ideas:'idea',goals:'goal'})[selected],state:s?.life,openArticle:url=>api.personal.openArticle(url),command:(m,p)=>c.command(m,p),button,run,local:lifeLocal,rerender:renderPanel,delegate:text=>chat.focusDraft(text)})
   if(pending.children?.length||pending.childElementCount)panel.append(pending)
   renderSourceSuggestions(panel,{tab:selected,context:s?.workbench_context,sources:s?.sources??[],button,command:(m,p)=>c.command(m,p),continueChat,openSettings,connected:c.connected})
   if(selected==='todos')button('查看 Agent 执行任务',()=>{selected='tasks';renderPanel()},panel).className='link-button'
  }else if(selected==='feeds'){
   renderNews(panel,{news:s?.news,warmup:s?.profile_preparation,preferencesLocal,delegate:text=>chat.focusDraft(text),command:(m,p)=>c.command(m,p),button,local:newsLocal,rerender:renderPanel,profile:()=>{selected='profile';renderPanel()},openArticle:url=>api.personal.openArticle(url),openSettings,connected:c.connected})
  }else if(selected==='tasks'){
   renderTasksPage(panel,{tasks,taskAction,results,openResults,card,chips,button,askProgress:task=>{const feed=c.snapshot?.feed?.find(item=>item.task_ref?.work_id===task.work_id);if(!feed)return continueChat(`${task.title} · ${task.work_id}`);return c.openFeed(feed.id,'询问任务进展').then(result=>{chat.reveal();return result})}})
   button('任务控制与结果',openResults,panel).className='link-button'
  }else if(selected==='profile'){
   renderProfile(panel,{state:s?.life,news:s?.news,warmup:s?.profile_preparation,preferencesLocal,delegate:text=>chat.focusDraft(text),command:(m,p)=>c.command(m,p),button,local:lifeLocal,rerender:renderPanel})
   if(pending.children?.length||pending.childElementCount)panel.append(pending)
   renderMemorySection(panel,{snapshot:s,caps,el,button,chips,command:(m,p)=>c.command(m,p),continueChat,connected:c.connected,local:lifeLocal})
  }
  for(const b of panel.querySelectorAll('button'))if(!c.connected)b.disabled=true
  if(edit){const next=[...panel.querySelectorAll('input,textarea,select')],target=edit.key?next.find(node=>node.getAttribute?.('data-editor-key')===edit.key):next[edit.index];if(target&&(target.tagName??target.tag)===edit.tag&&target.getAttribute?.('aria-label')===edit.label&&!target.disabled){target.value=edit.value;if(typeof edit.start==='number'&&typeof target.setSelectionRange==='function')target.setSelectionRange(edit.start,edit.end);else{target.selectionStart=edit.start;target.selectionEnd=edit.end}target.scrollTop=edit.scrollTop;target.focus?.({preventScroll:true})}}
  else if(focusLabel||focusText){const target=[...panel.querySelectorAll('button,input,textarea,select')].find(node=>focusLabel?node.getAttribute('aria-label')===focusLabel:node.textContent===focusText);if(target&&!target.disabled)target.focus?.({preventScroll:true})}
  panel.scrollTop=panelScroll;renderedPageKey=pageKey()
 }
 function update(){
  document.body.dataset.personalCollapsed=String(c.collapsed)
  document.body.dataset.presentationMode=c.presentationMode;presentation.value=c.presentationMode;presentation.disabled=c.presentationPending
  const active=activeTaskCount(tasks());status.textContent=c.connected?`运行中 · ${active} 个后台任务`:c.everConnected?'已断开 · 草稿保留':'正在连接';status.dataset.state=c.connected?'connected':c.everConnected?'disconnected':'connecting'
  rail.badge('tasks',active)
  error.textContent=c.error;error.hidden=!c.error;orbError.textContent=c.error;orbError.hidden=!c.error
  orbVoice.textContent=c.mode==='voice'?'结束语音':c.voiceId?'恢复语音':'开始语音';orbVoice.disabled=!c.connected||!c.presentationReady||c.mode==='starting'
  const pending=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  waiting.replaceChildren();for(const item of pending){const b=button(`处理审批：${item.summary}`,async()=>{if(item.conversation_id&&item.conversation_id!==c.selectedId)await c.select(item.conversation_id);await c.setPresentation('orb')},waiting);b.disabled=!c.connected||c.presentationPending}
  const unreadTotal=(c.snapshot?.conversations?.items??[]).reduce((sum,item)=>sum+(item.unread_count??0),0)
  expand.textContent=`展开 Nova${c.voiceId?' · 语音中':unreadTotal?` · ${unreadTotal} 条提醒`:''}`
  chat.update()
  if(!c.connected)unreadProjection=null
  const unread=c.connected&&c.snapshot?((c.snapshot.conversations?.unread_count??0)+pending.reduce((sum,item)=>sum+1+(item.queued??0),0)):undefined
  if(Number.isSafeInteger(unread)&&unread>=0&&unreadProjection!==unread){unreadProjection=unread;void api.personal.setUnread?.(unread)}
  if(renderedPageKey!==pageKey())renderPanel()
 }
 async function collapse(value){await c.setPresentation(value?'orb':'workbench')}
 function receive(frame){chat.receive(frame);c.receive(frame);if(frame.type==='executor.tasks')renderPanel()}
 api.personal.onPresentationRequest?.(mode=>run(()=>c.setPresentation(mode)));
 api.personal.onCollapsed?.(value=>c.collapse(value));update();renderPanel();return {controller:c,receive,refresh:update}
}
