import {test} from 'node:test'
import assert from 'node:assert/strict'
import {hiddenTranscriptNotification,taskNotificationText,visibleTranscriptMessages} from '../src/renderer/tasks-page.mjs'
test('historical task notifications use the existing user-facing reason without changing ordinary chat',()=>{
 const text='需要你处理\ncorrection_limit\n请在 Nova 中查看并处理。'
 assert.equal(taskNotificationText({id:'notification:old',text}),'自动修正次数已用完，请决定是否继续')
 assert.equal(taskNotificationText({id:'chat:message',text}),text)
 assert.equal(taskNotificationText({id:'notification:other',text:'需要你处理\n请核对计划'}),'需要你处理\n请核对计划')
})

test('legacy decision notifications are always hidden and progress yields only while a decision is pending',()=>{
 const decision={id:'notification:decision',text:'需要你处理\ncorrection_limit\n请在 Nova 中查看并处理。'}
 const progress={id:'notification:progress',text:'任务进展\n正在运行测试'}
 const alert={id:'notification:alert',text:'Nova 提醒\n喝水'}
 const ordinary={id:'feed:f1',text:'需要你处理\n这是一条普通消息'}
 assert.equal(hiddenTranscriptNotification(decision),true)
 assert.equal(hiddenTranscriptNotification(decision,{decisionPending:false}),true)
 assert.equal(hiddenTranscriptNotification(progress),false,'a lone progress row is still the transcript record')
 assert.equal(hiddenTranscriptNotification(progress,{decisionPending:true}),true)
 assert.equal(hiddenTranscriptNotification(alert),false)
 assert.equal(hiddenTranscriptNotification(ordinary),false,'only host notification rows are filtered')
 assert.deepEqual(visibleTranscriptMessages([decision,progress,alert,ordinary],{decisionPending:true}).map(message=>message.id),['notification:alert','feed:f1'])
})
