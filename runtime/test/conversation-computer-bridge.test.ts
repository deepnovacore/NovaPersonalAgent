import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Assembly} from '../src/composition/assembly.js'
import type {RealtimeAssembly} from '../src/composition/realtime-assembly.js'
import {conversationToolBridge} from '../src/personal-agent/conversation-tool-bridge.js'
type Observer=Parameters<Assembly['runtime']['observe']>[0]
function fixture(){
 let observer:Observer|undefined,unsubscribed=0
 const calls:unknown[]=[],cancelled:string[]=[]
 const core={tools:{schemas:[{function:{name:'dispatch',parameters:{type:'object'}}}],hidden:new Set(),bindings:new Map()},
  runtime:{executors:new Map(),observe:(callback:Observer)=>{observer=callback;return ()=>{unsubscribed++}},cancelWork:(id:string)=>{cancelled.push(id)}}} as unknown as Assembly
 const graph={bridge:{acceptUserTranscript:()=>Promise.resolve('origin')},service:{session:{sessionEpoch:1},
  invokeConversationTool:(event:unknown)=>{calls.push(event);return Promise.resolve({accepted:true,code:'accepted',delegate_id:'work',sync_result:true,host_item:{content:'{"state":"accepted"}'}})}}} as unknown as RealtimeAssembly
 return {bridge:conversationToolBridge(core,graph),calls,cancelled,unsubscribed:()=>unsubscribed,
  deadline:()=>observer?.({seq:0,ts:0,kind:'deadline',payload:{delegate_id:'work'}}),
  terminal:()=>observer?.({seq:1,ts:0,kind:'handoff',payload:{channel:'computer',delegate_id:'work',origin_ref:'origin',outcome:'ok',trust:'untrusted_external',content:{verified:false},refs:[]}})}
}
test('ordinary synchronous bridge tools retain handoff and cancellation semantics',{timeout:5000},async()=>{
 const f=fixture(),controller=new AbortController()
 assert.equal('computerRun' in f.bridge,false)
 const pending=f.bridge.invoke('task',{id:'ordinary',name:'dispatch',arguments:{executor:'computer',instruction:'test'}},controller.signal)
 await new Promise(resolve=>setImmediate(resolve));f.terminal()
 assert.equal((await pending as {outcome:string}).outcome,'ok');assert.equal(f.unsubscribed(),1)
 const next=f.bridge.invoke('task',{id:'cancel',name:'dispatch',arguments:{executor:'computer',instruction:'test'}},controller.signal)
 await new Promise(resolve=>setImmediate(resolve));controller.abort()
 assert.equal((await next as {status:string}).status,'outcome_unknown');assert.deepEqual(f.cancelled,['work']);assert.equal(f.unsubscribed(),2)
})
