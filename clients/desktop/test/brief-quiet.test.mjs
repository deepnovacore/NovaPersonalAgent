import test from 'node:test'
import assert from 'node:assert/strict'
import {briefQuietConflict} from '../src/renderer/brief-quiet.mjs'
import {refusalText} from '../src/renderer/host-refusals.mjs'
import {setLanguage} from '../src/renderer/locale.mjs'
import {renderDailyBrief} from '../src/renderer/daily-brief-view.mjs'

const params=(extra={})=>({briefing_outlook_enabled:false,briefing_review_enabled:false,briefing_outlook_time:'08:30',briefing_review_time:'18:30',quiet_start:'22:00',quiet_end:'08:00',...extra})

test('the form check agrees with the runtime: only an enabled brief inside quiet hours conflicts',()=>{
 assert.equal(briefQuietConflict(params()),false)
 assert.equal(briefQuietConflict(params({briefing_outlook_enabled:true})),false,'08:30 is after the 08:00 end')
 assert.equal(briefQuietConflict(params({briefing_outlook_enabled:true,briefing_outlook_time:'07:30'})),true)
 assert.equal(briefQuietConflict(params({briefing_outlook_enabled:false,briefing_outlook_time:'07:30'})),false,'a switched-off brief cannot conflict')
 assert.equal(briefQuietConflict(params({briefing_review_enabled:true,briefing_review_time:'23:00'})),true,'inside the part of quiet hours before midnight')
 assert.equal(briefQuietConflict(params({briefing_outlook_enabled:true,briefing_outlook_time:'03:00',quiet_start:'09:00',quiet_end:'09:00'})),false,'equal start and end means no quiet hours')
 assert.equal(briefQuietConflict(params({briefing_review_enabled:true,briefing_review_time:'12:00',quiet_start:'11:00',quiet_end:'13:00'})),true,'a same-day quiet window')
})
test('the refusal has a readable sentence in both languages instead of a raw code',()=>{
 setLanguage('zh-CN');assert.match(refusalText('brief_in_quiet_hours'),/免打扰/)
 setLanguage('en');try{assert.match(refusalText('brief_in_quiet_hours'),/quiet hours/i);assert.doesNotMatch(refusalText('brief_in_quiet_hours'),/[一-鿿]/)}finally{setLanguage('zh-CN')}
})
test('the legacy form refuses to save a conflicting schedule before it reaches the host',async()=>{
 const calls=[];let save;const el=(tag,text)=>({tag,text,children:[],listeners:{},append(){},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn}})
 const fields=renderDailyBrief({settings:{},connected:true,el,card:()=>el('article'),button:(title,action)=>{save=action;return el('button',title)},command:async(...args)=>calls.push(args)})
 fields.briefing_outlook_enabled.checked=true;fields.briefing_outlook_time.value='07:30'
 await assert.rejects(save(),/免打扰/);assert.equal(calls.length,0)
 fields.briefing_outlook_time.value='08:30';await save();assert.equal(calls.length,1)
})
