import assert from 'node:assert/strict'
import test from 'node:test'
import {CHAT_DENIED_TOOLS, chatToolAllowed} from '../src/personal-agent/conversation-tool-policy.js'

const readonly = new Set(['search__search', 'mcp__nova_knowledge__recall'])
const binding = (kind: 'delegate' | 'query' | 'host', executor: string | null = null, op: string | null = null) => ({kind, logical_name: 'test', executor, op, sync_result: false})

test('Chat keeps read-only retrieval and the user own memory tools', () => {
  assert.equal(chatToolAllowed('memory__recall', binding('host'), readonly), true)
  assert.equal(chatToolAllowed('memory__remember', binding('host'), readonly), true)
  assert.equal(chatToolAllowed('memory__forget', binding('host'), readonly), true)
  assert.equal(chatToolAllowed('app__context', binding('query'), readonly), true)
  assert.equal(chatToolAllowed('memory__evidence', binding('query'), readonly), true)
  assert.equal(chatToolAllowed('search__search', binding('delegate', 'search', 'search'), readonly), true)
  assert.equal(chatToolAllowed('mcp__nova_knowledge__recall', binding('delegate', 'knowledge', 'recall'), readonly), true)
})

test('Chat rejects work-creating and scheduling tools even if a stale provider asks for them', () => {
  for (const name of ['dispatch', 'cancel', 'task', 'schedule', 'confirm', 'publish_plan', 'finish_build']) {
    assert.equal(CHAT_DENIED_TOOLS.has(name), true, name)
    assert.equal(chatToolAllowed(name, binding('host'), readonly), false, name)
  }
  assert.equal(chatToolAllowed('watch__start', binding('delegate', 'watch', 'start'), readonly), false)
  assert.equal(chatToolAllowed('unknown__write', binding('delegate', 'unknown', 'write'), readonly), false)
})

test('enter_plan_mode is not a Chat tool anymore', () => {
  assert.equal(chatToolAllowed('enter_plan_mode', binding('host'), readonly), false)
})
