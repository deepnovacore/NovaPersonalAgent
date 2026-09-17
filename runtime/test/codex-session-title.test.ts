import assert from 'node:assert/strict'
import test from 'node:test'
import {generateSessionTitle} from '../src/executors/codex/session-title.js'

test('title generation uses an ephemeral read-only thread and never returns its id as the task binding', async () => {
  let listener: (method: string, params: Record<string, unknown>) => void = () => undefined
  const calls: {method: string; params: Record<string, unknown>}[] = []
  const title = await generateSessionTitle('开发一个卡丁车游戏', {
    subscribe: callback => { listener = callback; return () => { listener = () => undefined } },
    request: (method, params) => {
      calls.push({method, params})
      if (method === 'thread/start') return Promise.resolve({thread: {id: 'temporary-title'}})
      if (method === 'turn/start') {
        listener('item/completed', {threadId: 'unrelated', item: {type: 'agentMessage', text: '{"title":"WRONG"}'}})
        listener('item/completed', {threadId: 'temporary-title', item: {type: 'agentMessage', text: '{"title":"开发卡丁车游戏"}'}})
        listener('turn/completed', {threadId: 'temporary-title', turn: {status: 'completed'}})
      }
      return Promise.resolve({})
    },
  })
  assert.equal(title, '开发卡丁车游戏')
  assert.equal(calls[0]?.params.ephemeral, true)
  assert.equal(calls[0]?.params.permissions, ':read-only')
  assert.equal(calls.at(-1)?.method, 'thread/unsubscribe')
  assert.equal(calls.some(call => call.method === 'thread/name/set'), false)
})
