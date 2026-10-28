import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {createPortal} from 'react-dom'
import {Button,Tooltip} from '@radix-ui/themes'
import {Settings,Minimize2,X,Minus,Square,Clock3,Lightbulb,Target,Newspaper,Zap,User,ArrowLeft} from 'lucide-react'
import {t} from '../locale.mjs'
import {attentionTarget} from '../attention-target.mjs'
import {OrbDragGesture} from '../drag-gesture.mjs'
import {startupMessage} from '../startup-notice.mjs'
import {createComputerUseIndicator} from '../computer-use-indicator.mjs'
import {ChatPane,PlanPreview} from './chat'
import {WorkspacePage} from './pages'
import {TasksPage,TaskDetail,ScheduledTasksPage,ExecutorFloat} from './tasks'
import type {WorkbenchRuntime} from './personal-view'

const PAGES=[{id:'timeline',label:'时间线',Icon:Clock3},{id:'ideas',label:'想法',Icon:Lightbulb},{id:'goals',label:'目标',Icon:Target},{id:'feeds',label:'资讯',Icon:Newspaper},{id:'tasks',label:'任务',Icon:Zap},{id:'profile',label:'个人资料',Icon:User}]
function activeCount(c:any,work:any){const tasks=c.snapshot?.tasks??[],owned=new Set(tasks.flatMap((task:any)=>task.work_ids??[]));return tasks.filter((task:any)=>!task.trigger?.schedule_id?.startsWith('builtin-source-')&&['queued','running','verifying','waiting'].includes(task.phase)).length+(work?.tasks??[]).filter((task:any)=>!owned.has(task.work_id)&&['started','working'].includes(task.phase)).length}
function WindowGrip({api}:{api:any}){
 const gesture=useMemo(()=>new OrbDragGesture(),[])
 const finish=(cancelled=false)=>{const result=cancelled?gesture.cancel():gesture.finish();if(result.active)api.windowDrag?.end?.()}
 useEffect(()=>()=>finish(true),[])
 return <div className={`window-grip${api.windowDrag?.native?' native-window-drag':''}`} aria-hidden="true" onPointerDown={event=>{if(api.windowDrag?.native||event.button!==0)return;gesture.start(event.clientX,event.clientY);event.currentTarget.setPointerCapture?.(event.pointerId);api.windowDrag?.start?.()}} onPointerMove={event=>{if(api.windowDrag?.native)return;const delta=gesture.move(event.clientX,event.clientY);if(delta)api.windowDrag?.move?.(delta.dx,delta.dy)}} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onDoubleClick={()=>api.windowControls?.toggleMaximize?.()}/>
}
function BuildSwitchDialog({runtime}:{runtime:WorkbenchRuntime}){
 const dialog=useRef<HTMLDialogElement>(null)
 useEffect(()=>{if(runtime.confirmation)dialog.current?.showModal?.();else dialog.current?.close?.()},[runtime.confirmation])
 return <dialog ref={dialog} className="build-switch-dialog" onCancel={event=>{event.preventDefault();runtime.confirm(false)}}><h2>{t('Build 正在执行')}</h2><p>{t('停止并保存进度后再切换，返回时点击“继续”。')}</p><div className="build-switch-actions"><Button variant="soft" onClick={()=>runtime.confirm(false)}>{t('继续执行')}</Button><Button onClick={()=>runtime.confirm(true)}>{t('停止并切换')}</Button></div></dialog>
}
function ScrollPanel({pageKey,children,...props}:{pageKey:string;children:React.ReactNode;[key:string]:any}){
 const panel=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,number>())
 useLayoutEffect(()=>{const node=panel.current;if(!node)return;node.scrollTop=positions.current.get(pageKey)??0;return()=>{positions.current.set(pageKey,node.scrollTop)}},[pageKey])
 return <div ref={panel} className="workbench-page" {...props}>{children}</div>
}
export function Workbench({runtime}:{runtime:WorkbenchRuntime}){
 const revision=useSyncExternalStore(runtime.subscribe,runtime.snapshot,runtime.snapshot)
 const c=runtime.controller,{api,tasks,speakingLevel}=runtime.options,run=runtime.run
 const [selected,setSelected]=useState('timeline'),[taskTab,setTaskTab]=useState('tasks'),[taskId,setTaskId]=useState<string|null>(null),[approvalFocus,setApprovalFocus]=useState(false),[scheduleId,setScheduleId]=useState<string|null>(null),[previewPlan,setPreviewPlan]=useState(false),[planPending,setPlanPending]=useState(false),[maximized,setMaximized]=useState(false),[clock,setClock]=useState(0)
 const lastWorkspacePage=useRef('timeline');if(selected!=='tasks')lastWorkspacePage.current=selected
 const originFocus=useRef<HTMLElement|null>(null),taskHistories=useRef(new Map<string,any>()),viewedCursors=useRef(new Map<string,number>()),opening=useRef(0),initialHome=useRef(false),orbVoiceTried=useRef(false),lastPlan=useRef(''),tabRefs=useRef(new Map<string,HTMLButtonElement>())
 const [viewedResults,setViewedResults]=useState<Set<string>>(()=>{try{const rows=JSON.parse(localStorage.getItem('nova:viewed-task-results')??'[]');return new Set(Array.isArray(rows)?rows.filter(id=>typeof id==='string').slice(-200):[])}catch{return new Set()}})
 const openSettings=(category?:string)=>api.orbMenu?.openSettings?.(category)
 const openTask=useCallback(async(id:string,approval=false)=>{const seq=++opening.current;originFocus.current=document.activeElement as HTMLElement;if(c.presentationMode!=='workbench')await c.setPresentation('workbench');if(seq!==opening.current)return;setSelected('tasks');setPreviewPlan(false);setApprovalFocus(approval);setTaskId(id);if(!taskHistories.current.has(id))taskHistories.current.set(id,{items:new Map(),cursor:0,incomplete:false,truncated:false})},[c])
 const closeTask=()=>{opening.current++;setTaskId(null);queueMicrotask(()=>originFocus.current?.isConnected&&originFocus.current.focus({preventScroll:true}))}
 const showHome=async()=>{if(c.snapshot?.conversations?.items?.some((item:any)=>item.id==='chat:main'))await c.home();runtime.chat.current?.reveal()}
 const discuss=async(references:any[],text?:string)=>{await showHome();if(text){if(!c.submitText(text,'chat:main',references))throw Error(t('主对话暂时无法发送，原有草稿已保留，请稍后重试。'));runtime.chat.current?.reveal()}else await runtime.chat.current?.focusReference(references)}
 const startConversation=async(request:any)=>{await c.startConversationWithReference(request);runtime.chat.current?.reveal()}
 const openSchedule=(id:string)=>{setSelected('tasks');setPreviewPlan(false);setTaskId(null);setTaskTab('schedules');setScheduleId(id)}
 const openPlan=()=>{setSelected('tasks');setTaskId(null);setPreviewPlan(true);setPlanPending(false)}
 const selectPage=(id:string)=>{setSelected(id);setTaskId(null);setPreviewPlan(false);if(id==='tasks'&&planPending)openPlan()}
 const active=activeCount(c,tasks?.()),startupFailed=runtime.startupValue?.stage==='failed',pending=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
 useEffect(()=>{document.body.dataset.presentationMode=c.presentationMode;document.body.dataset.personalCollapsed=String(c.collapsed)},[c.presentationMode,c.collapsed])
 useEffect(()=>{document.body.dataset.maximized=maximized?'1':'0'},[maximized])
 useEffect(()=>{
  const unsubscribers=[api.personal?.onPresentationRequest?.((mode:string,options:any)=>void run(async()=>{await c.setPresentation(mode);if(options?.attention&&mode==='workbench'){const target=attentionTarget(c.snapshot);if(target?.taskId)await openTask(target.taskId,true);else if(target?.conversationId){if(target.conversationId!==c.selectedId)await c.select(target.conversationId);runtime.chat.current?.reveal()}}})),api.personal?.onCollapsed?.((value:boolean)=>c.collapse(value)),api.personal?.onMaximized?.(setMaximized)]
  const host=document.getElementById('personal-root'),open=(event:Event)=>void run(()=>openTask((event as CustomEvent).detail));host?.addEventListener('nova-workbench-open-task',open)
  const timer=setInterval(()=>setClock(value=>value+1),60000)
  return()=>{opening.current++;clearInterval(timer);host?.removeEventListener('nova-workbench-open-task',open);for(const stop of unsubscribers)if(typeof stop==='function')stop()}
 },[api,c,openTask])
 useEffect(()=>{if(!initialHome.current&&c.snapshot?.conversations?.items?.some((item:any)=>item.id==='chat:main')){initialHome.current=true;void run(()=>c.home())}},[revision])
 useEffect(()=>{
  if(c.presentationMode!=='orb'||!c.connected||c.mode==='voice'){orbVoiceTried.current=false;return}
  if(orbVoiceTried.current||!c.presentationReady||c.presentationPending||!c.selectedId||c.mode!=='text'||c.capturePending)return
  orbVoiceTried.current=true;void run(()=>c.voiceId?c.resumeVoice({wake:false}):c.voice({wake:false}))
 },[revision])
 const unread=c.connected&&c.snapshot?((c.snapshot.conversations?.unread_count??0)+(c.snapshot.notifications?.local===false?0:pending.reduce((sum,item)=>sum+1+(item.queued??0),0))):null
 useEffect(()=>{if(Number.isSafeInteger(unread)&&unread!>=0)void api.personal?.setUnread?.(unread)},[unread,api])
 const orbUnread=(c.snapshot?.conversations?.items??[]).reduce((sum:number,item:any)=>sum+(item.unread_count??0),0)
 useEffect(()=>{runtime.options.onUnreadChange?.(orbUnread)},[orbUnread])
 const planRef=c.selectedConversation?.mode==='plan'&&c.selectedConversation.plan?JSON.stringify([c.selectedId,c.selectedConversation.plan.id,c.selectedConversation.plan.version]):''
 useEffect(()=>{if(planRef===lastPlan.current)return;lastPlan.current=planRef;if(planRef){if(selected==='tasks'&&!taskId&&taskTab==='tasks'&&!previewPlan)openPlan();else setPlanPending(true)}else{setPreviewPlan(false);setPlanPending(false)}},[planRef])
 useEffect(()=>{try{localStorage.setItem('nova:viewed-task-results',JSON.stringify([...viewedResults].slice(-200)))}catch{}},[viewedResults])
 // Overlay projection is a DOM-free bridge; React owns its visible controls.
 const indicatorRef=useRef<any>(null)
 useEffect(()=>{let stop:(()=>void)|undefined;const bridge={...api,computerUse:{...api.computerUse,onStop:(callback:any)=>{stop=api.computerUse?.onStop?.(callback);return stop}}};const indicator=createComputerUseIndicator({c,api:bridge});indicatorRef.current=indicator;const listener=(event:Event)=>indicator.receive((event as CustomEvent).detail);const host=document.getElementById('personal-root');host?.addEventListener('nova-computer-frame',listener);indicator.update();return()=>{indicatorRef.current=null;stop?.();host?.removeEventListener('nova-computer-frame',listener);api.computerUse?.clear?.()}},[c,api])
 useEffect(()=>{indicatorRef.current?.update()},[revision])
 const status=startupFailed?t('启动失败'):c.connected?t('运行中 · {0} 个后台任务',active):c.everConnected?t('已断开 · 草稿保留'):t('正在连接')
 const stateNotice=c.snapshot?.conversations?.state_notice
 const orbTasks=(c.snapshot?.tasks??[]),activeTasks=orbTasks.filter((task:any)=>!['completed','cancelled'].includes(task.phase)),decision=pending.find((item:any)=>item.task_id),completedTasks=orbTasks.filter((task:any)=>task.phase==='completed'&&!viewedResults.has(task.id)),orbTaskId=decision?.task_id??completedTasks[0]?.id??activeTasks[0]?.id
 const orbHost=document.getElementById('personal-orb-host')
 return <><main id="personal-workspace" className="workbench personal-workspace" data-task-detail={String(Boolean(taskId))} data-clock={clock}>
  <section className="nova-column" aria-label={t('Nova · 主对话')}>
   <header className="page-head"><WindowGrip api={api}/><span className="workbench-status" role="status" data-state={startupFailed?'disconnected':c.connected?'connected':c.everConnected?'disconnected':'connecting'}>{status}</span><select aria-label={t('显示模式')} value={c.presentationMode} disabled={c.presentationPending} onChange={event=>void run(()=>c.setPresentation(event.target.value))}>{[['workbench','工作台'],['orb','悬浮球'],['background','隐藏']].map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select><Tooltip content={t('打开设置')}><button type="button" className="workspace-utility" aria-label={`${t('设置')} · ${t('打开设置')}`} onClick={()=>openSettings()}><Settings/><span className="utility-label">{t('设置')}</span></button></Tooltip><Tooltip content={t('收起为悬浮球')}><button type="button" className="workspace-utility" aria-label={`${t('收起')} · ${t('收起为悬浮球')}`} onClick={()=>void run(()=>c.setPresentation('orb'))}><Minimize2/><span className="utility-label">{t('收起')}</span></button></Tooltip></header>
   {startupMessage(runtime.startupValue)&&<p id="startup-notice" className={startupFailed?'page-error':'page-notice'} role={startupFailed?'alert':'status'}>{startupMessage(runtime.startupValue)}{startupFailed&&<Button variant="soft" onClick={()=>openSettings()}>{t('打开设置')}</Button>}</p>}
   {stateNotice&&<p className="page-notice" role="status">{t('状态文件无法读取（{0}），已从空状态启动。原文件：{1}；已保留备份：{2}。',stateNotice.code,stateNotice.original_path,stateNotice.backup_path)}</p>}
   {c.error&&<p className="page-error" role="alert">{t(c.error)}</p>}{c.taskNotice&&<p className="chat-notice" role="status" aria-live="polite">{t(c.taskNotice)}</p>}
   <ChatPane ref={runtime.chat} c={c} run={run} api={api} onHome={showHome} openTask={(id:string)=>void run(()=>openTask(id))} openSchedule={openSchedule} onPreviewPlan={openPlan} speakingLevel={speakingLevel} revision={revision}/>
  </section>
  <section className="workspace" aria-label={t('工作区')}>
   <nav className="workspace-topbar" aria-label={t('工作区')}><div className="workspace-tabs" role="tablist" aria-label={t('工作区')} aria-orientation="horizontal">{PAGES.map(({id,label,Icon})=><button key={id} ref={node=>{if(node)tabRefs.current.set(id,node);else tabRefs.current.delete(id)}} type="button" className="workspace-tab" id={`workspace-tab-${id}`} role="tab" data-page={id} aria-selected={selected===id} aria-controls="workbench-panel" tabIndex={selected===id?0:-1} title={t(label)} onClick={()=>selectPage(id)} onKeyDown={event=>{const index=PAGES.findIndex(page=>page.id===id),next=event.key==='Home'?0:event.key==='End'?PAGES.length-1:event.key==='ArrowLeft'?(index+PAGES.length-1)%PAGES.length:event.key==='ArrowRight'?(index+1)%PAGES.length:null;if(next===null)return;event.preventDefault();selectPage(PAGES[next].id);tabRefs.current.get(PAGES[next].id)?.focus()}}><Icon aria-hidden="true"/><span className="workspace-tab-label">{t(label)}</span>{id==='tasks'&&active>0&&<span className="workspace-tab-badge">{active}</span>}{id==='tasks'&&planPending&&<span className="workspace-tab-plan-badge" aria-hidden="true"/>}</button>)}</div></nav>
   {taskId&&<h2 className="page-title">{t('任务详情')}</h2>}
   <div className="presentation-waiting">{pending.map((item:any)=><Button key={item.id??item.request_id??item.summary} variant="soft" disabled={!c.connected} onClick={()=>void run(async()=>{if(item.task_id){await openTask(item.task_id,true);return}if(item.conversation_id&&item.conversation_id!==c.selectedId)await c.select(item.conversation_id);await c.setPresentation('orb')})}>{t('处理审批：{0}',item.summary)}</Button>)}</div>
   <ScrollPanel pageKey={taskId?`detail:${taskId}`:selected==='tasks'?`${selected}:${previewPlan?'plan':taskTab}`:selected} id="workbench-panel" role="tabpanel" tabIndex={0} aria-labelledby={`workspace-tab-${selected}`}>
    {taskId?<TaskDetail ref={runtime.detail} id={taskId} c={c} run={run} onClose={closeTask} history={taskHistories.current.get(taskId)} after={viewedCursors.current.get(taskId)??0} focusApproval={approvalFocus} visible={c.presentationMode==='workbench'} onViewed={(id:string,cursor:number,phase:string)=>{if(c.presentationMode!=='workbench')return;viewedCursors.current.set(id,cursor);if(phase==='completed')setViewedResults(prior=>prior.has(id)?prior:new Set([...prior,id]))}}/>:previewPlan?<section className="workbench-plan-preview" tabIndex={-1} aria-label={t('计划预览')}><header className="workbench-plan-preview-head"><h2>{t('计划预览')}</h2><Button variant="ghost" disabled={!c.connected} onClick={()=>{setPreviewPlan(false);setTaskTab('tasks')}}><ArrowLeft size={15}/>{t('返回任务列表')}</Button></header><PlanPreview c={c} run={run} api={api}/></section>:selected==='tasks'?<>
     {c.snapshot?.capabilities?.schedules&&<div className="schedule-tabs" role="tablist" aria-label={t('任务类型')}>{[['tasks','任务'],['schedules','定时任务']].map(([id,label])=><button type="button" key={id} role="tab" aria-selected={taskTab===id} onClick={()=>setTaskTab(id)}>{t(label)}</button>)}</div>}
     {c.snapshot?.capabilities?.schedules&&taskTab==='schedules'?<ScheduledTasksPage c={c} run={run} api={{...api,revealChat:()=>runtime.chat.current?.reveal()}} openTask={openTask} selectedId={scheduleId??undefined}/>:<TasksPage c={c} run={run} openTask={openTask} api={api}/>}
    </>:null}
    <div className="workspace-page-host" hidden={Boolean(taskId)||previewPlan||selected==='tasks'}><WorkspacePage page={lastWorkspacePage.current} c={c} run={run} api={api} discuss={discuss} startConversation={startConversation} openTask={openTask} openSettings={openSettings} delegate={(text:string)=>runtime.chat.current?.focusDraft(text)} continueChat={(text:string)=>runtime.chat.current?.focusDraft(`关于「${text}」：`)}/></div>
   </ScrollPanel>
  </section>
  <div className="window-controls" role="group" aria-label={t('窗口控制')}>{[{action:'close',label:'关闭窗口',title:'关闭（转入后台）',className:'window-close',Icon:X},{action:'minimize',label:'最小化',title:'最小化',className:'window-minimize',Icon:Minus},{action:'toggleMaximize',label:'最大化或还原',title:'最大化或还原',className:'window-maximize',Icon:Square}].map(({action,label,title,className,Icon})=><button key={action} type="button" className={`window-control ${className}`} aria-label={t(label)} title={t(title)} onClick={()=>api.windowControls?.[action]?.()}><Icon size={12}/></button>)}</div>
  <ExecutorFloat ref={runtime.executorFloat} frame={runtime.executorFrame} openTask={openTask} taskFor={(work:string)=>c.snapshot?.tasks?.find((task:any)=>task.id===work||task.work_ids?.includes(work))?.id??null}/>
  <BuildSwitchDialog runtime={runtime}/>
 </main>{orbHost&&createPortal(<><div className="personal-orb-extras">{orbTaskId&&<button type="button" className="personal-orb-task" disabled={!c.connected} onClick={()=>void run(()=>openTask(orbTaskId))}>{t('任务：{0} 进行中 · {1} 待处理 · {2} 新结果',activeTasks.length,Math.max(orbTasks.filter((task:any)=>task.phase==='waiting').length,decision?1:0),completedTasks.length)}</button>}{c.taskNotice&&<p role="status" aria-live="polite">{t(c.taskNotice)}</p>}</div>{c.error&&c.presentationMode==='orb'&&<p className="personal-orb-error" role="alert">{t(c.error)}</p>}</>,orbHost)}</>
}
