import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PersonalController} from '../src/renderer/personal-controller.mjs'
function harness({start,autoVoice=true}={}){
 let starts=0,stops=0,revision=0;const sent=[];let c
 function snapshot(selected='a',voice=null){c.receive({type:'personal.state',revision:++revision,feed:[],memory:{entries:[]},conversations:{selected_id:selected,voice_id:voice,items:[{id:'a',kind:'chat',title:'A'},{id:'b',kind:'chat',title:'B'},{id:'proactive',kind:'proactive',title:'主动提醒'}],messages:[]}})}
 c=new PersonalController({send:frame=>{sent.push(frame);if(autoVoice&&frame.method==='conversations.voice')queueMicrotask(()=>{snapshot(c.selectedId,frame.params.enabled?frame.params.id:null);c.receive({type:'personal.result',request_id:frame.request_id,ok:true})});return true},start:async()=>{starts++;await start?.()},stop:async()=>{stops++}})
 c.connect();c.receive({type:'desktop.capabilities',input_instance_id:'host-A',capabilities:['text_input','dictation']});snapshot()
 return {c,sent,snapshot,get starts(){return starts},get stops(){return stops}}
}
test('opening and changing text conversations never starts capture; drafts stay scoped',()=>{
 const h=harness();h.c.draft='A draft';h.snapshot('b');assert.equal(h.c.draft,'');h.c.draft='B draft';h.snapshot('a');assert.equal(h.c.draft,'A draft');assert.equal(h.starts,0)
 const revision=h.c.snapshot.revision;h.c.receive({type:'personal.state',revision:revision-1,conversations:{selected_id:'stale'}});assert.equal(h.c.selectedId,'a')
})
test('two text conversations send concurrently and receipts affect only their own drafts',async()=>{
 const {c,sent,snapshot}=harness();c.draft='A request';await c.submit();const a=sent.at(-1);assert.equal(a.conversation_id,'a')
 snapshot('b');c.draft='B request';await c.submit();const b=sent.at(-1);assert.equal(b.conversation_id,'b');assert.notEqual(a.request_id,b.request_id)
 c.receive({type:'caption',conversation_id:'a',role:'user',text:'A request',final:true});assert.ok(c.state('a').submission)
 c.receive({type:'input.text_result',request_id:a.request_id,conversation_id:'a',ok:false,error:'A failed'});assert.equal(c.state('a').draft,'A request');assert.equal(c.state('b').draft,'');assert.equal(c.error,'')
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'a',ok:true});assert.ok(c.state('b').submission)
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'b',ok:true});assert.equal(c.state('b').submission,null)
})
test('voice owner blocks own text and all dictation, other text does not stop or steal capture',async()=>{
 const h=harness();await h.c.voice();assert.equal(h.starts,1);assert.equal(h.c.voiceId,'a');h.c.draft='blocked';assert.equal(await h.c.submit(),false)
 h.snapshot('b','a');h.c.draft='parallel text';const stops=h.stops;assert.equal(await h.c.submit(),true);assert.equal(h.stops,stops);assert.equal(h.c.mode,'voice')
 await assert.rejects(h.c.dictate(),/结束持续对话/);await assert.rejects(h.c.voice(),/结束当前语音/);assert.equal(h.starts,1)
 h.c.collapse(true);h.c.collapse(false);assert.equal(h.stops,stops);assert.equal(h.c.voiceId,'a')
 await h.c.stopVoice();assert.equal(h.c.voiceId,null);assert.equal(h.c.mode,'text')
})
test('dictation result returns to original conversation and never sends text',async()=>{
 const {c,snapshot,sent}=harness();c.draft='A old';await c.dictate();const id=c.dictationId;await c.finish();snapshot('b');c.draft='B keep'
 c.receive({type:'input.transcription',id,conversation_id:'a',text:'A editable'});assert.equal(c.draft,'B keep');assert.equal(c.state('a').draft,'A old\nA editable');assert.equal(sent.some(frame=>frame.type==='input.text'),false)
})
test('release during permission wait cancels capture; recognition error preserves draft',async()=>{
 let resolveStart;const h=harness({start:()=>new Promise(resolve=>{resolveStart=resolve})});h.c.draft='keep';const pending=h.c.dictate();await Promise.resolve();await h.c.finish();resolveStart();await pending
 assert.equal(h.c.mode,'text');assert.ok(h.stops>=1);assert.equal(h.c.draft,'keep')
 h.c.dictationId='draft';h.c.dictationConversationId='a';h.c.receive({type:'input.transcription',id:'draft',error:'recognition_failed'});assert.equal(h.c.draft,'keep');assert.match(h.c.error,/recognition_failed/)
})
test('reconnect replays every pending request with original conversation and host instance',async()=>{
 const {c,sent,snapshot}=harness();c.draft='A request';await c.submit();const a=sent.at(-1);snapshot('b');c.draft='B request';await c.submit();const b=sent.at(-1)
 c.disconnect();c.connect();assert.deepEqual(sent.slice(-2),[a,b]);c.receive({type:'desktop.capabilities',input_instance_id:'replacement',capabilities:['text_input']});c.disconnect();c.connect();assert.deepEqual(sent.slice(-2),[a,b])
 c.receive({type:'input.text_result',request_id:a.request_id,conversation_id:'a',ok:true});assert.equal(c.state('a').draft,'')
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'b',ok:false,error:'outcome_unknown'});assert.equal(c.state('b').draft,'B request');assert.match(c.state('b').error,/无法确认/)
})
test('rejected command remains an observable failure',async()=>{
 const {c,sent}=harness();const pending=c.command('memory.forget',{id:'x',expected_version:1});c.receive({type:'personal.result',request_id:sent.at(-1).request_id,ok:false,error:'version_conflict'});await assert.rejects(pending,/version_conflict/)
})
test('pending voice claim gates its text before host state arrives; host release stops capture',async()=>{
 const h=harness({autoVoice:false});const claim=h.c.voice();h.c.draft='not mixed';assert.equal(await h.c.submit(),false)
 const request=h.sent.at(-1);h.snapshot('a','a');h.c.receive({type:'personal.result',request_id:request.request_id,ok:true});await claim;assert.equal(h.c.mode,'voice')
 const stops=h.stops;h.snapshot('a',null);assert.equal(h.c.mode,'text');assert.equal(h.stops,stops+1)
})

test('dictation rejects wrong conversation and preserves draft when finish cannot send',async()=>{
 const {c}=harness();c.draft='keep';await c.dictate();const id=c.dictationId
 c.receive({type:'input.transcription',id,conversation_id:'b',text:'wrong'});assert.equal(c.draft,'keep');assert.equal(c.dictationId,id)
 c.send=()=>false;await c.finish();assert.equal(c.mode,'text');assert.equal(c.draft,'keep');assert.match(c.error,/发送失败/)
})
test('empty transcription cannot erase the editable draft',async()=>{
 const {c}=harness();c.draft='keep';await c.dictate();const id=c.dictationId;await c.finish();c.receive({type:'input.transcription',id,text:''});assert.equal(c.draft,'keep');assert.match(c.error,/recognition_failed/)
})

test('late microphone permission cannot stop a newer capture',async()=>{
 let release;const h=harness({start:()=>new Promise(resolve=>{release=resolve})});const pending=h.c.dictate();await Promise.resolve();await h.c.text();await assert.rejects(h.c.dictate(),/结束持续对话/);release();await pending;assert.equal(h.c.mode,'text');assert.equal(h.starts,1)
})
