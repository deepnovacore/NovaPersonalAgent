import test from 'node:test'
import assert from 'node:assert/strict'
import {createProactiveNotifyDetector} from '../src/renderer/proactive-notify.mjs'

const SEEDED=Date.parse('2026-10-31T09:59:00Z')
const create=(now=SEEDED)=>createProactiveNotifyDetector({now:()=>now})
const message=(id,text,extra={})=>({id,conversation_id:'chat:main',role:'assistant',origin:'proactive',text,created_at:'2026-10-31T10:00:'+id.padStart(2,'0')+'Z',...extra})
const snapshot=(...messages)=>({conversations:{messages,home_messages:[]}})
const connected={connected:true}

test('messages already present when the first snapshot arrives are seeded, not announced',()=>{
 const d=create(Date.parse('2026-10-31T10:30:00Z'))
 assert.equal(d.observe(snapshot(message('1','旧提醒')),connected),null)
 assert.equal(d.observe(snapshot(message('1','旧提醒')),connected),null)
})
test('a new unread proactive message becomes one payload with its title and body',()=>{
 const d=create();d.observe(snapshot(),connected)
 assert.deepEqual(d.observe(snapshot(message('2','今天下午评审\n材料还没发')),connected),{items:[{id:'2',title:'今天下午评审',body:'材料还没发'}]})
 assert.equal(d.observe(snapshot(message('2','今天下午评审\n材料还没发')),connected),null,'announced once')
})
test('several arrivals in one snapshot travel together in time order',()=>{
 const d=create();d.observe(snapshot(),connected)
 assert.deepEqual(d.observe(snapshot(message('4','乙'),message('3','甲')),connected).items.map(item=>item.title),['甲','乙'])
})
test('a message with only a title has an empty body',()=>{
 const d=create();d.observe(snapshot(),connected)
 assert.deepEqual(d.observe(snapshot(message('2','任务完成了')),connected).items,[{id:'2',title:'任务完成了',body:''}])
})
test('read, user, non-proactive and other-conversation messages are ignored',()=>{
 const d=create();d.observe(snapshot(),connected)
 const rows=[message('2','已读',{read:true}),message('3','我说的',{role:'user'}),{...message('4','普通回复'),origin:undefined},message('5','别处',{conversation_id:'task:1'})]
 assert.equal(d.observe(snapshot(...rows),connected),null)
})
test('disconnecting forgets everything so a reconnect seeds again instead of replaying',()=>{
 let now=SEEDED;const d=createProactiveNotifyDetector({now:()=>now});d.observe(snapshot(),connected)
 assert.equal(d.observe(null,{connected:false}),null)
 now=Date.parse('2026-10-31T10:00:30Z')
 assert.equal(d.observe(snapshot(message('2','重连前就有')),connected),null)
 assert.ok(d.observe(snapshot(message('2','重连前就有'),message('40','之后的')),connected))
})
test('home messages carried outside the selected conversation count too',()=>{
 const d=create();d.observe({conversations:{messages:[],home_messages:[]}},connected)
 assert.equal(d.observe({conversations:{messages:[],home_messages:[message('2','在主页')]}},connected).items[0].title,'在主页')
})
test('history that a truncated first snapshot left out is not announced when it appears later',()=>{
 // Another conversation is selected at start, so chat:main arrives through the byte-limited home_messages: the oldest
 // unread proactive message is dropped. Selecting chat:main moves the full history into messages.
 const d=create(Date.parse('2026-10-31T10:30:00Z'))
 const old=message('1','昨晚的提醒'),recent=message('9','刚才的提醒')
 assert.equal(d.observe({conversations:{messages:[],home_messages:[recent]}},connected),null,'what the first snapshot holds is seeded')
 assert.equal(d.observe({conversations:{messages:[old,recent],home_messages:[]}},connected),null,'the older unread message is history, not an arrival')
})
test('a message created after the connection was seeded is announced even when it first appears alongside history',()=>{
 const d=create(Date.parse('2026-10-31T10:30:00Z'))
 d.observe({conversations:{messages:[],home_messages:[message('9','刚才的提醒')]}},connected)
 const fresh=message('59','刚到的',{created_at:'2026-10-31T10:30:20Z'})
 assert.deepEqual(d.observe({conversations:{messages:[message('1','昨晚的提醒'),message('9','刚才的提醒'),fresh],home_messages:[]}},connected).items.map(item=>item.id),['59'])
})
