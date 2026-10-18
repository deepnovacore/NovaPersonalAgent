import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'nova-memory-contract-')),path=join(root,'ledger.sqlite')
 const create=()=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'test',model:'fixture',gateway:{async *stream(){await Promise.reject(Error('no model'))},complete(){throw Error('no model')}},inputConsent:true,conversationProviders:['chat']})
 let memory=create();await memory.open({deferBackground:true})
 return {root,path,get memory(){return memory},async restart(){await memory.close();memory=create();await memory.open({deferBackground:true})},turn:(id:string,text:string)=>memory.beginExplicitTurn({sourceId:id,text,occurredAt:new Date().toISOString()}),async close(){await memory.close();await rm(root,{recursive:true,force:true})}}
}

test('interactive model has remember/recall/evidence without overlapping lookup',()=>{
 const names=compileToolSchema([],{includeExplicitMemory:true,includeMemoryRecall:true}).schemas.map(s=>(s.function as {name:string}).name)
 assert.ok(names.includes('memory__remember'));assert.ok(names.includes('memory__recall'));assert.ok(names.includes('memory__evidence'));assert.ok(!names.includes('memory__lookup'))
})

test('user-scoped facts enter USER and fresh context while general facts stay in memory documents',async()=>{
 const f=await fixture()
 try{
  const turn=await f.turn('one','请记住：我在上海生活，项目代号是 C731')
  await f.memory.writeExplicit(turn,'user',{action:'set',kind:'fact',scope:'user',text:'在上海生活',quote:'我在上海生活'},'chat')
  await f.memory.writeExplicit(turn,'project',{action:'set',kind:'fact',scope:'general',text:'项目代号是 C731',quote:'项目代号是 C731'},'chat')
  const user=await readFile(join(f.path+'.memory','USER.md'),'utf8');assert.match(user,/在上海生活/);assert.doesNotMatch(user,/C731/)
  const context=await f.memory.prepareResponseAdaptation('chat');assert.match(context.memoryContext!.text,/USER\.md/);assert.match(context.memoryContext!.text,/上海/)
  assert.doesNotMatch(JSON.stringify(await f.memory.prepareResponseAdaptation('denied')),/上海|C731/)
 }finally{await f.close()}
})

test('natural recall can find preferred name without knowing the value or slot',async()=>{
 const f=await fixture()
 try{
  const turn=await f.turn('one','请记住叫我 kant')
  await f.memory.writeExplicit(turn,'name',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'},'chat')
  const retrieval=new UnifiedRetrieval({memory:()=>f.memory}),result=await retrieval.recall('我的称呼',{consumer:'chat',scope:'any',limit:8})
  assert.equal(result.entries[0]?.text,'kant')
  const context=(await f.memory.prepareResponseAdaptation('chat')).memoryContext!.text
  assert.ok(context.includes(`entry_id=${JSON.stringify(result.entries[0].entry_id)}`));assert.match(context,/revision=1/);assert.match(context,/slot=preferred_name/)
 }finally{await f.close()}
})

test('forgetting one explicit fact preserves a sibling even when quotes are identical',async()=>{
 const f=await fixture()
 try{
  const quote='叫我 kant，我不吃辣',turn=await f.turn('one',quote)
  await f.memory.writeExplicit(turn,'name',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote},'chat')
  const food=await f.memory.writeExplicit(turn,'food',{action:'set',kind:'preference',text:'不吃辣',quote},'chat')
  const forget=await f.turn('two','忘记我的称呼')
  await f.memory.writeExplicit(forget,'forget',{action:'forget',slot:'preferred_name',quote:'忘记我的称呼'},'chat')
  const current=await f.memory.lookupExplicit({},'chat');assert.equal(current.entries.length,1);assert.equal(current.entries[0]?.id,food.id)
  const context=JSON.stringify(await f.memory.prepareResponseAdaptation('chat'));assert.match(context,/不吃辣/);assert.doesNotMatch(context,/kant/)
  assert.doesNotMatch(await readFile(join(f.path+'.memory','USER.md'),'utf8'),/kant/)
 }finally{await f.close()}
})


test('editing USER updates the same fact immediately and survives a fresh resource',async()=>{
 const f=await fixture()
 try{
  const turn=await f.turn('one','请记住叫我 kant')
  const saved=await f.memory.writeExplicit(turn,'name',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'},'chat')
  const path=join(f.path+'.memory','USER.md');await writeFile(path,(await readFile(path,'utf8')).replace('kant','kay'))
  const context=JSON.stringify(await f.memory.prepareResponseAdaptation('chat'));assert.match(context,/kay/);assert.doesNotMatch(context,/kant/)
  const row=(await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]!;assert.equal(row.id,saved.id);assert.equal(row.version,2)
  await f.restart();assert.match(JSON.stringify(await f.memory.prepareResponseAdaptation('chat')),/kay/)
 }finally{await f.close()}
})
