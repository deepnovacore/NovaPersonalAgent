import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import './helpers/space-host-sync-open.js'

const waitScheduled=()=>new Promise(resolve=>setTimeout(resolve,160));

test('unchanged Host notifications skip scheduled snapshots per recipient while explicit recovery stays forced',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-snapshot-dedupe-'));
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const sent:{to:string;body:Record<string,unknown>}[]=[];let owner='phone';
 const transport:SpaceHostTransport={clients:()=>['phone','tablet'],start:()=>Promise.resolve(()=>{}),send:(to,body)=>{sent.push({to,body});return Promise.resolve()},stream:()=>Promise.resolve()};
 const space=new SpaceHost({path:join(dir,'space.json'),space:'test',host,transport,owner:()=>owner});
 const snapshots=(to:string)=>sent.filter(row=>row.to===to&&row.body.type==='snapshot');
 try{
  await host.open({deferBackground:true});await space.open();
  assert.equal(snapshots('phone').length,1);assert.equal(snapshots('tablet').length,1);
  host.connectionChanged();host.connectionChanged();await waitScheduled();await space.flush();
  assert.equal(snapshots('phone').length,1);assert.equal(snapshots('tablet').length,1);
  await space.publishSnapshot('phone');assert.equal(snapshots('phone').length,2);
  await space.receive('phone',{v:1,type:'intent',op_id:'recover',kind:'snapshot.request',input:{},created_at:Date.now()});
  assert.equal(snapshots('phone').length,3);
  host.connectionChanged();await waitScheduled();await space.flush();assert.equal(snapshots('phone').length,3);
  await space.receive('phone',{v:1,type:'intent',op_id:'change',kind:'life.mutate',input:{op:'create',kind:'goal',title:'Visible change'},created_at:Date.now()});
  await waitScheduled();await space.flush();
  assert.equal(snapshots('phone').length,4);assert.equal(snapshots('tablet').length,2);
  const snapshot=snapshots('tablet').at(-1)!.body.snapshot as {goals:{title:string}[]};assert.equal(snapshot.goals[0]!.title,'Visible change');
  owner='tablet';host.connectionChanged();await waitScheduled();await space.flush();
  assert.equal(snapshots('phone').length,5);assert.equal(snapshots('tablet').length,3);
  assert.equal((snapshots('phone').at(-1)!.body.snapshot as {owner:boolean}).owner,false);
  assert.equal((snapshots('tablet').at(-1)!.body.snapshot as {owner:boolean}).owner,true);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('unchanged scheduled snapshots still retry a durable pending delivery without requeueing it',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-snapshot-retry-'));
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 let offline=true;const attempts:string[]=[];
 const transport:SpaceHostTransport={clients:()=>['phone'],start:()=>Promise.resolve(()=>{}),send:(_to,_body,id)=>{attempts.push(id);return offline?Promise.reject(Error('offline')):Promise.resolve()},stream:()=>Promise.resolve()};
 const path=join(dir,'space.json'),space=new SpaceHost({path,space:'test',host,transport});
 try{
  await host.open({deferBackground:true});await space.open();
  const before=JSON.parse(await readFile(path,'utf8')) as {outbox:{id:string}[]};assert.equal(before.outbox.length,1);
  host.connectionChanged();await waitScheduled();await space.flush();
  const pending=JSON.parse(await readFile(path,'utf8')) as {outbox:{id:string}[]};assert.deepEqual(pending.outbox.map(row=>row.id),before.outbox.map(row=>row.id));assert.equal(new Set(attempts).size,1);
  offline=false;host.connectionChanged();await waitScheduled();await space.flush();
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {outbox:unknown[]}).outbox.length,0);assert.equal(new Set(attempts).size,1);
  await space.publishSnapshot('phone');assert.equal(new Set(attempts).size,2);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});


test('offline snapshots stay bounded and preserve operation receipts across restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-snapshot-bounded-'));
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const path=join(dir,'space.json');let offline=true;const delivered:Record<string,unknown>[]=[];
 const transport:SpaceHostTransport={clients:()=>['phone'],start:()=>Promise.resolve(()=>{}),send:(_to,body)=>{if(offline)return Promise.reject(Error('offline'));delivered.push(body);return Promise.resolve()},stream:()=>Promise.resolve()};
 let space=new SpaceHost({path,space:'test',host,transport});
 try{
  await host.open({deferBackground:true});await space.open();
  await space.receive('phone',{v:1,type:'intent',op_id:'recover',kind:'snapshot.request',input:{},created_at:Date.now()});
  for(let n=0;n<12;n++)await space.publishSnapshot('phone');
  const pending=JSON.parse(await readFile(path,'utf8')) as {outbox:{body:{type:string}}[]};
  assert.equal(pending.outbox.filter(row=>row.body.type==='snapshot').length,1);
  assert.equal(pending.outbox.filter(row=>row.body.type==='receipt').length,1);
  await space.close();space=new SpaceHost({path,space:'test',host,transport});offline=false;await space.open();
  assert.equal(delivered.filter(body=>body.type==='snapshot').length,1);
  assert.equal(delivered.filter(body=>body.type==='receipt').length,1);
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {outbox:unknown[]}).outbox.length,0);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});
