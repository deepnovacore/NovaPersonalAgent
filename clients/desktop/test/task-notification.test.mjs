import {test} from 'node:test'
import assert from 'node:assert/strict'
import {taskNotificationText} from '../src/renderer/tasks-page.mjs'
test('historical task notifications use the existing user-facing reason without changing ordinary chat',()=>{
 const text='需要你处理\ncorrection_limit\n请在 Nova 中查看并处理。'
 assert.equal(taskNotificationText({id:'notification:old',text}),'自动修正次数已用完，请决定是否继续')
 assert.equal(taskNotificationText({id:'chat:message',text}),text)
 assert.equal(taskNotificationText({id:'notification:other',text:'需要你处理\n请核对计划'}),'需要你处理\n请核对计划')
})
