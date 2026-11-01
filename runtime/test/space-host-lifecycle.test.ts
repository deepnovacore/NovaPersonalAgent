import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {BoundedJsonStore} from '../src/storage/bounded-json.js';

test('a retired transport cursor cannot write over the replacement Host journal',async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-cursor-retired-')),path=join(dir,'journal.json');
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'fixture',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const cursors:Parameters<SpaceHostTransport['start']>[1][]=[];
 const transport=():SpaceHostTransport=>({clients:()=>['phone'],start:(_receive,cursor)=>{cursors.push(cursor);return Promise.resolve(()=>{})},send:()=>Promise.resolve(),stream:()=>Promise.resolve()});
 const old=new SpaceHost({path,space:'fixture-space',host,transport:transport()}),replacement=new SpaceHost({path,space:'fixture-space',host,transport:transport()});
 try{
  await old.open();await cursors[0]!.save(7);
  const queuedSave=cursors[0]!.save(99),retiring=old.close();await queuedSave;await retiring;
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {cursor:number}).cursor,7,'a queued cursor callback must recheck ownership when it runs');
  await replacement.open();
  await replacement.receive('phone',{v:1,type:'intent',op_id:'replacement-only',kind:'snapshot.request',input:{},created_at:Date.now()});
  await cursors[1]!.save(12);
  const before=await readFile(path,'utf8');
  const originalWrite=BoundedJsonStore.prototype.write;let lateWrites=0;
  const watch=t.mock.method(BoundedJsonStore.prototype,'write',function(this:BoundedJsonStore<unknown>,value:unknown){if(this.path===path)lateWrites++;return originalWrite.call(this,value)});
  // This is the old RelayClient's saveCursor after receive rotated keys and replaced its service.
  await cursors[0]!.save(8);
  watch.mock.restore();
  assert.equal(lateWrites,0,'a closed service must perform zero journal writes');
  assert.equal(await readFile(path,'utf8'),before,'the replacement journal must remain byte-for-byte unchanged');
  const journal=JSON.parse(before) as {cursor:number;ops:Record<string,{intent:{op_id:string}}>};
  assert.equal(journal.cursor,12);assert.ok(Object.values(journal.ops).some(op=>op.intent.op_id==='replacement-only'));
 }finally{await replacement.close();await rm(dir,{recursive:true,force:true})}
});
