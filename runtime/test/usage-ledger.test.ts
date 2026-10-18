import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {UsageLedger} from '../src/usage/ledger.js'
import {withUsageContext} from '../src/usage/context.js'
import {beginModelUsage} from '../src/usage/model-call.js'
import type {UsageReport} from '../src/realtime/usage.js'
const report:UsageReport={id:'one',provider:'qwen',service:'llm',model:'qwen3-vl-plus',pricingRegion:'cn-beijing',status:'complete',inputTokens:1000,outputTokens:100,feature:'profile',operation:'draft',runId:'run-1',outcome:'success',durationMs:50}
test('concurrent and delayed reports retain the context captured at dispatch',async()=>{
 const reports:UsageReport[]=[]
 const a=withUsageContext({feature:'profile',runId:'a'},()=>beginModelUsage(r=>reports.push(r),'https://openrouter.ai/api/v1','test'))
 const b=withUsageContext({feature:'timeline',runId:'b'},()=>beginModelUsage(r=>reports.push(r),'https://custom.invalid','test'))
 await Promise.resolve();b({prompt_tokens:2,completion_tokens:3,cost:123},'success');a({prompt_tokens:4,completion_tokens:5,cost:0.001},'success')
 assert.deepEqual(reports.map(r=>[r.feature,r.runId,r.reportedCostUsd]),[['timeline','b',undefined],['profile','a',0.001]])
})
test('runtime ledger deduplicates, retains totals beyond recent detail and restores history',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-usage-'))),path=join(root,'usage.sqlite')
 let ledger=new UsageLedger(path,{recentLimit:2})
 try{
  ledger.add(report);ledger.add(report)
  ledger.add({...report,id:'two',feature:'timeline',runId:'run-2',status:'missing',outcome:'cancelled'})
  ledger.add({...report,id:'three',provider:'openrouter',model:'xiaomi/mimo-v2.6-flash',reportedCostUsd:.002,runId:'run-3'})
  const snapshot=await ledger.snapshot()
  assert.equal(snapshot.history.requests,3)
  assert.equal(snapshot.history.recent.length,2)
  assert.equal(snapshot.history.features.find(r=>r.feature==='profile')?.requests,2)
  assert.equal(snapshot.history.costUsd,.002)
  assert.equal(snapshot.history.costCny,.002)
  assert.equal(snapshot.history.cancelledRequests,1)
  await ledger.close();ledger=new UsageLedger(path,{recentLimit:2})
  assert.equal((await ledger.snapshot()).requests,0)
  assert.equal((await ledger.snapshot()).history.requests,3)
  ledger.add(report)
  assert.equal((await ledger.snapshot()).history.requests,3)
 }finally{await ledger.close();await rm(root,{recursive:true,force:true})}
})
test('invalid ledger is preserved and in-memory metering remains available',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-usage-bad-'))),path=join(root,'usage.sqlite')
 await writeFile(path,'not a database',{mode:0o600})
 const ledger=new UsageLedger(path)
 try{ledger.add(report);const view=await ledger.snapshot();assert.equal(view.requests,1);assert.equal(view.persistenceError,'storage_failed');assert.equal(await readFile(path,'utf8'),'not a database')}
 finally{await ledger.close();await rm(root,{recursive:true,force:true})}
})
