import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PersonalAgentHost} from '../src/personal-agent/host.js';
import {displaySnapshot} from '../src/space-host/projection.js';

const portrait=(text:string)=>({about:{text,refs:[{entry_id:'private-source',version:1}]},work:[{title:'Current work',text:'Work summary',refs:[{entry_id:'private-work',version:1}]}],interests:[{text:'Interest',refs:[{entry_id:'private-interest',version:1}]}]});
function project(profile:{about:string;version:number},preparation:Record<string,unknown>){
 const host={options:{memory:()=>undefined},snapshot:()=>({revision:1,profile_preparation:{status:'ready',...preparation},timeline:{cards:[]},feed:[]}),life:{snapshot:()=>({profile,goals:[],todos:[],ideas:[]})},notifications:{display:()=>[]},spaceChatMessages:()=>[]} as unknown as PersonalAgentHost;
 return displaySnapshot(host);
}
test('profile presentation uses the current portrait while preserving legacy editable manual state',()=>{
 const original={about:'',version:0},snapshot=project(original,{draft:portrait('Current portrait'),last_success:{draft:portrait('Old portrait')}});
 assert.equal(snapshot.profile,original);
 assert.deepEqual(snapshot.profile_presentation,{about:'Current portrait',work:[{title:'Current work',text:'Work summary'}],interests:['Interest'],source:'current'});
 assert.equal(JSON.stringify(snapshot).includes('private-'),false);
 assert.equal(JSON.stringify(snapshot).includes('refs'),false);
});
test('explicit manual text or clear wins over current and saved portraits',()=>{
 for(const about of ['Manual introduction','']){
  const original={about,version:2},snapshot=project(original,{draft:portrait('Current portrait'),last_success:{draft:portrait('Old portrait')}});
  assert.equal(snapshot.profile,original);
  assert.deepEqual(snapshot.profile_presentation,{about,work:[],interests:[],source:'manual'});
 }
});
test('a stale successful portrait remains readable while an unavailable update has no current draft',()=>{
 const snapshot=project({about:'',version:0},{status:'failed',draft:null,last_success:{draft:portrait('Last good portrait'),sources:[{id:'private-source',label:'Private source'}]}});
 assert.equal(snapshot.profile_presentation?.about,'Last good portrait');
 assert.equal(snapshot.profile_presentation?.source,'last_success');
 assert.equal(JSON.stringify(snapshot).includes('private-'),false);
 assert.deepEqual(project({about:'',version:0},{draft:null}).profile_presentation,{about:'',work:[],interests:[],source:'empty'});
});
test('profile presentation bounds every text and collection without copying extra inferred fields',()=>{
 const draft={about:{text:'a'.repeat(6000),refs:['secret']},work:Array.from({length:10},()=>({title:'t'.repeat(100),text:'w'.repeat(1000),private:'secret'})),interests:Array.from({length:12},()=>({text:'i'.repeat(200),private:'secret'})),private:'secret'};
 const value=project({about:'',version:0},{draft}).profile_presentation!;
 assert.equal(value.about.length,5000);assert.equal(value.work.length,6);assert.equal(value.work[0]!.title.length,80);assert.equal(value.work[0]!.text.length,500);assert.equal(value.interests.length,8);assert.equal(value.interests[0]!.length,100);assert.equal(JSON.stringify(value).includes('secret'),false);
});


test('shared mobile pages receive real timeline structure and conversation metadata without private sources or execution paths',()=>{
 const host={options:{memory:()=>undefined},snapshot:()=>({revision:1,profile_preparation:{status:'idle'},timeline:{updated_at:'2026-11-01T07:00:00Z',cards:[{id:'card',title:'A real progress card',kind:'progress',version:'v1',category:'Project',status_label:'In progress',why_now:'A new milestone',facts:[{label:'Progress',tone:'positive',text:'Done',quote:'PRIVATE_QUOTE',ref:'PRIVATE_REF'}],next_steps:[{title:'Review',detail:'Check output'}],actions:[{label:'Ask about it',kind:'discuss',prompt:'PRIVATE_PROMPT'},{label:'Bad',kind:'execute'}],time:{anchor_date:'2026-11-01',artifact_scope:'PRIVATE_SCOPE'},sources:['PRIVATE_SOURCE']}]},conversations:{items:[{id:'chat:1',kind:'chat',title:'Saved task',last_message:'Latest reply',created_at:'2026-11-01T07:00:00Z',updated_at:'2026-11-01T07:01:00Z',mode:'chat',build:{status:'paused',project:'PRIVATE_PATH',approval:{preview:'PRIVATE_COMMAND'}}}]},feed:[]}),life:{snapshot:()=>({profile:{about:'',version:0},goals:[],todos:[],ideas:[]})},notifications:{display:()=>[]},spaceChatMessages:()=>[]} as unknown as PersonalAgentHost;
 const value=displaySnapshot(host);
 assert.deepEqual(value.timeline_entries?.[0],{key:'card',kind:'timeline',text:'A real progress card',observed_at:'2026-11-01T07:00:00Z',time:{anchor_date:'2026-11-01'},evidence_ids:[],brief:{title:'A real progress card',category:'Project',status_label:'In progress',facts:[{label:'Progress',tone:'positive',text:'Done'}],why_now:'A new milestone',next_steps:[{title:'Review',detail:'Check output'}],actions:[{label:'Ask about it',kind:'discuss'}],uncertainty:''}});
 assert.deepEqual(value.timeline_available_evidence_ids,[]);
 assert.equal(value.conversations?.[0]?.preview,'Latest reply');assert.equal(value.conversations?.[0]?.build_status,'paused');
 assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);
});

test('timeline projection normalizes legacy future placement and carries temporal kind and basis',()=>{
 for(const kind of ['scheduled','deadline'] as const){
  const planned=kind==='scheduled'?'2026-12-11':'2026-11-24'
  const time={kind,anchor_basis:kind,anchor_date:planned,occurred_on:null,started_on:null,due_on:kind==='deadline'?planned:null,scheduled_on:kind==='scheduled'?planned:null,last_reported_on:'2026-10-28',evidence_from:'2026-10-28',evidence_to:'2026-10-28',as_of:'2026-11-02'}
  const host={options:{memory:()=>undefined},snapshot:()=>({revision:1,profile_preparation:{status:'idle'},timeline:{cards:[{id:'legacy',time}]},feed:[]}),life:{snapshot:()=>({profile:{about:'',version:0},goals:[],todos:[],ideas:[]})},notifications:{display:()=>[]},spaceChatMessages:()=>[]} as unknown as PersonalAgentHost
  const value=displaySnapshot(host)
  assert.equal(value.timeline[0]?.date,'2026-10-28')
  assert.deepEqual(value.timeline_entries?.[0]?.time,{...time,anchor_date:'2026-10-28',anchor_basis:'reported'})
  assert.equal(time.anchor_date,planned,'projection must not mutate saved history')
 }
})
