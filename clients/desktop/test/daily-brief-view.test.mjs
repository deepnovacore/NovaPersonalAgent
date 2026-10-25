import test from 'node:test'
import assert from 'node:assert/strict'
import {renderDailyBrief} from '../src/renderer/daily-brief-view.mjs'
function harness(settings,connected=true){const nodes=[],calls=[];let save
 const el=(tag,text)=>{const node={tag,text,children:[],listeners:{},append(...items){this.children.push(...items)},setAttribute(key,value){this[key]=value},addEventListener(name,fn){this.listeners[name]=fn}};nodes.push(node);return node}
 const fields=renderDailyBrief({settings,connected,el,card:()=>el('article'),button:(title,action,parent)=>{save=action;const b=el('button',title);parent.append(b);return b},command:async(...args)=>calls.push(args)})
 return {fields,nodes,calls,save:()=>save()}
}
test('brief configuration starts disabled with weekdays and quiet hours, and never asks for a time zone',async()=>{
 const h=harness({});assert.equal(h.fields.briefing_outlook_enabled.checked,false);assert.equal(h.fields.briefing_review_enabled.checked,false)
 assert.equal(h.fields.briefing_outlook_time.value,'08:30');assert.equal(h.fields.briefing_review_time.value,'18:30');assert.equal(h.fields.quiet_start.value,'22:00');assert.equal(h.fields.quiet_end.value,'08:00');assert.equal(h.calls.length,0)
 assert.equal(h.fields.timezone,undefined);assert.equal(h.fields.briefing_outlook_time.disabled,true,'a time stays greyed until its switch is on')
 h.fields.briefing_outlook_enabled.checked=true;h.fields.briefing_outlook_enabled.listeners.change();assert.equal(h.fields.briefing_outlook_time.disabled,false);await h.save()
 assert.equal('timezone' in h.calls[0][1],false,'saving never pins the device time zone')
 assert.equal(h.calls[0][0],'discovery.configure');assert.deepEqual(h.calls[0][1].briefing_weekdays,[1,2,3,4,5]);assert.equal(h.calls[0][1].briefing_outlook_enabled,true)
 assert.equal(h.calls[0][1].enabled,undefined)
})
test('existing settings are retained, invalid schedule cannot send, disconnected controls disabled',async()=>{
 const h=harness({briefing_outlook_time:'09:15',briefing_weekdays:[6,7]});assert.equal(h.fields.briefing_outlook_time.value,'09:15');await h.save();assert.deepEqual(h.calls[0][1].briefing_weekdays,[6,7])
 h.fields.quiet_start.value='25:99';await assert.rejects(h.save(),/时间/);assert.equal(h.calls.length,1)
 const disconnected=harness({},false);assert.equal(disconnected.nodes.filter(n=>n.tag==='input'||n.tag==='button').every(n=>n.disabled),true)
})
