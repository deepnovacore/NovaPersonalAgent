import assert from 'node:assert/strict'
import test from 'node:test'
import {conversationToolBridge,memoryRememberSummary} from '../src/personal-agent/conversation-tool-bridge.js'

function fixture() {
  const schemas = [
    {type: 'function', function: {name: 'dispatch', parameters: {type: 'object', properties: {executor: {type: 'string'}}}}},
    {type: 'function', function: {name: 'memory__recall', parameters: {type: 'object'}}},
  ]
  const bindings = new Map([
    ['dispatch', {kind: 'host', logical_name: 'host.dispatch', executor: null, op: null, sync_result: false}],
    ['memory__recall', {kind: 'query', logical_name: 'memory.recall', executor: null, op: null, sync_result: false}],
  ])
  const calls: unknown[] = []
  const core = {
    tools: {schemas, bindings, hidden: new Set()},
    runtime: {executors: new Map(), observe: () => () => { /* no observer cleanup */ }, cancelWork() { /* no work in the fixture */ }},
  }
  const graph = {
    bridge: {acceptUserTranscript: () => Promise.resolve('memory:origin')},
    service: {
      session: {sessionEpoch: 1},
      invokeConversationTool: (event: unknown) => {
        calls.push(event)
        return Promise.resolve({accepted: true, code: 'accepted', delegate_id: null, sync_result: false, host_item: {content: '{"accepted":true}'}})
      },
    },
  }
  return {bridge: conversationToolBridge(core as never, graph as never, {chat: true}), hostBridge: conversationToolBridge(core as never, graph as never, {chat: false}), calls}
}

test('Chat bridge hides and refuses dispatch; the explicit host bridge still allows it', async () => {
  const {bridge, hostBridge, calls} = fixture()
  assert.deepEqual((bridge.chatTools ?? []).map(tool => tool.name), ['memory__recall'])
  const denied = await bridge.invoke('do it', {id: 'c1', name: 'dispatch', arguments: {executor: 'codex'}}, new AbortController().signal) as {code?:string}
  assert.equal(denied.code, 'chat_tool_forbidden')
  assert.equal(calls.length, 0)
  const stillDenied = await bridge.invoke('do it', {id: 'c2', name: 'dispatch', arguments: {executor: 'codex'}}, new AbortController().signal, {fence: {task_id: 't1', control_revision: 0, goal_revision: 0}} as never) as {code?:string}
  assert.equal(stillDenied.code, 'chat_tool_forbidden')
  assert.equal(calls.length, 0)
  const hostAllowed = await hostBridge.invoke('do it', {id: 'c3', name: 'dispatch', arguments: {executor: 'codex'}}, new AbortController().signal) as {accepted?:boolean}
  assert.equal(hostAllowed.accepted, true)
  assert.equal(calls.length, 1)
})

test('conversation tool bridge binds write authority to the same typed-user snapshot', async () => {
  const {memoryHostToolNames} = await import('../src/personal-agent/conversation-tool-bridge.js')
  assert.deepEqual([...memoryHostToolNames], ['memory__remember', 'memory__lookup'])
  const text = 'Remember my preferred name is River', origin = 'memory:typed-user'
  const core = {tools: {schemas: [{type: 'function', function: {name: 'memory__remember', parameters: {type: 'object'}}}], bindings: new Map([['memory__remember', {kind: 'host'}]]), hidden: new Set()}, runtime: {executors: new Map(), observe: () => () => undefined}}
  const graph = {
    bridge: {acceptUserTranscript: (value: string) => {assert.equal(value, text); return Promise.resolve(origin)}},
    service: {session: {sessionEpoch: 7}, invokeConversationTool: (_event: unknown, turn: {user: {text: string;origin_ref: string};authority: {originRef: string;stillWanted: () => boolean}}) => {
      assert.equal(turn.user.text, text)
      assert.equal(turn.user.origin_ref, origin)
      assert.equal(turn.authority.originRef, origin)
      assert.equal(turn.authority.stillWanted(), true)
      return Promise.resolve({accepted: true, code: 'committed', host_item: {content: '{"state":"committed"}'}})
    }},
  }
  const bridge = conversationToolBridge(core as never, graph as never)
  assert.deepEqual(bridge.readonlyNames, [], 'memory host writes must not enter concurrent query batches')
  const result = await bridge.invoke(text, {id: 'save', name: 'memory__remember', arguments: {}}, new AbortController().signal) as {code: string}
  assert.equal(result.code, 'committed')
})

test('remember traces use only fixed action and slot labels for raw and wrapped receipts',async()=>{
 const receipt={state:'committed',current:{text:'PRIVATE_NAME',slot:'PRIVATE_SLOT'},text:'PRIVATE_TEXT'}
 for(const action of ['set','forget'])for(const slot of [undefined,'preferred_name','reply_style','PRIVATE_SLOT']){
  const args={action,...(slot?{slot}:{}),text:'PRIVATE_NAME',quote:'PRIVATE_QUOTE'}
  const expected=(action==='forget'?'已忘记':'已保存')+(slot==='preferred_name'?' · 称呼':slot==='reply_style'?' · 回答风格':'')
  for(const result of [receipt,{accepted:true,code:'committed',result:receipt}]){
   assert.equal(memoryRememberSummary(args,result,true),expected)
   const events:unknown[]=[]
   const core={tools:{schemas:[{function:{name:'memory__remember',parameters:{type:'object'}}}],bindings:new Map([['memory__remember',{kind:'host'}]]),hidden:new Set()},runtime:{executors:new Map(),observe:()=>()=>undefined}}
   const graph={bridge:{acceptUserTranscript:()=>Promise.resolve('origin')},service:{session:{sessionEpoch:1},invokeConversationTool:()=>Promise.resolve({accepted:true,host_item:{content:JSON.stringify(result)}})}}
   const bridge=conversationToolBridge(core as never,graph as never,{chat:true,onTool:event=>events.push(event)})
   await bridge.invoke('PRIVATE_QUOTE',{id:'call',name:'memory__remember',arguments:args},new AbortController().signal)
   assert.deepEqual(events,[{name:'memory__remember',state:'running',summary:''},{name:'memory__remember',state:'ok',summary:expected}])
  }
  for(const result of [null,{state:'refused'},receipt,{accepted:false,result:receipt}]){
   assert.equal(memoryRememberSummary(args,result,false),'未保存')
  }
  assert.equal(memoryRememberSummary(args,{accepted:false,result:receipt},true),'未保存')
  assert.equal(memoryRememberSummary(args,{state:'refused',text:'PRIVATE_TEXT'},true),'未保存')
 }
})

test('lookup traces count entries in raw and wrapped results without exposing entry text',async()=>{
 for(const result of [{entries:[{text:'PRIVATE_NAME'}]},{accepted:true,result:{entries:[{text:'PRIVATE_NAME'}]}}]){
  const events:unknown[]=[]
  const core={tools:{schemas:[{function:{name:'memory__lookup',parameters:{type:'object'}}}],bindings:new Map([['memory__lookup',{kind:'host'}]]),hidden:new Set()},runtime:{executors:new Map(),observe:()=>()=>undefined}}
  const graph={bridge:{acceptUserTranscript:()=>Promise.resolve('origin')},service:{session:{sessionEpoch:1},invokeConversationTool:()=>Promise.resolve({accepted:true,host_item:{content:JSON.stringify(result)}})}}
  await conversationToolBridge(core as never,graph as never,{chat:true,onTool:event=>events.push(event)}).invoke('lookup',{id:'lookup',name:'memory__lookup',arguments:{}},new AbortController().signal)
  assert.deepEqual(events,[{name:'memory__lookup',state:'running',summary:''},{name:'memory__lookup',state:'ok',summary:'1 条'}])
 }
})
