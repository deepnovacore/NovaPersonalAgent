import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body><div id="personal-root"></div><div id="personal-orb-host"></div></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,CustomEvent:dom.window.CustomEvent,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})
dom.window.HTMLMediaElement.prototype.pause=function(){}
const {act,fireEvent,waitFor}=await import('@testing-library/react')
const {mountPersonalView}=await import('../src/renderer/react/personal-view.tsx')
const {personalState,fixedNow}=await import('./react-fixtures/personal-state.mjs')
const views:any[]=[]
afterEach(async()=>{for(const view of views.splice(0))await act(async()=>view.dispose());document.body.innerHTML='<div id="personal-root"></div><div id="personal-orb-host"></div>';localStorage.clear()})
async function mount(extra:Record<string,any>={}){
 let view:any;const sent:any[]=[];const listeners=new Map<string,Function>();let stops=0
 const on=(name:string)=>(callback:Function)=>{listeners.set(name,callback);return()=>{stops++;listeners.delete(name)}}
 const api={personal:{onPresentationRequest:on('presentation'),onCollapsed:on('collapsed'),onMaximized:on('maximized'),setUnread:async()=>{}},orbMenu:{openSettings:()=>{}},windowControls:{},computerUse:{onStop:on('computer-stop'),overlay:()=>{},clear:()=>{}}}
 const send=(frame:any)=>{sent.push(frame);queueMicrotask(()=>{if(frame.type==='personal.command')view.receive({type:'personal.result',request_id:frame.request_id,ok:true,data:frame.method==='presentation.set'?{mode:frame.params.mode}:frame.method==='conversations.select'?{...view.controller.snapshot.conversations,selected_id:frame.params.id}:{}});if(frame.type==='input.text')view.receive({type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true})});return true}
 await act(async()=>{view=mountPersonalView({api,send,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[],...extra});views.push(view);await view.controller.connect();view.receive({type:'client.ready',input_instance_id:'ui-test',capabilities:['text_input']});view.receive(personalState())})
 return {view,sent,listeners,stops:()=>stops}
}
test('React workbench preserves left chat and right workspace while keyboard tabs move focus',async()=>{
 const {view}=await mount()
 const root=document.getElementById('personal-workspace')!,chat=root.querySelector('.nova-column')!,workspace=root.querySelector('.workspace')!
 assert.equal(chat.nextElementSibling,workspace)
 const first=root.querySelector<HTMLButtonElement>('[role="tab"][data-page="timeline"]')!
 assert.equal(first.getAttribute('aria-selected'),'true')
 await act(async()=>fireEvent.keyDown(first,{key:'ArrowRight'}))
 const ideas=root.querySelector<HTMLButtonElement>('[data-page="ideas"]')!
 assert.equal(ideas.getAttribute('aria-selected'),'true');assert.equal(document.activeElement,ideas)
 assert.equal(document.getElementById('workbench-panel')!.getAttribute('aria-labelledby'),ideas.id)
 assert.equal(view.controller.selectedId,'chat:main')
})
test('controller updates preserve focused composer text, and disconnect retains the draft',async()=>{
 const {view}=await mount(),draft=document.querySelector<HTMLTextAreaElement>('[aria-label="消息草稿"]')!
 await act(async()=>fireEvent.change(draft,{target:{value:'未发送的草稿'}}))
 draft.focus();const controller=view.controller
 await act(async()=>view.receive(personalState(2)))
 assert.equal(view.controller,controller);assert.equal(document.querySelector('[aria-label="消息草稿"]'),draft);assert.equal(draft.value,'未发送的草稿');assert.equal(document.activeElement,draft)
 await act(async()=>view.controller.disconnect())
 assert.equal(draft.value,'未发送的草稿');assert.equal(view.controller.draft,'未发送的草稿')
 assert.ok(document.querySelector('.workbench-status')!.textContent!.includes('草稿保留'))
})
test('disposing the workbench releases presentation/window/overlay subscriptions',async()=>{
 const {view,listeners,stops}=await mount();assert.equal(listeners.size,4)
 await act(async()=>view.dispose());views.splice(views.indexOf(view),1)
 assert.equal(stops(),4);assert.equal(listeners.size,0);assert.equal(document.getElementById('personal-workspace'),null)
})

test('a system notification opens main chat even when an unrelated approval is pending',async()=>{
 const {view,sent,listeners}=await mount(),state=personalState(2)
 state.pending_approvals=[{approval_id:'other-approval',conversation_id:'topic:review',task_id:'other-task',summary:'Unrelated approval'}] as any
 await act(async()=>view.receive(state))
 await act(async()=>view.controller.select('topic:review'))
 await act(async()=>{listeners.get('presentation')!('workbench',{attention:true,conversationId:'chat:main'})})
 await waitFor(()=>assert.equal(view.controller.selectedId,'chat:main'))
 assert.equal(sent.some(frame=>frame.method==='tasks.get'&&frame.params.task_id==='other-task'),false)
 assert.equal((document.getElementById('chat-pane') as HTMLElement).hidden,false)
})

test('unsaved workspace edits survive Tasks and return without changing the conversation',async()=>{
 const {view}=await mount()
 const tab=(page:string)=>document.querySelector<HTMLButtonElement>(`[role="tab"][data-page="${page}"]`)!
 await act(async()=>fireEvent.click(tab('ideas')))
 const edit=[...document.querySelectorAll<HTMLButtonElement>('#workbench-panel button')].find(button=>button.textContent==='编辑')!
 await act(async()=>fireEvent.click(edit))
 const title=document.querySelector<HTMLInputElement>('[aria-label="想法标题"]')!
 await act(async()=>fireEvent.change(title,{target:{value:'保留跨页面草稿'}}))
 await act(async()=>fireEvent.click(tab('tasks')))
 await act(async()=>fireEvent.click(tab('ideas')))
 assert.equal(document.querySelector<HTMLInputElement>('[aria-label="想法标题"]')?.value,'保留跨页面草稿')
 assert.equal(view.controller.selectedId,'chat:main')
})

test('executor progress resets revisions on reconnect and malformed frames cannot poison sequencing',async()=>{
 const {view}=await mount()
 const frame=(revision:number,title:string)=>({type:'executor.tasks',revision,active_project:'Project',tasks:[{work_id:'w',executor:'codex',project:'Project',title,phase:'working',summary:'Public progress',ts:1}]})
 await act(async()=>view.receive(frame(100,'Old executor')))
 let pill=document.querySelector<HTMLButtonElement>('.executor-float-pill')!;assert.ok(pill)
 await act(async()=>fireEvent.click(pill));assert.ok(document.querySelector('.executor-float')!.textContent!.includes('Old executor'))
 await act(async()=>view.receive({type:'client.ready',input_instance_id:'restarted',capabilities:['text_input']}))
 assert.equal((document.querySelector('.executor-float') as HTMLElement).hidden,true)
 await act(async()=>view.receive({...frame(Infinity,'Malformed'),tasks:[{bad:true}]}))
 await act(async()=>view.receive(frame(1,'Fresh executor')))
 pill=document.querySelector<HTMLButtonElement>('.executor-float-pill')!;assert.ok(pill)
 await act(async()=>fireEvent.click(pill));assert.ok(document.querySelector('.executor-float')!.textContent!.includes('Fresh executor'))
})

test('React theme sets the document language without translating user message content',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs')
 setLanguage('en')
 try{await mount();assert.equal(document.documentElement.lang,'en');assert.ok(document.querySelector('.chat-history')!.textContent!.includes('Help me plan a focused week.'))}finally{setLanguage('zh-CN')}
})


test('taskless executor approval entries reveal the selected workbench dock from both surfaces',async()=>{
 const {view,sent}=await mount(),state=personalState(2)
 state.pending_approvals=[{approval_id:'approval:taskless',conversation_id:'topic:review',summary:'Inspect a public file'}] as any
 await act(async()=>view.receive(state))
 const entry=document.querySelector<HTMLButtonElement>('.presentation-waiting button')!
 await act(async()=>fireEvent.click(entry))
 assert.equal(view.controller.selectedId,'topic:review')
 assert.equal(view.controller.presentationMode,'workbench')
 assert.equal((document.getElementById('chat-pane') as HTMLElement).hidden,false)
 assert.ok(document.querySelector('.approval-dock [data-approval-id="approval:taskless"]'))
 assert.equal(sent.some(frame=>frame.method==='conversations.approve'),false)
 await act(async()=>view.controller.setPresentation('orb'))
 const orb=document.querySelector<HTMLButtonElement>('#personal-orb-host .personal-orb-task')
 assert.ok(orb,'an approval without a task still has an orb entry')
 assert.ok(orb.textContent!.includes('Inspect a public file'))
 assert.equal(document.querySelector('#personal-orb-host .approval-dock'),null)
 await act(async()=>fireEvent.click(orb))
 assert.equal(view.controller.presentationMode,'workbench')
 assert.equal((document.getElementById('chat-pane') as HTMLElement).hidden,false)
 const allow=[...document.querySelectorAll<HTMLButtonElement>('.approval-dock button')].find(button=>button.textContent==='允许')!
 await act(async()=>fireEvent.click(allow))
 const approvals=sent.filter(frame=>frame.method==='conversations.approve')
 assert.equal(approvals.length,1)
 assert.deepEqual(approvals[0].params,{id:'topic:review',approval_id:'approval:taskless',approved:true})
})
test('project confirmation entry keeps its separate orb route',async()=>{
 const {view}=await mount(),state=personalState(2)
 state.pending_confirmations=[{proposal_id:'proposal:project',conversation_id:'topic:review',workspace:'Demo',session:'Current',summary:'Confirm project'}] as any
 await act(async()=>view.receive(state))
 await act(async()=>fireEvent.click(document.querySelector('.presentation-waiting button')!))
 assert.equal(view.controller.selectedId,'topic:review')
 assert.equal(view.controller.presentationMode,'orb')
})

test('assistant tab follows the saved user name and stays beside the personal profile',async()=>{
 const {view}=await mount();await act(async()=>view.identity({profile:{assistantName:'小星'}}));
 const tab=document.querySelector<HTMLButtonElement>('[data-page="assistant"]');assert.ok(tab);assert.equal(tab.textContent,'小星');assert.equal(tab.previousElementSibling?.getAttribute('data-page'),'profile');assert.equal(tab.previousElementSibling?.textContent,'关于我');
 await act(async()=>fireEvent.click(tab));assert.equal(tab.getAttribute('aria-selected'),'true');assert.ok(document.querySelector('.soul-card'));
 const {setLanguage}=await import('../src/renderer/locale.mjs');try{await act(async()=>{setLanguage('en');view.identity({profile:{assistantName:'设置'}})});assert.equal(tab.textContent,'设置','user names are displayed without translation')}finally{setLanguage('zh-CN')}
 await act(async()=>fireEvent.keyDown(tab,{key:'ArrowRight'}));assert.equal(document.querySelector('[data-page="timeline"]')?.getAttribute('aria-selected'),'true');
})


test('a mirrored goal-proposal feed renders an actionable card in the main conversation',async()=>{
 const {view,sent}=await mount(),state=personalState(2)
 state.feed=[{id:'goal1',kind:'question',title:'想把「练口语」设为目标吗？',why_now:'建议节奏：每天陪你练一点',goal_proposal:{title:'练口语',success_criteria:'每天开口 10 分钟',cadence:'daily',topic_key:'topic',revision:'rev1',evidence_refs:['message:user']},evidence_refs:[],memory_refs:[],source:{type:'conversation',ref:'message:user'},suggestion_id:null,task_ref:null,subject_key:'goal:topic',priority:40,created_at:fixedNow,updated_at:fixedNow,expires_at:null,user_state:'new',snooze_until:null,lifecycle:'active',delivery:{presented_at:null,notified_at:null,spoken_at:null}}]
 state.conversations.messages.push({id:'feed:goal1',conversation_id:'chat:main',role:'assistant',text:'fallback'})
 await act(async()=>view.receive(state))
 const card=document.querySelector<HTMLElement>('#chat-pane .message-feed .feed-card')!
 assert.ok(card,'feed message renders its card')
 assert.equal(card.getAttribute('data-kind'),'goal_proposal')
 assert.ok(card.textContent!.includes('新目标建议'))
 const adopt=[...card.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='设为目标')!
 await act(async()=>fireEvent.click(adopt))
 const action=sent.filter(frame=>frame.method==='feed.action'&&frame.params?.action==='adopt_goal').at(-1)
 assert.ok(action,'adopt_goal command sent')
 assert.equal(action.params.goal_revision,'rev1')
})

test('switching to the orb during workbench voice leaves the workbench layout before the window shrinks',async()=>{
 const windowCalls:any[]=[]
 // The native presentation for the orb never settles here, like a stalled IPC or playback-mute call.
 const applyPresentation=(mode:string)=>{windowCalls.push({mode,collapsed:document.body.dataset.personalCollapsed});return mode==='orb'?new Promise(()=>{}):Promise.resolve()}
 const {view}=await mount({applyPresentation})
 const state=personalState(2);state.conversations.voice_id='chat:main'
 await act(async()=>view.receive(state));view.controller.mode='voice'
 await act(async()=>{view.refresh()})
 assert.ok(document.querySelector('.chat-voice'),'workbench voice is active')
 assert.equal(document.body.dataset.personalCollapsed,'false')
 await act(async()=>{void view.controller.setPresentation('orb').catch(()=>{})})
 await waitFor(()=>assert.ok(windowCalls.some(call=>call.mode==='orb')))
 assert.equal(windowCalls.find(call=>call.mode==='orb').collapsed,'true','the collapsed layout is in place before the window is resized')
 assert.equal(document.body.dataset.personalCollapsed,'true')
 const workspace=document.getElementById('personal-workspace') as HTMLElement
 assert.equal(workspace.style.display,'none','the workbench layout (and its voice bar) is hidden in the orb window')
 assert.equal(view.controller.voiceId,'chat:main','switching presentation never ends voice')
 assert.equal(view.controller.mode,'voice')
})

test('a realtime voice failure in the orb is shown on the orb, not only in the hidden workbench',async()=>{
 const {view}=await mount(),original=view.controller.send
 view.controller.send=(frame:any)=>{if(frame.type==='personal.command'&&frame.method==='conversations.voice'&&frame.params.enabled){queueMicrotask(()=>view.receive({type:'personal.result',request_id:frame.request_id,ok:false,error:'realtime_auth_rejected'}));return true}return original(frame)}
 await act(async()=>{await view.controller.setPresentation('orb')})
 await waitFor(()=>assert.ok(document.querySelector('#personal-orb-host .personal-orb-error')))
 assert.match(document.querySelector('#personal-orb-host .personal-orb-error')!.textContent!,/API Key/)
})
