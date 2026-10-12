import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderNotificationSettings} from '../src/renderer/notification-settings.mjs'
function view(state,feishu={available:true,configured:true,notification_ready:true}){
 const buttons=[],calls=[],nodes=[];const el=(tag,text)=>{const n={tag,text,append(){}};nodes.push(n);return n}
 renderNotificationSettings({state,feishu,local:{},card:()=>el('article'),el,button:(label,action)=>buttons.push({label,action}),command:async(...args)=>calls.push(args),refresh(){}})
 return {buttons,calls,nodes}
}
test('explicit Feishu selection enables outbound before configuring a primary route',async()=>{const v=view({local:true,counts:{},deliveries:[]});assert.equal(v.calls.length,0);await v.buttons.find(b=>b.label==='改为在飞书接收').action();assert.deepEqual(v.calls,[['feishu.notification.configure',{enabled:true}],['notifications.configure',{binding_id:'feishu'}]])})
test('unknown retry requires an explicit duplicate acknowledgement and local fallback is manual',async()=>{const v=view({local:false,counts:{unknown:1},deliveries:[{id:'x',title:'Result',status:'unknown'}]},{available:true,configured:true,notification_ready:true,notification_enabled:true});await v.buttons.find(b=>b.label==='确认可能重复，仍重新发送').action();assert.deepEqual(v.calls,[['notifications.retry',{id:'x',confirm_unknown:true}]]);assert(v.buttons.some(b=>b.label==='改为在 Nova 接收'))})
