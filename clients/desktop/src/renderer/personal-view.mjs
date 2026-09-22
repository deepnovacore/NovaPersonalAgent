import {summarizeTasks} from './task-banner.mjs'
import {t} from './locale.mjs'
import {renderLife,renderProfile} from './life-view.mjs'
import {renderNews} from './news-view.mjs'
import {PersonalController} from './personal-controller.mjs'
import {mountRail,RAIL_ITEMS} from './workbench-rail.mjs'
import {mountChatPane} from './chat-pane.mjs'
import {renderMemorySection} from './memory-page.mjs'
import {mountTaskDetail} from './task-detail.mjs'
import {renderTasksPage,activeTaskCount} from './tasks-page.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node}
const PAGE_TITLE=Object.fromEntries(RAIL_ITEMS.map(item=>[item.id,`${item.label} · ${item.title}`]))
/** The workbench: icon rail, personal-object pages in the middle, Nova as a collapsible pane on the right. */
export function mountPersonalView({send,start,stop,tasks,taskAction,results,openResults,api,applyPresentation}) {
 const lifeLocal={},newsLocal={}
 let unreadProjection=null
 const root=el('main',undefined,'workbench personal-workspace');root.id='personal-workspace';document.body.prepend(root)
 const run=async(action)=>{try{c.error='';await action()}catch(e){c.error=e.message;if(c.presentationMode==='background')void api.personal.showPresentationError?.(e.message);if(/conflict|version/i.test(e.message)&&c.connected)await c.command('state').catch(()=>{})}update()}
 const button=(label,action,parent)=>{const b=el('button',label);b.type='button';b.addEventListener('click',()=>run(action));parent.append(b);return b}
 const chips=(parent,values)=>{const row=el('div',undefined,'chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 const c=new PersonalController({send,start,stop,applyPresentation,changed:update})
 const openSettings=category=>api.orbMenu.openSettings?.(category)
 // Rail
 let selected='todos',inspector=null,inspectedId=null,returnFocus=null,openSequence=0
 const viewedCursors=new Map(),viewedResults=new Set()
 const durableTasks=()=>({tasks:c.snapshot?.tasks??[]})
 function closeTask(){openSequence++;inspector?.dispose();inspector=null;const originId=inspectedId;inspectedId=null;root.dataset.taskDetail='false';renderPanel();if(returnFocus?.isConnected!==false)returnFocus?.focus();else panel.querySelector?.(`[data-task-id="${originId}"] button`)?.focus()}
 async function openTask(id,approval=false){const sequence=++openSequence,originFocus=document.activeElement;if(c.presentationMode!=='workbench')await c.setPresentation('workbench');const next=await c.command('tasks.get',{task_id:id,after:viewedCursors.get(id)??0});if(sequence!==openSequence)return;if(inspectedId!==id){inspector?.dispose();returnFocus=originFocus;panel.replaceChildren();const holder=el('section');panel.append(holder);inspector=mountTaskDetail(holder,{command:(...args)=>c.command(...args),onClose:closeTask,after:viewedCursors.get(id)??0,onViewed:(taskId,cursor)=>{if(c.presentationMode==='workbench'&&taskId&&Number.isSafeInteger(cursor))viewedCursors.set(taskId,cursor)}});inspectedId=id}root.dataset.taskDetail='true';pageTitle.textContent=t('任务详情');inspector.setVisible(c.presentationMode==='workbench');inspector.update(next);if(c.presentationMode==='workbench'){if(next.phase==='completed')viewedResults.add(id);if(approval)inspector.focusApproval();else inspector.focus()}}
 const rail=mountRail(root,{onSelect:id=>{selected=id;closeTask()},footer:[
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
 const taskNotice=el('p');taskNotice.setAttribute('role','status');taskNotice.setAttribute('aria-live','polite');workspace.append(taskNotice)
 const waiting=el('div',undefined,'presentation-waiting');workspace.append(waiting)
 const panel=el('div',undefined,'workbench-page');workspace.append(panel)
 // Chat pane
 const chat=mountChatPane(root,{c,el,button,run,api,chips,openTask,onOpenChange:value=>{root.dataset.chatOpen=String(value);chatToggle.textContent=value?'收起对话栏':'展开对话栏';chatToggle.setAttribute('aria-expanded',String(value))}})
 chat.setOpen(true)
 const expand=el('button','展开 Nova');expand.id='personal-expand';expand.type='button';expand.addEventListener('click',()=>run(()=>collapse(false)));const orbModes=el('div',undefined,'personal-orb-modes');orbModes.append(expand);document.querySelector('#shell').append(orbModes)
 const orbVoice=button('开始语音',()=>c.mode==='voice'?c.stopVoice():c.voiceId?c.resumeVoice():c.voice(),orbModes)
 button('后台',()=>c.setPresentation('background'),orbModes)
 const orbTask=button('',()=>openTask(orbTask.dataset.taskId),orbModes);orbTask.className='personal-orb-task'
 const orbNotice=el('p');orbNotice.setAttribute('role','status');orbNotice.setAttribute('aria-live','polite');orbModes.append(orbNotice)
 const orbError=el('p','','personal-orb-error');orbError.setAttribute('role','alert');document.querySelector('#shell').append(orbError)
 panel.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains?.(document.activeElement))update()},0))
 const card=(title,summary)=>{const a=el('article',undefined,'card');a.append(el('h3',title));if(summary)a.append(el('p',summary));panel.append(a);return a}
 const continueChat=text=>chat.focusDraft(`关于「${text}」：`)
 let renderedSnapshot=null,taskRevision=-1
 function renderPanel(){
  if(inspector)return
  panel.replaceChildren();rail.select(selected);pageTitle.textContent=PAGE_TITLE[selected]??selected
  const s=c.snapshot;const caps=s?.capabilities??{}
  const candidateKind=({todos:'todo',ideas:'idea',goals:'goal',profile:'profile'})[selected]
  const pending=el('section',undefined,'pending-group');pending.setAttribute('aria-label','待确认')
  if(s?.understanding?.error&&candidateKind)pending.append(el('p','这条发言暂时没能记下来，你仍可以手动添加。','hint'))
  if(selected==='todos')for(const item of s?.understanding?.recorded??[]){const a=el('article',undefined,'card pending');a.append(el('h3','已记下待办'),el('p',item.text));pending.append(a);const current=s.life?.todos?.find(t=>t.id===item.object_id);if(current?.version===item.version)button('撤销记录',()=>c.command('understanding.action',{id:item.id,action:'undo'}),a)}
  for(const item of s?.understanding?.items??[]){if(item.kind!==candidateKind)continue;const a=el('article',undefined,'card pending');a.append(el('h3','可能想记下'),el('p',item.text),el('p',`依据：${item.quote}`,'hint'));if(item.kind==='profile')a.append(el('p','确认后将追加到个人介绍，不会替换已有内容。','hint'));const edit=el('textarea');edit.value=lifeLocal['candidate:'+item.id]??item.text;edit.maxLength=1000;edit.setAttribute('aria-label','候选内容');edit.addEventListener('input',()=>{lifeLocal['candidate:'+item.id]=edit.value});a.append(edit);button('记下来',()=>c.command('understanding.action',{id:item.id,action:'accept',text:edit.value,...(item.kind==='profile'?{expected_profile_version:s.life.profile.version}:{})}),a);button('略过',()=>c.command('understanding.action',{id:item.id,action:'dismiss'}),a);pending.append(a)}
  if(pending.children?.length||pending.childElementCount)panel.append(pending)
  if(['todos','ideas','goals'].includes(selected)){
   renderLife(panel,{kind:({todos:'todo',ideas:'idea',goals:'goal'})[selected],state:s?.life,openArticle:url=>api.personal.openArticle(url),command:(m,p)=>c.command(m,p),button,run,local:lifeLocal,rerender:renderPanel,delegate:(text,source)=>chat.focusDraft(text,source)})
   if(selected==='todos')button('查看 Agent 执行任务',()=>{selected='tasks';renderPanel()},panel).className='link-button'
  }else if(selected==='feeds'){
   renderNews(panel,{news:s?.news,command:(m,p)=>c.command(m,p),button,local:newsLocal,rerender:renderPanel,profile:()=>{selected='profile';renderPanel()},openArticle:url=>api.personal.openArticle(url),openSettings})
  }else if(selected==='tasks'){
   renderTasksPage(panel,{tasks:durableTasks,openTask,taskAction,results,openResults,card,chips,button,askProgress:task=>{const feed=c.snapshot?.feed?.find(item=>item.task_ref?.work_id===task.work_id);if(!feed)return continueChat(`${task.title} · ${task.work_id}`);return c.openFeed(feed.id,'询问任务进展').then(result=>{chat.reveal();return result})}})
   button('任务控制与结果',openResults,panel).className='link-button'
  }else if(selected==='profile'){
   renderProfile(panel,{state:s?.life,news:s?.news,command:(m,p)=>c.command(m,p),button,local:lifeLocal,rerender:renderPanel})
   renderMemorySection(panel,{snapshot:s,caps,el,button,chips,command:(m,p)=>c.command(m,p),continueChat,connected:c.connected,local:lifeLocal})
  }
  for(const b of panel.querySelectorAll('button'))if(!c.connected)b.disabled=true
 }
 function update(){
  document.body.dataset.personalCollapsed=String(c.collapsed)
  document.body.dataset.presentationMode=c.presentationMode;presentation.value=c.presentationMode;presentation.disabled=c.presentationPending
  const active=activeTaskCount(durableTasks());status.textContent=c.connected?`运行中 · ${active} 个后台任务`:'已断开 · 草稿保留';status.dataset.state=c.connected?'connected':'disconnected'
  rail.badge('tasks',active)
  inspector?.setVisible(c.presentationMode==='workbench')
  for(const node of [taskNotice,orbNotice]){const text=t(c.taskNotice);if(node.textContent!==text)node.textContent=text;node.hidden=!text}
  const aggregate=summarizeTasks(c.snapshot?.tasks??[],[...viewedResults]),decision=(c.snapshot?.pending_approvals??[]).find(item=>item.task_id);orbTask.dataset.taskId=decision?.task_id??aggregate.task_id;orbTask.hidden=!orbTask.dataset.taskId;orbTask.disabled=!c.connected;orbTask.textContent=t('任务：{0} 进行中 · {1} 待处理 · {2} 新结果',aggregate.active,Math.max(aggregate.decisions,decision?1:0),aggregate.results)
  error.textContent=c.error;error.hidden=!c.error||c.presentationMode!=='workbench';orbError.textContent=c.error;orbError.hidden=!c.error||c.presentationMode!=='orb'
  orbVoice.textContent=c.mode==='voice'?'结束语音':c.voiceId?'恢复语音':'开始语音';orbVoice.disabled=!c.connected||!c.presentationReady||c.mode==='starting'
  const pending=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  waiting.replaceChildren();for(const item of pending){const b=button(`处理审批：${item.summary}`,async()=>{if(item.task_id){await openTask(item.task_id,true);return}if(item.conversation_id&&item.conversation_id!==c.selectedId)await c.select(item.conversation_id);await c.setPresentation('orb')},waiting);b.disabled=!c.connected}
  const unreadTotal=(c.snapshot?.conversations?.items??[]).reduce((sum,item)=>sum+(item.unread_count??0),0)
  expand.textContent=`展开 Nova${c.voiceId?' · 语音中':unreadTotal?` · ${unreadTotal} 条提醒`:''}`
  chat.update()
  if(!c.connected)unreadProjection=null
  const unread=c.connected&&c.snapshot?((c.snapshot.conversations?.unread_count??0)+pending.reduce((sum,item)=>sum+1+(item.queued??0),0)):undefined
  if(Number.isSafeInteger(unread)&&unread>=0&&unreadProjection!==unread){unreadProjection=unread;void api.personal.setUnread?.(unread)}
  if((renderedSnapshot!==c.snapshot||taskRevision!==JSON.stringify(durableTasks()))&&!(panel.contains?.(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))){renderedSnapshot=c.snapshot;taskRevision=JSON.stringify(durableTasks());renderPanel()}
 }
 async function collapse(value){await c.setPresentation(value?'orb':'workbench')}
 function receive(frame){chat.receive(frame);c.receive(frame);inspector?.receive(frame);if(frame.type==='executor.tasks')renderPanel()}
 api.personal.onPresentationRequest?.(mode=>run(()=>c.setPresentation(mode)));
 api.personal.onCollapsed?.(value=>c.collapse(value));update();renderPanel();return {controller:c,receive,refresh:update,openTask:id=>run(()=>openTask(id))}
}
