import test from 'node:test'
import assert from 'node:assert/strict'
import {createProactiveNotifyDetector} from '../src/renderer/proactive-notify.mjs'

const message=(id,text,extra={})=>({id,conversation_id:'chat:main',role:'assistant',origin:'proactive',text,created_at:'2026-10-31T10:00:'+id.padStart(2,'0')+'Z',...extra})
const snapshot=(...messages)=>({conversations:{messages,home_messages:[]}})

test('messages already present when the first snapshot arrives are seeded, not announced',()=>{
 const detector=createProactiveNotifyDetector()
 assert.equal(detector.observe(snapshot(message('1','旧提醒')),{connected:true}),null)
 assert.equal(detector.observe(snapshot(message('1','旧提醒')),{connected:true}),null)
})
test('a new unread proactive message becomes one payload with its title and body',()=>{
 const detector=createProactiveNotifyDetector();detector.observe(snapshot(),{connected:true})
 const payload=detector.observe(snapshot(message('2','今天下午评审\n材料还没发')),{connected:true})
 assert.deepEqual(payload,{items:[{id:'2',title:'今天下午评审',body:'材料还没发'}]})
 assert.equal(detector.observe(snapshot(message('2','今天下午评审\n材料还没发')),{connected:true}),null,'announced once')
})
test('several arrivals in one snapshot travel together in time order',()=>{
 const detector=createProactiveNotifyDetector();detector.observe(snapshot(),{connected:true})
 const payload=detector.observe(snapshot(message('4','乙'),message('3','甲')),{connected:true})
 assert.deepEqual(payload.items.map(item=>item.title),['甲','乙'])
})
test('a message with the same title and body is not shown twice over',()=>{
 const detector=createProactiveNotifyDetector();detector.observe(snapshot(),{connected:true})
 assert.deepEqual(detector.observe(snapshot(message('2','任务完成了')),{connected:true}).items,[{id:'2',title:'任务完成了',body:''}])
})
test('read, user, non-proactive and other-conversation messages are ignored',()=>{
 const detector=createProactiveNotifyDetector();detector.observe(snapshot(),{connected:true})
 const rows=[message('2','已读',{read:true}),message('3','我说的',{role:'user'}),{...message('4','普通回复'),origin:undefined},message('5','别处',{conversation_id:'task:1'})]
 assert.equal(detector.observe(snapshot(...rows),{connected:true}),null)
})
test('disconnecting forgets everything so a reconnect seeds again instead of replaying',()=>{
 const detector=createProactiveNotifyDetector();detector.observe(snapshot(),{connected:true})
 assert.equal(detector.observe(null,{connected:false}),null)
 assert.equal(detector.observe(snapshot(message('2','重连前就有')),{connected:true}),null)
 assert.ok(detector.observe(snapshot(message('2','重连前就有'),message('3','之后的')),{connected:true}))
})
test('home messages carried outside the selected conversation count too',()=>{
 const detector=createProactiveNotifyDetector();detector.observe({conversations:{messages:[],home_messages:[]}},{connected:true})
 const payload=detector.observe({conversations:{messages:[],home_messages:[message('2','在主页')]}},{connected:true})
 assert.equal(payload.items[0].title,'在主页')
})
