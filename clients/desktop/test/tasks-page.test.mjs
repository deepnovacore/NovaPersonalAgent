import test from 'node:test'
import assert from 'node:assert/strict'
import {taskNextStep,activeTaskCount,isSourceProcessingTask} from '../src/renderer/tasks-page.mjs'
test('cards say who acts next',()=>{
 assert.match(taskNextStep({phase:'waiting',waiting_reason:'correction_limit',controller:{kind:'nova'}}),/^需要你：自动修正次数已用完/)
 assert.equal(taskNextStep({phase:'running',controller:{kind:'nova'}}),'Nova 在推进')
 assert.equal(taskNextStep({phase:'running',controller:{kind:'user',client_id:'a'}}),'你在控制')
 assert.equal(taskNextStep({phase:'completed',controller:{kind:'nova'}}),'无需操作')
})

test('source maintenance is excluded without exposing its owned executor work',()=>{
 const internal={phase:'waiting',trigger:{schedule_id:'builtin-source-test'},work_ids:['w1']}
 assert.equal(isSourceProcessingTask(internal),true)
 assert.equal(isSourceProcessingTask({goal:'Use source__process in my project'}),false)
 assert.equal(activeTaskCount({tasks:[internal,{phase:'running',work_ids:['w2']}]},{tasks:[{work_id:'w1',phase:'working'},{work_id:'w2',phase:'working'},{work_id:'w3',phase:'working'}]}),2)
})

import {renderConversationTasks} from '../src/renderer/tasks-page.mjs'
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)])
test('conversation tasks group by recent update, exclude home/schedules, and preserve ownership badges',()=>{
 const el=(tag,text='',className='')=>({tag,textContent:text,className,children:[],dataset:{},attrs:{},append(...xs){this.children.push(...xs)},setAttribute(k,v){this.attrs[k]=v}})
 const panel=el('main'),selected=[],created=[],now=Date.parse('2026-10-26T12:00:00Z'),states={recent:{submission:true},old:{}}
 const c={connected:true,selectedId:'recent',voiceId:'old',create:()=>created.push(1),select:id=>selected.push(id),state:id=>states[id]??{},snapshot:{pending_approvals:[{conversation_id:'recent'}],conversations:{items:[{id:'old',title:'Old',updated_at:'2025-01-01'},{id:'chat:main'},{id:'s',kind:'schedule'},{id:'recent',kind:'build',title:'Recent',updated_at:'2026-10-26'}],messages:[{conversation_id:'recent',text:'Last message'}]}}}
 const button=(text,click,parent)=>{const n=el('button',text);n.click=click;parent.append(n);return n}
 renderConversationTasks(panel,{c,el,button,now})
 assert.deepEqual(panel.children.filter(n=>n.tag==='h3').map(n=>n.textContent),['近 7 天','更早'])
 const rows=panel.children.filter(n=>n.className==='conversation-task');assert.deepEqual(rows.map(n=>n.dataset.conversationId),['recent','old'])
 assert.equal(rows[0].attrs['aria-current'],'true');assert.ok(descendants(rows[0]).some(n=>n.textContent==='待你处理'));assert.ok(descendants(rows[0]).some(n=>n.textContent==='发送中'));assert.ok(descendants(rows[1]).some(n=>n.textContent==='语音中'))
 rows[1].click();panel.children[0].click();assert.deepEqual(selected,['old']);assert.equal(created.length,1)
})

test('delegated records live under the selected conversation and open its existing task inspector',()=>{
 const el=(tag,text='',className='')=>({tag,textContent:text,className,children:[],dataset:{},attrs:{},listeners:{},append(...xs){this.children.push(...xs)},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,f){this.listeners[k]=f}})
 const button=(text,click,parent)=>{const n=el('button',text);n.click=click;parent.append(n);return n},panel=el('main'),local={},opened=[]
 const c={connected:true,selectedId:'a',state:()=>local,snapshot:{tasks:[{id:'ta',conversation_id:'a',goal:'Owned record',phase:'waiting'},{id:'tb',conversation_id:'b',goal:'Other record',phase:'running'}],conversations:{items:[{id:'a',title:'A',last_message:'Durable summary',generation_status:'completed',updated_at:'2026-10-26'}],messages:[]}}}
 renderConversationTasks(panel,{c,el,button,openTask:id=>opened.push(id)})
 const detail=panel.children.find(n=>n.tag==='details');assert.equal(detail.children.length,2);assert.equal(detail.children[1].textContent,'Owned record');detail.children[1].click();assert.deepEqual(opened,['ta'])
 detail.open=true;detail.listeners.toggle();assert.equal(local.taskRecordsOpen,true)
 const row=panel.children.find(n=>n.className==='conversation-task');assert.ok(descendants(row).some(n=>n.textContent==='待你处理'));assert.ok(descendants(row).some(n=>n.textContent==='Durable summary'))
})


test('a Build with an uncertain outcome remains actionable instead of appearing completed',()=>{
 const el=(tag,text='',className='')=>({tag,textContent:text,className,children:[],dataset:{},append(...xs){this.children.push(...xs)},setAttribute(){}})
 const panel=el('main'),c={connected:true,state:()=>({}),snapshot:{conversations:{items:[{id:'uncertain',kind:'build',title:'Check result',updated_at:'2026-10-27',build:{status:'outcome_unknown'}}],messages:[]}}}
 renderConversationTasks(panel,{c,el,button:(text,_click,parent)=>{const node=el('button',text);parent.append(node);return node}})
 const row=panel.children.find(node=>node.dataset.conversationId==='uncertain')
 assert.ok(descendants(row).some(node=>node.textContent==='待你处理'))
 assert.equal(descendants(row).some(node=>node.textContent==='已完成'),false)
})

test('cancelled delegated tasks read 已停止 and a waiting phase outranks a stale failure',()=>{
 const el=(tag,text='',className='')=>({tag,textContent:text,className,children:[],dataset:{},attrs:{},append(...xs){this.children.push(...xs)},setAttribute(k,v){this.attrs[k]=v}})
 const button=(text,_click,parent)=>{const node=el('button',text);parent.append(node);return node}
 const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)])
 const status=({tasks=[],build,generation_status}={})=>{
  const panel=el('main'),item={id:'c',title:'C',updated_at:'2026-10-27T00:00:00Z',build,...(generation_status?{generation_status}:{})}
  const c={connected:true,selectedId:null,state:()=>({}),snapshot:{tasks,conversations:{items:[item],messages:[]}}}
  renderConversationTasks(panel,{c,el,button})
  const row=panel.children.find(node=>node.dataset.conversationId==='c')
  return {text:descendants(row).find(node=>node.className==='conversation-task-status').textContent,state:row.dataset.state}
 }
 // Durable phase `failed` is not a real phase, so it must not be treated as a task failure any more.
 assert.deepEqual(status({tasks:[{conversation_id:'c',phase:'cancelled'}]}),{text:'已停止',state:'cancelled'})
 assert.deepEqual(status({tasks:[{conversation_id:'c',phase:'waiting'},{conversation_id:'c',phase:'cancelled'}],generation_status:'failed'}),{text:'待你处理',state:'waiting'})
 assert.deepEqual(status({tasks:[],generation_status:'failed'}),{text:'失败',state:'failed'})
 assert.deepEqual(status({tasks:[],build:{status:'failed'}}),{text:'失败',state:'failed'})
 assert.deepEqual(status({tasks:[{conversation_id:'c',phase:'running'}]}),{text:'进行中',state:'running'})
 assert.deepEqual(status({tasks:[],build:{status:'paused'}}),{text:'待你处理',state:'waiting'})
 assert.deepEqual(status({tasks:[{conversation_id:'c',phase:'completed'}],generation_status:'completed'}),{text:'已完成',state:'completed'})
 assert.deepEqual(status({tasks:[{conversation_id:'c',phase:'failed'}]}),{text:'已完成',state:'completed'},'the dead durable failed check is gone')
 // A historical stop must not hide current work or a later completed result.
 assert.deepEqual(status({tasks:[
  {conversation_id:'c',phase:'cancelled',updated_at:'2026-10-26T00:00:00Z'},
  {conversation_id:'c',phase:'running',updated_at:'2026-10-27T00:00:00Z'},
 ]}),{text:'进行中',state:'running'})
 assert.deepEqual(status({tasks:[
  {conversation_id:'c',phase:'cancelled',updated_at:'2026-10-26T00:00:00Z'},
  {conversation_id:'c',phase:'completed',updated_at:'2026-10-27T00:00:00Z'},
 ]}),{text:'已完成',state:'completed'})
})
