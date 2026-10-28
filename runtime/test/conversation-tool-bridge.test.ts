import assert from 'node:assert/strict'
import test from 'node:test'
import {conversationToolBridge} from '../src/personal-agent/conversation-tool-bridge.js'

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
    runtime: {executors: new Map(), observe: () => () => {}, cancelWork() {}},
  }
  const graph = {
    bridge: {acceptUserTranscript: async () => 'memory:origin'},
    service: {
      session: {sessionEpoch: 1},
      invokeConversationTool: async (event: unknown) => {
        calls.push(event)
        return {accepted: true, code: 'accepted', delegate_id: null, sync_result: false, host_item: {content: '{"accepted":true}'}}
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
