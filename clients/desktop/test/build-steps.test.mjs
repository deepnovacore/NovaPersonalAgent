import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {createBuildSteps,computerCallTarget,thinkingSummary} from '../src/renderer/build-steps.mjs'

class Element{
 constructor(tag,text,className){this.tag=tag;this.tagName=tag.toUpperCase();this.textContent=text??'';this.className=className??'';this.children=[];this.dataset={};this.listeners={};this.attributes={};this.hidden=false;this.open=false;this.disabled=false
  this.classList={add(){},remove(){},toggle(){}}}
 append(...nodes){this.children.push(...nodes)}
 prepend(...nodes){this.children.unshift(...nodes)}
 replaceChildren(...nodes){this.children=nodes}
 setAttribute(name,value){this.attributes[name]=value;this[name]=value}
 getAttribute(name){return this.attributes[name]}
 addEventListener(name,callback){this.listeners[name]=callback}
 focus(){this.focused=true}
}
const el=(tag,text,className)=>new Element(tag,text,className)
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const at=seconds=>new Date(Date.UTC(2026,9,27,10,0,0)+seconds*1000).toISOString()

const tool=(sequence,overrides={})=>({kind:'tool',id:'call-'+sequence,name:'file_read',message_id:'user',state:'completed',status:'completed',target:'src/中文.txt',input:'{"path":"src/中文.txt"}',output:'actual contents',exit_code:null,input_truncated:false,output_truncated:false,sequence,created_at:at(sequence*2),started_at:at(sequence*2),finished_at:at(sequence*2+1),...overrides})
const thought=(id,text,seconds=1,overrides={})=>({kind:'thinking',id,text,created_at:at(seconds),message_id:'user',...overrides})

function server(steps,{generation=0,pageSize=20}={}){
 return (method,params)=>{
  if(params.view==='image')return {media_type:'image/png',data_base64:'QUJD'}
  const all=params.view==='calls'?steps.filter(step=>step.kind==='tool'):steps
  return {items:all.slice(params.offset,params.offset+pageSize),total:all.length,next_offset:params.offset+pageSize<all.length?params.offset+pageSize:null,generation,first_id:all[0]?.id??null}
 }
}
function makeDisplay(initial={}){
 let value={steps:'standard',collapse:'after_reply',...initial}
 const listeners=new Set()
 return {read:()=>value,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)},set(patch){value={...value,...patch};for(const listener of listeners)listener(value)},listenerCount:()=>listeners.size}
}
function setup({steps=[],status='running',revision=1,generation=0,command,prefs={}}={}){
 const requests=[],display=makeDisplay(prefs)
 const conversation={id:'build',kind:'build',generation,build:{status,log_revision:revision}}
 const c={selectedId:'build',selectedConversation:conversation,connected:true,command:async(method,params)=>{requests.push({method,params});return (command??server(steps,{generation}))(method,params)}}
 let renders=0,group=null
 const log=createBuildSteps({c,el,changed:()=>{renders++;render()},display})
 function render(){group=log.forMessage('user')[0]??null}
 const rows=()=>group?group.children[1].children:[]
 const header=()=>group?group.children[0]:null
 return {c,conversation,steps,requests,display,log,rows,header,render,get group(){return group},get renders(){return renders}}
}

test('steps render provider thinking and tool calls interleaved in server order',async()=>{
 const steps=[thought('t1','先看目录',1),tool(0,{created_at:at(2)}),thought('t2','再读文件',3),tool(1,{created_at:at(4)})]
 const m=setup({steps,status:'paused'})
 m.log.update();await tick()
 assert.deepEqual(m.rows().map(node=>node.dataset.stepKind),['thinking','tool','thinking','tool'])
 const header=m.header()
 assert.equal(header.children[1].textContent,'工作步骤 · 4')
 assert.equal(header.attributes['aria-expanded'],'false')
 assert.equal(m.rows()[0].children[0].children[1].textContent,'思考')
 assert.match(m.rows()[0].children[0].children[4].textContent,/^\d+[smhd]$/)
 assert.equal(m.group.children[1].hidden,true)
 header.listeners.click()
 assert.equal(header.attributes['aria-expanded'],'true')
 assert.equal(m.group.children[1].hidden,false)
 header.listeners.click()
 assert.equal(header.attributes['aria-expanded'],'false')
})

test('no steps renders nothing at all; an empty build keeps the log hidden',async()=>{
 const m=setup({steps:[],status:'paused'})
 m.log.update();await tick()
 assert.equal(m.log.forMessage('user').length,0)
 assert.deepEqual(m.log.remaining(new Set()),[])
 assert.equal(m.group,null)
})

test('compact hides thinking rows, standard truncates the preview, detailed opens the full text',async()=>{
 const long='长'.repeat(400)
 const steps=[thought('t1',long,1),tool(0,{created_at:at(2)})]
 const m=setup({steps,status:'paused',prefs:{steps:'compact'}})
 m.log.update();await tick()
 assert.equal(m.rows().length,1,'a thought-only row is omitted in compact mode')
 assert.equal(m.rows()[0].hidden,false)
 assert.equal(m.header().children[1].textContent,'工作步骤 · 1','the count matches visible rows')
 m.display.set({steps:'standard'});await tick()
 assert.equal(m.rows().length,2)
 const thinking=m.rows()[0]
 assert.equal(thinking.hidden,false)
 const summary=thinking.children[0],body=thinking.children[1]
 assert.equal(summary.children[3].textContent,'长'.repeat(200)+'…')
 assert.equal([...summary.children[3].textContent].length,201)
 assert.equal(body.children[0].textContent,long,'the body keeps the complete reasoning')
 assert.equal(thinking.open,false)
 m.display.set({steps:'detailed'});await tick()
 const detailed=m.rows()[0]
 assert.equal(detailed.open,true)
 assert.equal(detailed.children[0].children[3].textContent,long,'detailed rows show the reasoning untruncated')
 assert.equal(m.rows()[1].children[0].open,true,'detailed also opens tool payloads')
})

test('thinkingSummary strips wrapping whitespace and respects the preview bound',()=>{
 assert.equal(thinkingSummary('  \n 先看目录 \n 再读文件  '),'先看目录 再读文件')
 assert.equal(thinkingSummary('abc',10),'abc')
 assert.equal(thinkingSummary('abcdefghij',10),'abcdefghij')
 assert.equal(thinkingSummary('abcdefghijk',10),'abcdefghij…')
 assert.equal(thinkingSummary(''),'')
})

test('an active build opens its group and after_reply collapses it once the build settles',async()=>{
 const steps=[tool(0,{state:'running',status:'running',finished_at:null})]
 const m=setup({steps,status:'running'})
 m.log.update();await tick()
 const group=m.group,header=m.header()
 assert.equal(header.attributes['aria-expanded'],'true')
 assert.match(header.children[2].textContent,/\d/)
 steps[0]=tool(0)
 m.conversation.build={status:'completed',log_revision:2}
 m.log.update();await tick()
 assert.equal(m.group,group,'the group element survives revision updates')
 assert.equal(m.header(),header)
 assert.equal(header.attributes['aria-expanded'],'false','after_reply collapses a settled build')
})

test('manual collapse keeps the reader toggle state across settle and later updates',async()=>{
 const steps=[tool(0,{state:'running',status:'running',finished_at:null})]
 const m=setup({steps,status:'running',prefs:{collapse:'manual'}})
 m.log.update();await tick()
 const header=m.header()
 assert.equal(header.attributes['aria-expanded'],'true')
 header.listeners.click()
 assert.equal(header.attributes['aria-expanded'],'false')
 steps[0]=tool(0)
 m.conversation.build={status:'completed',log_revision:2}
 m.log.update();await tick()
 assert.equal(header.attributes['aria-expanded'],'false','manual keeps the user collapse after settle')
 steps.push(tool(1,{created_at:at(6)}))
 m.conversation.build={status:'completed',log_revision:3}
 m.log.update();await tick()
 assert.equal(header.attributes['aria-expanded'],'false','later revisions do not reopen a manual group')
})

test('after_reply collapses even a group the reader expanded while it was running',async()=>{
 const steps=[tool(0,{state:'running',status:'running',finished_at:null})]
 const m=setup({steps,status:'running'})
 m.log.update();await tick()
 const header=m.header()
 header.listeners.click();header.listeners.click()
 assert.equal(header.attributes['aria-expanded'],'true')
 steps[0]=tool(0)
 m.conversation.build={status:'completed',log_revision:2}
 m.log.update();await tick()
 assert.equal(header.attributes['aria-expanded'],'false','after_reply owns the settled state')
})

test('changing only the density never collapses a group the reader opened manually',async()=>{
 const m=setup({steps:[tool(0)],status:'paused'})
 m.log.update();await tick()
 const header=m.header()
 assert.equal(header.attributes['aria-expanded'],'false')
 header.listeners.click()
 assert.equal(header.attributes['aria-expanded'],'true')
 m.display.set({steps:'compact'});await tick()
 assert.equal(header.attributes['aria-expanded'],'true','density changes leave disclosure state alone')
})

test('display preference changes re-render rows without refetching the log',async()=>{
 const steps=[thought('t1','短思考',1),tool(0,{created_at:at(2)})]
 const m=setup({steps,status:'paused'})
 m.log.update();await tick()
 const requests=m.requests.length,renders=m.renders
 m.display.set({steps:'compact'})
 await tick()
 assert.equal(m.rows().length,1,'compact omits the thinking row')
 assert.equal(m.rows()[0].hidden,false)
 assert.equal(m.requests.length,requests,'preference changes never refetch')
 assert.ok(m.renders>renders)
})

test('a pre-steps host falls back to the tool-only calls view and stays there',async()=>{
 const steps=[tool(0),tool(1)]
 const command=(method,params)=>{
  if(params.view==='steps')throw Error('invalid_params')
  return server(steps)(method,params)
 }
 const m=setup({steps,command,status:'paused'})
 m.log.update();await tick()
 assert.deepEqual(m.requests.map(request=>request.params.view),['steps','calls'])
 assert.deepEqual(m.rows().map(node=>node.dataset.stepKind),['tool','tool'])
 assert.deepEqual(m.log.remaining(new Set(['user'])),[],'a graceful fallback is not an error')
 steps.push(tool(2))
 m.conversation.build={status:'paused',log_revision:2}
 m.log.update();await tick()
 assert.equal(m.requests.filter(request=>request.params.view==='steps').length,1,'the fallback is sticky for this conversation')
 assert.equal(m.rows().length,3)
})

test('tool rows keep input, output, exit code, truncation notes and screenshot loading',async()=>{
 const steps=[tool(0,{image_ref:'abc.png',exit_code:7,input_truncated:true,output_truncated:true,output:'stderr: 检查失败'})]
 const m=setup({steps,status:'paused'})
 m.log.update();await tick()
 const row=m.rows()[0],details=row.children[0],summary=details.children[0],content=details.children[1]
 assert.equal(row.dataset.toolStatus,'completed')
 assert.match(summary.children[3].textContent,/退出码 7/)
 assert.equal(content.children[4].textContent,steps[0].input)
 assert.equal(content.children[5].hidden,false)
 assert.equal(content.children[7].textContent,'stderr: 检查失败')
 assert.equal(content.children[8].hidden,false)
 assert.equal(content.children[1].hidden,true,'the screenshot waits for the disclosure to open')
 details.open=true;details.listeners.toggle();await tick()
 assert.equal(content.children[1].src,'data:image/png;base64,QUJD')
 assert.equal(content.children[1].hidden,false)
 assert.ok(m.requests.some(request=>request.params.view==='image'&&request.params.image_ref==='abc.png'))
})

test('a failed page read offers retry in a notice row and recovers the log',async()=>{
 let failing=true
 const steps=[tool(0)]
 const command=(method,params)=>{
  if(failing)throw Error('disconnected')
  return server(steps)(method,params)
 }
 const m=setup({steps,command,status:'paused'})
 m.log.update();await tick()
 const notice=m.log.remaining(new Set())[0]
 assert.match(notice.children[0].textContent,/工具日志暂不可用/)
 assert.equal(notice.children[1].textContent,'重试')
 failing=false
 notice.children[1].listeners.click();await tick()
 assert.equal(m.log.forMessage('user').length,1)
 assert.equal(m.rows().length,1)
})

test('the Build log waits for presentation recovery instead of reporting a read failure',async()=>{
 let attempts=0
 const steps=[tool(0)]
 const command=(method,params)=>{attempts++;if(!m.c.presentationReady)throw Error('正在恢复显示模式，请稍候');return server(steps)(method,params)}
 const m=setup({steps,command,status:'paused'})
 m.c.presentationReady=false
 m.log.update();await tick()
 assert.equal(attempts,0)
 assert.deepEqual(m.log.remaining(new Set()),[],'the startup handshake is not a tool-log failure')
 m.c.presentationReady=true;m.log.update();await tick()
 assert.equal(m.log.forMessage('user').length,1)
 assert.equal(attempts,1)
})

test('late replies from a previously selected conversation are discarded',async()=>{
 let release
 const m=setup({steps:[tool(0)],status:'paused',command:()=>new Promise(resolve=>{release=resolve})})
 m.log.update()
 m.c.selectedId='chat';m.c.selectedConversation={id:'chat',kind:'chat'}
 m.log.update()
 release({items:[tool(0)],total:1,next_offset:null,generation:0});await tick()
 assert.equal(m.log.forMessage('user').length,0)
})

test('a settled tail is refreshed from the first unsettled tool row',async()=>{
 const steps=[tool(0),tool(1,{state:'running',status:'running',finished_at:null})]
 const m=setup({steps,status:'running'})
 m.log.update();await tick()
 assert.deepEqual(m.requests.map(request=>request.params.offset),[0])
 steps[1]=tool(1,{status:'failed',state:'completed',exit_code:7,output:'stderr: 检查失败'})
 m.conversation.build={status:'completed',log_revision:2}
 m.log.update();await tick()
 assert.deepEqual(m.requests.map(request=>request.params.offset),[0,1])
 assert.equal(m.rows().length,2)
 assert.equal(m.rows()[1].dataset.toolStatus,'failed')
})

test('unlinked steps are grouped after the transcript instead of being dropped',async()=>{
 const steps=[thought('t1','无归属思考',1,{message_id:null}),tool(0,{message_id:'other'})]
 const m=setup({steps,status:'paused'})
 m.log.update();await tick()
 assert.equal(m.log.forMessage('user').length,0)
 const orphans=m.log.remaining(new Set(['user']))
 assert.equal(orphans.length,2)
 assert.equal(orphans[0].children[0].children[1].textContent,'工作步骤 · 1')
})

test('long builds retain every step so new calls cannot freeze the log',async()=>{
 const steps=Array.from({length:530},(_,index)=>tool(index,{created_at:at(index)}))
 const m=setup({steps,status:'paused'})
 m.log.update();await tick()
 assert.equal(m.rows().length,530)
})

test('computer actions keep reading as human action summaries',()=>{
 assert.equal(computerCallTarget({name:'computer_click',input:'{"x":12,"y":34}'}),'点击 · 12, 34')
 assert.equal(computerCallTarget({name:'computer_scroll',input:'{"direction":"down"}'}),'滚动 · 向下')
 assert.equal(computerCallTarget({name:'obsolete_tool',input:'{}'}),null)
})

test('workbench CSS keeps the avatar gutter and a bounded compact step flow',async()=>{
 const css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 assert.match(css,/\.message-avatar\{[^}]*width:32px[^}]*border-radius:10px/u)
 assert.match(css,/\.message\.assistant\{[^}]*grid-template-columns:32px minmax\(0,1fr\)/u)
 assert.match(css,/\.message\.assistant\.message-continuation\{[^}]*padding-left:42px/u)
 assert.match(css,/\.build-steps-rows\{[^}]*max-height:420px[^}]*overflow:auto/u)
 assert.match(css,/\.build-steps-header\{[^}]*min-height:33px[^}]*border-bottom/u)
 assert.match(css,/\.build-step-summary\{[^}]*min-height:26px/u)
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{[^}]*build-steps-chevron/u)
 assert.match(css,/@media\(forced-colors:active\)\{[^}]*build-steps/u)
})

test('a transient first-page read failure keeps the steps view and retries it',async()=>{
 const steps=[thought('t1','先看目录',1),tool(0,{created_at:at(2)})]
 let fail=true
 const m=setup({steps,status:'running',command:(method,params)=>{
  if(fail&&params.view==='steps'){fail=false;throw Error('network')}
  return server(steps)(method,params)
 }})
 m.log.update();await tick()
 assert.equal(m.requests.some(request=>request.params.view==='calls'),false,'a transient read must not downgrade to calls')
 m.conversation.build.log_revision=2
 m.log.update();await tick()
 assert.ok(m.requests.filter(request=>request.params.view==='steps').length>=2)
 assert.equal(m.rows().length,2)
})

test('an evicted host prefix restarts the timeline instead of keeping stale rows',async()=>{
 let steps=[thought('t0','旧思考',1),tool(0,{created_at:at(2)}),tool(1,{created_at:at(3)})]
 const m=setup({steps,status:'running',command:(method,params)=>server(steps)(method,params)})
 m.log.update();await tick()
 assert.equal(m.rows().length,3)
 // The host evicts the oldest thought and appends a new tool; every index shifts.
 steps=[tool(0,{created_at:at(2)}),tool(1,{created_at:at(3)}),tool(2,{created_at:at(4)})]
 m.conversation.build.log_revision=2
 m.log.update();await tick()
 assert.equal(m.rows().length,3)
 assert.equal(m.requests.filter(request=>request.params.view==='steps'&&request.params.offset===0).length,2,'the shifted prefix is reloaded from zero')
 assert.deepEqual(m.rows().map(node=>node.dataset.stepKind),['tool','tool','tool'])
})
