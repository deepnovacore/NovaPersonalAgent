import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createConversation,markConversationRead,conversationUnreadCount,conversationSchema,initialConversations} from '../src/personal-agent/conversations.js'
test('proactive read receipt does not consume later messages or revive trimmed history',()=>{
 const c=createConversation('chat','主对话',null,'chat:main')
 const message=(id:string)=>({id,conversation_id:c.id,role:'assistant' as const,origin:'proactive' as const,text:id,created_at:new Date().toISOString()})
 c.messages.push(message('one'),message('two'))
 markConversationRead(c,'one');assert.equal(conversationUnreadCount(c),1)
 c.messages.push(message('three'));markConversationRead(c,'one');assert.equal(conversationUnreadCount(c),2)
 markConversationRead(c,'two');c.messages.shift();assert.equal(conversationUnreadCount(conversationSchema.parse(c)),1)
 assert.throws(()=>markConversationRead(c,'absent'),/message_not_found/)
})
test('only proactive or scheduled assistant messages count as unread; replies to the user never do',()=>{
 const c=createConversation('chat','主对话',null,'chat:main'),at=new Date().toISOString()
 c.messages.push({id:'u',conversation_id:c.id,role:'user',text:'hi',created_at:at},{id:'r',conversation_id:c.id,role:'assistant',reply_to:'u',text:'reply',created_at:at})
 assert.equal(conversationUnreadCount(c),0)
 c.messages.push({id:'p',conversation_id:c.id,role:'assistant',origin:'proactive',text:'reminder',created_at:at})
 c.messages.push({id:'s',conversation_id:c.id,role:'assistant',schedule_ref:{schedule_id:'s',revision:1,run_id:'run'},text:'scheduled',created_at:at})
 assert.equal(conversationUnreadCount(c),2)
})
test('a fresh state has only the main conversation and rejects the removed proactive kind',()=>{
 assert.deepEqual(initialConversations().items.map(item=>item.id),['chat:main'])
 assert.throws(()=>conversationSchema.parse({...createConversation('chat','x'),kind:'proactive'}))
})

test('new conversations default to Chat and assistant tool traces are bounded',()=>{
 const c=createConversation('chat','新对话',null,'new-chat'),at=new Date().toISOString()
 assert.equal(c.mode??'chat','chat')
 c.messages.push({id:'a',conversation_id:c.id,role:'assistant',text:'reply',created_at:at,tool_trace:[{name:'memory__recall',state:'ok',summary:'2 条'}]})
 assert.equal(conversationSchema.parse(c).messages[0]!.tool_trace?.[0]?.name,'memory__recall')
 assert.throws(()=>conversationSchema.parse({...c,messages:[{id:'a',conversation_id:c.id,role:'assistant',text:'x',created_at:at,tool_trace:Array.from({length:17},()=>({name:'memory__recall',state:'ok',summary:''}))}]}))
})
