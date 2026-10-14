import test from 'node:test'
import assert from 'node:assert/strict'
import {scheduleRuleLabel,scheduleMutation} from '../src/renderer/scheduled-tasks-page.mjs'
test('rule labels retain recurrence, weekday, time and timezone',()=>{
 assert.match(scheduleRuleLabel({kind:'weekly',weekdays:[1,5],time:'09:00',timezone:'Asia/Shanghai'}),/周一.*周五.*09:00.*Asia\/Shanghai/)
 assert.match(scheduleRuleLabel({kind:'once',date:'2026-10-14',time:'08:00',timezone:'UTC'}),/2026-10-14.*08:00.*UTC/)
})
test('run-now retries preserve request identity and pause never cancels an active Task',async()=>{
 const local={},calls=[];let fail=true
 const command=async(method,params,options)=>{calls.push({method,params,options});if(fail)throw Error('timeout');return {run_id:'run'}}
 await assert.rejects(scheduleMutation(local,command,'run_now',{id:'s',expected_revision:1}));fail=false
 await scheduleMutation(local,command,'run_now',{id:'s',expected_revision:2});assert.deepEqual(calls[0].params,calls[1].params);assert.equal(calls[0].options.request_id,calls[1].options.request_id)
 await scheduleMutation(local,command,'pause',{id:'s',expected_revision:1});assert.equal(calls.at(-1).method,'schedules.pause');assert.equal(calls.some(call=>call.method==='tasks.cancel'),false)
})

class Node{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.disabled=false}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
 setAttribute(key,value){this[key]=value}addEventListener(key,fn){this.listeners[key]=fn}focus(){document.activeElement=this}
}
test('presets remain editable drafts; pausing and stopping are visibly distinct controls',async()=>{
 const {renderScheduledTasksPage}=await import('../src/renderer/scheduled-tasks-page.mjs')
 globalThis.document={createElement:tag=>new Node(tag)}
 const root=new Node('div'),calls=[],input={title:'Daily',goal:'Review',acceptance:['Summary'],rule:{kind:'daily',time:'09:00',timezone:'UTC'},context:{todos:true}},local={presets:[{input,description:'Review priorities'}]}
 const options={snapshot:{schedules:{items:[]}},command:async(...args)=>{calls.push(args);return {items:[]}},openTask:()=>{},openResult:()=>{},local,rerender:()=>{}}
 renderScheduledTasksPage(root,options)
 const all=node=>[node,...node.children.flatMap(all)],use=all(root).find(node=>node.textContent==='安排这个任务');await use.listeners.click()
 assert.equal(local.editor,true);assert.equal(local.draft.value.title,'Daily');assert.equal(calls.length,0)
 const detailRoot=new Node('div'),item={...input,id:'s',revision:1,enabled:true};Object.assign(local,{editor:false,selected:'s',detail:item,history:{items:[]}})
 renderScheduledTasksPage(detailRoot,{...options,snapshot:{schedules:{items:[item],active_runs:[{schedule_id:'s',task_id:'task'}]},tasks:[{id:'task',control_revision:0,goal_revision:0}]}})
 assert.ok(all(detailRoot).some(node=>node.textContent==='暂停定时'));assert.ok(all(detailRoot).some(node=>node.textContent==='停止当前任务'));assert.equal(all(detailRoot).find(node=>node.textContent==='现在运行').disabled,true)
})

test('ISO Sunday renders and the editor previews and saves weekday 7',async()=>{
 const {ScheduleDraft,mountScheduleEditor}=await import('../src/renderer/schedule-editor.mjs')
 const {scheduleRuleSchema}=await import('../../../runtime/dist/src/personal-agent/scheduled-time.js')
 assert.match(scheduleRuleLabel({kind:'weekly',weekdays:[7],time:'09:00',timezone:'UTC'}),/周日.*09:00/)
 globalThis.document={createElement:tag=>new Node(tag)}
 const calls=[],value={title:'Sunday review',goal:'Review',acceptance:['Summary'],rule:{kind:'weekly',weekdays:[1],time:'09:00',timezone:'UTC'},context:{todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}}
 const command=async(method,params)=>{calls.push({method,params});scheduleRuleSchema.parse(method==='schedules.preview'?params.rule:params.input.rule);return method==='schedules.preview'?{next_slot:{scheduled_at:'2026-10-18T09:00:00Z'}}:{id:'s'}}
 const model=new ScheduleDraft(value,command),root=new Node('div')
 mountScheduleEditor(root,{model,onSaved:()=>{},onCancel:()=>{}})
 const all=node=>[node,...node.children.flatMap(all)]
 all(root).find(node=>node.tagName==='BUTTON'&&node.textContent==='周一').listeners.click()
 all(root).find(node=>node.tagName==='BUTTON'&&node.textContent==='周日').listeners.click()
 await model.preview();await model.save()
 assert.deepEqual(calls.at(-1).params.input.rule.weekdays,[7])
})
