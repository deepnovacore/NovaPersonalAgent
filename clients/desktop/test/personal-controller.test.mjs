import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PersonalController} from '../src/renderer/personal-controller.mjs'
test('text opening, dictation draft and collapsed view share one owner', async () => {
 let starts=0,stops=0; const sent=[]
 const c=new PersonalController({send:f=>(sent.push(f),true),start:async()=>{starts++},stop:async()=>{stops++}})
 c.connect(); c.receive({type:'desktop.capabilities',input_instance_id:'host-A',capabilities:['text_input','dictation']}); assert.equal(starts,0)
 c.draft='original'; await c.dictate(); const id=c.dictationId; await c.finish(); c.receive({type:'input.transcription',id,text:'editable'})
 assert.equal(c.draft,'editable'); assert.equal(sent.some(f=>f.type==='input.text'),false)
 await c.voice(); await c.text(); assert.equal(starts,2); assert.ok(stops>=2)
 c.collapse(true); c.collapse(false); assert.equal(starts,2)
 c.receive({type:'personal.state',revision:2,feed:[],memory:{entries:[]}}); c.receive({type:'personal.state',revision:1,feed:[{id:'old'}]}); assert.equal(c.snapshot.revision,2)
 c.draft='preserved'; c.disconnect(); assert.equal(c.draft,'preserved'); assert.equal(c.connected,false)
})
test('late microphone permission cannot restart cancelled dictation; errors keep editable draft', async()=>{
 let resolveStart;let stops=0;const frames=[]
 const c=new PersonalController({send:f=>(frames.push(f),true),start:()=>new Promise(r=>{resolveStart=r}),stop:async()=>{stops++}})
 c.connect();c.receive({type:'desktop.capabilities',input_instance_id:'host-A',capabilities:['dictation','text_input']});c.draft='keep'
 const starting=c.dictate();await Promise.resolve();await Promise.resolve();await c.finish();resolveStart();await starting
 assert.equal(c.mode,'text');assert.ok(stops>=2);assert.equal(c.draft,'keep')
 c.dictationId='draft';c.receive({type:'input.transcription',id:'draft',error:'recognition_failed'});assert.equal(c.draft,'keep');assert.match(c.error,/recognition_failed/)
 const request=c.command('memory.forget',{id:'x',expected_version:1});const last=frames.at(-1);c.receive({type:'personal.result',request_id:last.request_id,ok:false,error:'version_conflict'});await assert.rejects(request,/version_conflict/)
})
test('only a correlated receipt acknowledges text; captions never do',async()=>{
 const make=()=>{const c=new PersonalController({send:()=>true,start:async()=>{},stop:async()=>{}});c.connect();c.receive({type:'desktop.capabilities',input_instance_id:'host-A',capabilities:['text_input']});return c}
 const c=make();c.draft='repeat';await c.submit();const id=c.submittedRequestId
 c.receive({type:'caption',role:'user',text:'repeat',final:true,sequence:10});assert.equal(c.submittedRequestId,id)
 c.receive({type:'input.text_result',request_id:'old',ok:true});assert.equal(c.submittedRequestId,id)
 assert.equal(await c.submit(),false);c.disconnect();assert.equal(c.draft,'repeat');assert.equal(c.submittedRequestId,id);c.connect();assert.equal(c.submittedRequestId,id);c.receive({type:'input.text_result',request_id:id,ok:true});assert.equal(c.draft,'')
 const confirmed=make();confirmed.draft='accepted';await confirmed.submit();confirmed.receive({type:'input.text_result',request_id:confirmed.submittedRequestId,ok:true});confirmed.disconnect();assert.equal(confirmed.draft,'')
 const failed=make();failed.draft='failed';await failed.submit();failed.draft='next';failed.receive({type:'input.text_result',request_id:failed.submittedRequestId,ok:false,error:'provider unavailable'});assert.equal(failed.draft,'failed\nnext');assert.match(failed.error,/provider unavailable/)
})
test('reconnect retains original request and host instance, replacement outcome stays explicit',async()=>{
 const sent=[];const c=new PersonalController({send:f=>(sent.push(f),true),start:async()=>{},stop:async()=>{}})
 c.connect();c.receive({type:'desktop.capabilities',input_instance_id:'original-host',capabilities:['text_input']});c.draft='do work';await c.submit();const first=sent.at(-1)
 c.disconnect();c.connect();assert.deepEqual(sent.at(-1),first)
 c.receive({type:'desktop.capabilities',input_instance_id:'replacement-host',capabilities:['text_input']});c.disconnect();c.connect();assert.deepEqual(sent.at(-1),first)
 c.receive({type:'input.text_result',request_id:first.request_id,ok:false,error:'outcome_unknown'});assert.equal(c.draft,'do work');assert.match(c.error,/无法确认/)
})
