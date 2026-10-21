import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Assembly} from '../src/composition/assembly.js'
import type {RealtimeAssembly} from '../src/composition/realtime-assembly.js'
import {conversationToolBridge} from '../src/personal-agent/conversation-tool-bridge.js'
type Observer=Parameters<Assembly['runtime']['observe']>[0]
function fixture(){
 let observer:Observer|undefined,unsubscribed=0
 const calls:unknown[]=[],cancelled:string[]=[],busy:boolean[]=[]
 const core={tools:{schemas:[{function:{name:'dispatch',parameters:{type:'object'}}}],hidden:new Set(),bindings:new Map()},
  runtime:{executors:new Map(),observe:(callback:Observer)=>{observer=callback;return ()=>{unsubscribed++}},cancelWork:(id:string)=>{cancelled.push(id)}}} as unknown as Assembly
 const graph={bridge:{acceptUserTranscript:()=>Promise.resolve('origin')},service:{session:{sessionEpoch:1},
  invokeConversationTool:(event:unknown)=>{calls.push(event);return Promise.resolve({accepted:true,code:'accepted',delegate_id:'work',sync_result:false,host_item:{content:'{"state":"accepted"}'}})}}} as unknown as RealtimeAssembly
 return {bridge:conversationToolBridge(core,graph,active=>busy.push(active)),calls,cancelled,busy,unsubscribed:()=>unsubscribed,
  deadline:()=>observer?.({seq:0,ts:0,kind:'deadline',payload:{delegate_id:'work'}}),
  terminal:()=>observer?.({seq:1,ts:0,kind:'handoff',payload:{channel:'computer',delegate_id:'work',origin_ref:'origin',outcome:'ok',trust:'untrusted_external',content:{verified:false},refs:[]}})}
}
test('computer delegation waits for handoff while ordinary dispatch stays asynchronous',{timeout:5000},async()=>{
 const f=fixture(),signal=new AbortController().signal
 const regular=await f.bridge.invoke('task',{id:'ordinary',name:'dispatch',arguments:{executor:'computer',instruction:'test'}},signal)
 assert.equal((regular as {accepted:boolean}).accepted,true);assert.equal(f.unsubscribed(),1)
 let settled=false
 const pending=f.bridge.computerRun!('task',{id:'computer',name:'computer_run',arguments:{instruction:'inspect'}},signal).then(result=>{settled=true;return result})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(settled,false);assert.equal(f.unsubscribed(),1)
 f.deadline();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false)
 assert.deepEqual((f.calls[1] as {arguments:unknown}).arguments,{executor:'computer',instruction:'inspect'})
 f.terminal();assert.equal((await pending as {outcome:string}).outcome,'ok');assert.equal(f.unsubscribed(),2)
})
test('computer delegation cancels but waits for terminal cleanup receipt',{timeout:5000},async()=>{
 const f=fixture(),controller=new AbortController();let settled=false
 const pending=f.bridge.computerRun!('task',{id:'computer',name:'computer_run',arguments:{instruction:'inspect'}},controller.signal).then(result=>{settled=true;return result})
 await new Promise(resolve=>setImmediate(resolve));controller.abort()
 assert.deepEqual(f.cancelled,['work']);assert.equal(settled,false);assert.equal(f.unsubscribed(),0);assert.deepEqual(f.busy,[true])
 f.terminal();await pending;assert.equal(f.unsubscribed(),1);assert.deepEqual(f.busy,[true,false])
})
