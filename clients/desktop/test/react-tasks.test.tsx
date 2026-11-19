import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React, { createRef } from 'react'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
const { render, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react')
const { TasksPage, TaskDetail, ScheduledTasksPage } = await import('../src/renderer/react/tasks.tsx')
afterEach(() => { cleanup(); dom.window.localStorage.clear() })
const task = (extra: any = {}) => ({ id:'t',conversation_id:'chat:t',goal:'Fix login',phase:'running',control_revision:0,goal_revision:0,controller:{kind:'nova'},session_ids:['s1','s2'],events:{items:[],next:0},artifact_refs:[],approvals:[],viewer:{client_id:'client',can_takeover:true},capabilities:{detail:'conversation',input:true},...extra })
const schedule = (extra: any = {}) => ({id:'s',revision:1,enabled:true,title:'Daily',goal:'Review priorities',acceptance:['Summary'],rule:{kind:'daily',time:'09:00',timezone:'UTC'},context:{todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false},...extra})
const controller = (command: any, snapshot: any = {}) => ({ command, snapshot, connected:true, selectedId:'chat:t', voiceId:null, state:()=>({}), changed(){} })

test('conversation task status favors waiting and active work over old stopped records', async () => {
 let selected = '',created = 0,opened = ''
 const c:any = controller(async()=>{}, {conversations:{items:[{id:'chat:t',title:'Conversation',updated_at:new Date().toISOString()}]},tasks:[task({phase:'cancelled',updated_at:'2026-01-01'}),task({id:'new',phase:'waiting',waiting_reason:'task_effect_unknown',updated_at:'2026-10-28'})]})
 c.select=async(id:string)=>{selected=id}; c.create=async()=>{created++}
 const v=render(<TasksPage c={c} run={(f:any)=>f()} openTask={(id:string)=>{opened=id}} />)
 assert.equal(v.container.querySelector('.conversation-task')?.getAttribute('data-state'),'waiting')
 fireEvent.click(v.getByText('Conversation')); await waitFor(()=>assert.equal(selected,'chat:t'))
 fireEvent.click(v.getByText('创建任务')); await waitFor(()=>assert.equal(created,1))
 fireEvent.click(v.getAllByText('Fix login')[0]); await waitFor(()=>assert.equal(opened,'t'))
})

test('takeover is single flight and only receipted control enables the session composer', async () => {
 let resolve:any; const calls:any[]=[]; let current=task()
 const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(method==='tasks.control')return new Promise(r=>{resolve=r});return current})
 const ref=createRef<any>(),v=render(<TaskDetail ref={ref} id="t" c={c} run={(f:any)=>f()} onClose={()=>{}} />)
 await waitFor(()=>assert.ok(v.getByText('接管并回复')))
 assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).disabled,true)
 fireEvent.click(v.getByText('接管并回复'));fireEvent.click(v.getByText('接管并回复'))
 assert.equal(calls.filter(c=>c[0]==='tasks.control').length,1)
 assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).disabled,true)
 current=task({controller:{kind:'user',client_id:'client'},control_revision:1});await act(async()=>resolve(current))
 await waitFor(()=>assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).disabled,false))
 assert.deepEqual(calls.find(c=>c[0]==='tasks.control')[1],{task_id:'t',control_revision:0,goal_revision:0,action:'takeover'})
 fireEvent.change(v.getByLabelText('回复执行器'),{target:{value:'session one'}})
 fireEvent.change(v.getByLabelText('执行器会话'),{target:{value:'s2'}})
 fireEvent.change(v.getByLabelText('回复执行器'),{target:{value:'session two'}})
 fireEvent.change(v.getByLabelText('执行器会话'),{target:{value:'s1'}})
 assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).value,'session one')
})

test('unknown executor input persists its request and clears only the exact accepted receipt', async () => {
 const calls:any[]=[];let current=task({controller:{kind:'user',client_id:'client'},control_revision:2})
 const c=controller(async(method:string,params:any,options:any)=>{calls.push([method,params,options]);if(method==='tasks.input')throw Error('task_input_unknown');return current})
 const ref=createRef<any>(),v=render(<TaskDetail ref={ref} id="t" c={c} onClose={()=>{}} />)
 await waitFor(()=>assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).disabled,false))
 fireEvent.change(v.getByLabelText('回复执行器'),{target:{value:'Keep exact draft'}});fireEvent.click(v.getByText('发送给执行器'))
 await waitFor(()=>assert.ok(v.getByText('刷新发送状态')))
 const request=calls.find(c=>c[0]==='tasks.input')[2].request_id
 assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).value,'Keep exact draft')
 assert.equal((v.getByText('发送给执行器') as HTMLButtonElement).disabled,true)
 current={...current,input_receipt:{request_id:'other',status:'accepted'}};await act(async()=>ref.current.receive({type:'personal.state',tasks:[current]}))
 assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).value,'Keep exact draft')
 current={...current,input_receipt:{request_id:request,status:'accepted'}};await act(async()=>ref.current.receive({type:'personal.state',tasks:[current]}))
 await waitFor(()=>assert.equal((v.getByLabelText('回复执行器') as HTMLTextAreaElement).value,''))
 assert.equal(calls.filter(c=>c[0]==='tasks.input').length,1)
})

test('public activity paginates exact cursors, retains warnings and escapes executor output', async () => {
 const events=Array.from({length:100},(_,i)=>({seq:i+1,kind:'message',sender:'executor',text:`Event ${i}`})); const calls:any[]=[]
 const c=controller(async(method:string,params:any)=>{calls.push([method,params]);return params.after===0?task({events:{items:events,next:100,incomplete:true,truncated:true}}):task({events:{items:[{seq:101,kind:'verification',text:JSON.stringify({kind:'correct',instruction:'Add regression'}),refs:['proof']},{seq:102,kind:'message',text:'<img src=x onerror=alert(1)>'}],next:102}})})
 const v=render(<TaskDetail id="t" c={c} onClose={()=>{}} />)
 await waitFor(()=>assert.ok(v.getByText('Event 0')));fireEvent.click(v.getByText('加载更多活动'))
 await waitFor(()=>assert.ok(v.getByText('需要修正：Add regression')))
 assert.equal(calls.at(-1)[1].after,100);assert.ok(v.getByText('Event 0'));assert.ok(v.getByText('部分公开活动缺失，请核对执行器与任务结果。'));assert.ok(v.getByText('较早活动已截断；任务与发送回执仍保留。'))
 assert.ok(v.getByText('<img src=x onerror=alert(1)>'));assert.equal(v.container.querySelector('img'),null)
})

test('schedule editing preserves stale text, requires reload and keeps timezone and ISO Sunday', async () => {
 const calls:any[]=[];const item=schedule({rule:{kind:'weekly',weekdays:[1],time:'09:00',timezone:'Asia/Shanghai'}})
 const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(method==='schedules.get')return item;if(method==='schedules.history')return {items:[]};if(method==='schedules.preview')return {next_slot:{scheduled_at:'2026-11-01T01:00:00Z'}};if(method==='schedules.update')throw Object.assign(Error('stale_schedule'),{refusal_code:'stale_schedule'});return {items:[]}}, {schedules:{items:[item],active_runs:[]}})
 const v=render(<ScheduledTasksPage c={c} openTask={()=>{}} selectedId="s" />)
 await waitFor(()=>assert.ok(v.getByText('编辑')));fireEvent.click(v.getByText('编辑'))
 await waitFor(()=>assert.ok(v.getByLabelText('任务名称')))
 fireEvent.change(v.getByLabelText('让 Nova 做什么'),{target:{value:'Preserved goal'}})
 fireEvent.click(v.getByText('周一'));fireEvent.click(v.getByText('周日'))
 await waitFor(()=>assert.equal((v.getByText('保存定时任务') as HTMLButtonElement).disabled,false));fireEvent.click(v.getByText('保存定时任务'))
 await waitFor(()=>assert.ok(v.getByText('规则已更新，请载入最新版本后再保存。')))
 assert.equal((v.getByLabelText('让 Nova 做什么') as HTMLTextAreaElement).value,'Preserved goal')
 assert.equal((v.getByText('保存定时任务') as HTMLButtonElement).disabled,true)
 assert.ok(v.getByText('载入最新版本'));assert.deepEqual(calls.find(c=>c[0]==='schedules.update')[1].input.rule,{kind:'weekly',weekdays:[7],time:'09:00',timezone:'Asia/Shanghai'})
})

test('schedule pause and task cancellation stay separate; active runs disable run now', async () => {
 const calls:any[]=[],item=schedule(); const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(method==='schedules.get'||method==='schedules.pause')return item;return {items:[]}}, {schedules:{items:[item],active_runs:[{schedule_id:'s',task_id:'t'}]},tasks:[task()]})
 const v=render(<ScheduledTasksPage c={c} selectedId="s" openTask={()=>{}} />)
 await waitFor(()=>assert.ok(v.getByText('暂停定时')));assert.equal((v.getByText('现在运行') as HTMLButtonElement).disabled,true)
 fireEvent.click(v.getByText('暂停定时'));await waitFor(()=>assert.ok(calls.find(c=>c[0]==='schedules.pause')));assert.equal(calls.some(c=>c[0]==='tasks.cancel'),false)
 fireEvent.click(v.getByText('停止当前任务'));await waitFor(()=>assert.ok(calls.find(c=>c[0]==='tasks.cancel')))
 assert.deepEqual(calls.find(c=>c[0]==='tasks.cancel')[1],{task_id:'t',control_revision:0,goal_revision:0})
})

test('task approvals are single flight, task-scoped and disabled without a connection', async()=>{
  const calls:any[]=[];let settle:any
  const detail=task({approvals:[{pending_approval_id:'approval-1',operation_summary:'Run check',allowed_decisions:['accept','decline']}]})
  const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(method==='conversations.approve')return new Promise(resolve=>{settle=resolve});return detail})
  const v=render(<TaskDetail id="t" c={c} onClose={()=>{}} />)
  await waitFor(()=>assert.ok(v.getByText('允许一次')));fireEvent.click(v.getByText('允许一次'));fireEvent.click(v.getByText('拒绝'))
  assert.equal(calls.filter(c=>c[0]==='conversations.approve').length,1);assert.deepEqual(calls.find(c=>c[0]==='conversations.approve')[1],{id:'chat:t',approval_id:'approval-1',approved:true})
  await act(async()=>settle({}));await waitFor(()=>assert.equal((v.getByText('拒绝') as HTMLButtonElement).disabled,false))
  c.connected=false;v.rerender(<TaskDetail id="t" c={c} onClose={()=>{}} />)
  for(const button of v.container.querySelectorAll('.task-controls button, section[aria-label="任务审批"] button'))assert.equal((button as HTMLButtonElement).disabled,true)
})

test('Nova control permits reconciliation and Todo completion with exact version fences', async()=>{
  const calls:any[]=[];let detail=task({phase:'waiting',capabilities:{input:false,reconcile:true}})
  const c=controller(async(method:string,params:any)=>{calls.push([method,params]);return detail})
  const ref=createRef<any>(),v=render(<TaskDetail ref={ref} id="t" c={c} onClose={()=>{}} />)
  await waitFor(()=>assert.ok(v.getByText('已核对：未执行')))
  assert.equal((v.getByText('继续任务') as HTMLButtonElement).disabled,true)
  fireEvent.click(v.getByText('已核对：未执行'));await waitFor(()=>assert.ok(calls.find(c=>c[0]==='tasks.reconcile')))
  assert.deepEqual(calls.find(c=>c[0]==='tasks.reconcile')[1],{task_id:'t',control_revision:0,goal_revision:0,resolution:'not_run'})
  detail=task({phase:'completed',capabilities:{todo_conflict:true,todo:{title:'Ship',version:3}}});await act(async()=>ref.current.receive({type:'personal.state',tasks:[detail]}))
  fireEvent.click(v.getByText('标记 Todo 完成'));await waitFor(()=>assert.ok(calls.find(c=>c[0]==='tasks.complete_todo')))
  assert.deepEqual(calls.find(c=>c[0]==='tasks.complete_todo')[1],{task_id:'t',control_revision:0,goal_revision:0,todo_version:3})
})

test('changing task id ignores old reads and caches public history across inspector remounts',async()=>{
  let old:any;const calls:any[]=[]
  const history={items:new Map(),cursor:0,incomplete:false,truncated:false}
  const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(params.task_id==='old')return new Promise(resolve=>{old=resolve});return task({events:{items:params.after?[]:[{seq:7,kind:'message',text:'Saved activity'}],next:7}})})
  const v=render(<TaskDetail id="old" c={c} history={history} onClose={()=>{}} />)
  v.rerender(<TaskDetail id="t" c={c} history={history} onClose={()=>{}} />);await waitFor(()=>assert.ok(v.getByText('Saved activity')))
  await act(async()=>old(task({id:'old',goal:'Outdated task'})));assert.equal(v.queryByText('Outdated task'),null)
  v.unmount();const again=render(<TaskDetail id="t" c={c} history={history} onClose={()=>{}} />)
  await waitFor(()=>assert.ok(again.getByText('Saved activity')));assert.equal(calls.at(-1)[1].after,7)
})

test('schedule histories paginate, discuss results and adopt a goal with its current version',async()=>{
  const calls:any[]=[];let discussed='';const item=schedule()
  const result=(id:string)=>({run_id:id,task_id:'t',claimed_at:'2026-10-28T09:00:00Z',summary:{outcome:'completed',text:`Result ${id}`}})
  const c=controller(async(method:string,params:any)=>{calls.push([method,params]);if(method==='schedules.get')return item;if(method==='schedules.history')return params.cursor?{items:[result('r2')]}:{items:[result('r1')],next_cursor:'next'};return {}},{schedules:{items:[item],active_runs:[]},life:{goals:[{id:'g',title:'Ship',version:8}]}})
  const v=render(<ScheduledTasksPage c={c} selectedId="s" openTask={()=>{}} openResult={async id=>{discussed=id}} />)
  await waitFor(()=>assert.ok(v.getByText('Result r1')));fireEvent.click(v.getByText('更多记录'));await waitFor(()=>assert.ok(v.getByText('Result r2')))
  assert.ok(v.getByText('Result r1'));assert.deepEqual(calls.find(c=>c[0]==='schedules.history'&&c[1].cursor)[1],{id:'s',cursor:'next'})
  fireEvent.click(v.getAllByText('继续讨论')[0]);await waitFor(()=>assert.equal(discussed,'r1'))
  fireEvent.click(v.getAllByText('转为事项')[0]);await waitFor(()=>assert.equal((v.getByText('保存事项') as HTMLButtonElement).disabled,false));fireEvent.change(v.getByLabelText('事项类型'),{target:{value:'idea'}});fireEvent.change(v.getByLabelText('关联目标'),{target:{value:'g'}});fireEvent.click(v.getByText('保存事项'))
  await waitFor(()=>assert.ok(v.getByText('已保存到个人事项')))
  assert.deepEqual(calls.find(c=>c[0]==='schedules.adopt_result')[1],{run_id:'r1',title:'Daily',note:'Result r1',kind:'idea',goal_id:'g',goal_version:8})
})

test('lost schedule save acknowledgement locks the draft and retries the same request',async()=>{
  const calls:any[]=[];let writes=0
  const c=controller(async(method:string,params:any,options:any)=>{calls.push([method,params,options]);if(method==='schedules.presets'||method==='schedules.list'||method==='schedules.history')return {items:[]};if(method==='schedules.preview')return {next_slot:{scheduled_at:'2026-11-01T09:00:00Z'}};if(method==='schedules.create'){if(++writes===1)throw Error('timeout');return schedule(params.input)};return {}},{schedules:{items:[]},settings:{timezone:'UTC'}})
  const v=render(<ScheduledTasksPage c={c} openTask={()=>{}} />)
  fireEvent.click(v.getByText('创建定时任务'));fireEvent.change(v.getByLabelText('任务名称'),{target:{value:'Recover'}});fireEvent.change(v.getByLabelText('让 Nova 做什么'),{target:{value:'Retain exact input'}})
  fireEvent.change(v.getByLabelText('完成标准（每行一条）'),{target:{value:'One\n\nTwo\n'}})
  await waitFor(()=>assert.equal((v.getByText('保存定时任务') as HTMLButtonElement).disabled,false));fireEvent.click(v.getByText('保存定时任务'))
  await waitFor(()=>assert.ok(v.getByText('重试确认保存')))
  assert.equal((v.getByLabelText('任务名称') as HTMLInputElement).disabled,true);assert.equal((v.getByLabelText('完成标准（每行一条）') as HTMLTextAreaElement).value,'One\n\nTwo\n')
  fireEvent.click(v.getByText('重试确认保存'));await waitFor(()=>assert.ok(v.getByText('编辑')))
  const writesMade=calls.filter(c=>c[0]==='schedules.create');assert.equal(writesMade.length,2);assert.deepEqual(writesMade[0],writesMade[1]);assert.deepEqual(writesMade[0][1].input.acceptance,['One','Two'])
})

test('external schedule navigation while a prior detail is loading opens the newest selection',async()=>{
  let resolveOld:any
  const c=controller(async(method:string,params:any)=>{if(method==='schedules.get'){if(params.id==='old')return new Promise(r=>{resolveOld=r});return schedule({id:'new',title:'Newest schedule'})}return {items:[]}},{schedules:{items:[]}})
  const v=render(<ScheduledTasksPage c={c} selectedId="old" openTask={()=>{}} />)
  await waitFor(()=>assert.ok(resolveOld));v.rerender(<ScheduledTasksPage c={c} selectedId="new" openTask={()=>{}} />)
  await act(async()=>resolveOld(schedule({id:'old',title:'Old schedule'})))
  await waitFor(()=>assert.ok(v.getByText('Newest schedule')))
})

test('approval deep links focus once and live updates preserve the active composer',async()=>{
  const current=task({controller:{kind:'user',client_id:'client'},approvals:[{pending_approval_id:'a',operation_summary:'Run check'}]})
  const c=controller(async()=>({...current,approvals:structuredClone(current.approvals)})),ref=createRef<any>()
  const v=render(<TaskDetail ref={ref} id="t" c={c} focusApproval onClose={()=>{}} />)
  await waitFor(()=>assert.ok(document.activeElement===v.getByText('允许一次')))
  const draft=v.getByLabelText('回复执行器');draft.focus();fireEvent.change(draft,{target:{value:'Do not interrupt'}})
  await act(async()=>ref.current.receive({type:'personal.state',tasks:[current]}))
  assert.ok(document.activeElement===draft, 'Live activity must preserve composer focus')
})

test('executor float rejects malformed snapshots and ignores older revisions',async()=>{
  const {ExecutorFloat}=await import('../src/renderer/react/tasks.tsx')
  const ref=createRef<any>(),opened:string[]=[]
  const v=render(<ExecutorFloat ref={ref} openTask={id=>opened.push(id)} taskFor={()=>'durable'} />)
  const frame={type:'executor.tasks',revision:2,active_project:'Project',tasks:[{work_id:'w',executor:'codex',project:'Project',title:'Execution',phase:'working',summary:'Public progress',ts:1}]}
  await act(async()=>ref.current.receive(frame));fireEvent.click(v.getByText('codex · 进行中'));fireEvent.click(v.getByText('查看详情'));assert.deepEqual(opened,['durable'])
  await act(async()=>ref.current.receive({...frame,revision:3,tasks:[{...frame.tasks[0],summary:'/tmp/private-path'}]}))
  assert.ok(v.getByText('Public progress'));assert.equal(v.queryByText('/tmp/private-path'),null)
  await act(async()=>ref.current.receive({...frame,revision:1,tasks:[]}));assert.ok(v.getByText('Public progress'))
  await act(async()=>ref.current.reset());assert.equal(v.container.querySelector('aside')?.hidden,true)
})

test('a completed save from an older editor cannot replace a newly selected schedule',async()=>{
  let finishSave:any
  const c=controller(async(method:string,params:any)=>{if(method==='schedules.get')return schedule({id:params.id,title:params.id==='new'?'Newest schedule':'Old schedule'});if(method==='schedules.preview')return {next_slot:{scheduled_at:'2026-11-01T09:00:00Z'}};if(method==='schedules.update')return new Promise(resolve=>{finishSave=resolve});return {items:[]}},{schedules:{items:[]}})
  const v=render(<ScheduledTasksPage c={c} selectedId="old" openTask={()=>{}} />)
  await waitFor(()=>assert.ok(v.getByText('编辑')));fireEvent.click(v.getByText('编辑'))
  await waitFor(()=>assert.equal((v.getByText('保存定时任务') as HTMLButtonElement).disabled,false));fireEvent.click(v.getByText('保存定时任务'))
  await waitFor(()=>assert.ok(finishSave));v.rerender(<ScheduledTasksPage c={c} selectedId="new" openTask={()=>{}} />)
  await waitFor(()=>assert.ok(v.getByText('Newest schedule')))
  await act(async()=>finishSave(schedule({id:'old',title:'Saved old schedule'})))
  assert.ok(v.getByText('Newest schedule'));assert.equal(v.queryByText('Saved old schedule'),null)
})
