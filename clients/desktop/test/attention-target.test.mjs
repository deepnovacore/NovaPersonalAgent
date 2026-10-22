import test from 'node:test'
import assert from 'node:assert/strict'
import {attentionTarget} from '../src/renderer/attention-target.mjs'
const items=[{id:'chat:main',unread_count:1},{id:'c2',unread_count:2}]
test('approvals outrank unread replies and prefer their task',()=>{
 assert.deepEqual(attentionTarget({pending_approvals:[{summary:'x',task_id:'t1',conversation_id:'c9'}],conversations:{items}}),{taskId:'t1'})
 assert.deepEqual(attentionTarget({pending_confirmations:[{summary:'x',conversation_id:'c9'}],conversations:{items}}),{conversationId:'c9'})
})
test('unread falls back to the first unread conversation, where proactive messages live in main',()=>{
 assert.deepEqual(attentionTarget({conversations:{items}}),{conversationId:'chat:main'})
 assert.deepEqual(attentionTarget({conversations:{items:items.slice(1)}}),{conversationId:'c2'})
})
test('nothing pending yields no target',()=>{
 assert.equal(attentionTarget(null),null);assert.equal(attentionTarget({conversations:{items:[{id:'chat:main',unread_count:0}]}}),null)
 assert.equal(attentionTarget({pending_approvals:[{summary:'orphan'}],conversations:{items:[]}}),null)
})
