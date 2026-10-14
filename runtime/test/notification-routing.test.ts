import {SuggestionPool} from '../src/core/suggestions.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {progressEvent,realtimeServiceHarness,hostFact} from './support/realtime-service-harness.js'
import type {ProactiveNotice} from '../src/realtime/service-ports.js'
test('external route receives structured progress, retains execution state and queues no speech',async()=>{
 const received:ProactiveNotice[]=[];const {service,queued}=realtimeServiceHarness('projection',{proactiveRouting:{local:()=>false,publish:n=>{received.push(n);return Promise.resolve()}}})
 service.projectRuntimeEvent(progressEvent({seq:1,summary:'running tests',activity:1}));await new Promise(r=>setImmediate(r));assert.equal(queued().length,0);assert.equal(received.length,1);assert.match(received[0]!.body,/running tests/);assert.equal(service.session.delegateState('d-1'),'running')
 service.projectRuntimeEvent(progressEvent({seq:2,summary:'running tests',activity:2}));assert.equal(received.length,1)
})
test('queued local progress is fenced after switch and user-owned host continuation remains available',()=>{
 let local=true;const {service,queuedItems}=realtimeServiceHarness('projection',{proactiveRouting:{local:()=>local,publish:()=>Promise.resolve()}});service.projectRuntimeEvent(progressEvent({seq:1,summary:'tests',activity:1}));const pending=queuedItems()[0]!;assert.equal(pending.stillWanted?.(),true);local=false;assert.equal(pending.stillWanted?.(),false);service.queueHostItem(hostFact('task-continuation'));assert.equal(queuedItems().length,2)
})
test('external result excludes internal task context and synchronous result does not become a notification',async()=>{
 const received:ProactiveNotice[]=[];const route={local:()=>false,publish:(n:ProactiveNotice)=>{received.push(n);return Promise.resolve()}};const f=realtimeServiceHarness('projection',{proactiveRouting:route,delegateOverride:{request:{work_order:'PRIVATE TASK INSTRUCTIONS'}}});f.service.projectRuntimeEvent({kind:'handoff',seq:1,ts:1,payload:{channel:'codex',delegate_id:'d-1',origin_ref:'conversation:1',outcome:'ok',trust:'trusted_system',content:{summary:'Verified result'},refs:[]}});await new Promise(r=>setImmediate(r));assert.equal(received.length,1);assert(!received[0]!.body.includes('PRIVATE TASK INSTRUCTIONS'));assert.equal(f.queued().length,0)
 const sync=realtimeServiceHarness('projection',{proactiveRouting:route,syncResultOps:true,delegateOverride:{op:"look"}});sync.service.projectRuntimeEvent(progressEvent({seq:1,summary:'sync',activity:1}));assert.equal(received.length,1)
})
test('speech selection of an admitted Feed notification does not publish another notice',()=>{
 const received:ProactiveNotice[]=[];const {service,queued}=realtimeServiceHarness('projection',{proactiveRouting:{local:()=>true,publish:n=>{received.push(n);return Promise.resolve()}}});
 service.onSuggestionSelected(new SuggestionPool().add({origin:'surrogate',kind:'notify',content:{summary:'Already admitted',personal_feed_id:'feed-1'},evidence_refs:[],salience:40,expires_at:999999}),{priority:40,origin:null} as Parameters<typeof service.onSuggestionSelected>[1]);assert.equal(received.length,0);assert.equal(queued().length,1)
})

test('deferred progress retains its work lifecycle guard',()=>{
 const received:ProactiveNotice[]=[];const {service}=realtimeServiceHarness('projection',{proactiveRouting:{local:()=>false,publish:n=>{received.push(n);return Promise.resolve()}}});service.projectRuntimeEvent(progressEvent({seq:1,summary:'Queued progress',activity:1}));assert.equal(received[0]?.valid?.(),true);service.session.registerDelegate('d-1',{summary:'Stopped',channel:'codex',state:'failed'});assert.equal(received[0]?.valid?.(),false)
})
