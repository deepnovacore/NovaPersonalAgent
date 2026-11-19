import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {clusterCards,titleSimilarity} from '../src/personal-agent/timeline-cluster.js'
import {TimelineBrief,type TimelineInput} from '../src/personal-agent/timeline-brief.js'

interface TestCard {title:string;refs:string[];facts:number[];prior_id?:string;time?:{as_of?:string}}
const card=(title:string,refs:string[],extra:{prior_id?:string;time?:{as_of?:string}}={}):TestCard=>({title,refs,facts:[1,2],...extra})

test('cards fold only when they cite the same message and describe the same matter',()=>{
  const a=card('火山方舟第十批模型将于11月24日14:00下线，需在此前完成迁移',['m1'],{time:{as_of:'2026-10-31'}})
  const b=card('火山方舟第十批模型将于11月24日下线，需在此前完成迁移',['m1'],{time:{as_of:'2026-10-30'}})
  const c=card('火山方舟第十批模型11月24日14:00下线，需在期限前完成',['m1'],{time:{as_of:'2026-10-30'}})
  const otherTopic=card('腾讯云账户欠费险些停服公网IP',['m1'])
  const sameTitleOtherMessage=card('火山方舟第十批模型将于11月24日下线，需在此前完成迁移',['m2'])
  const clusters=clusterCards([b,a,c,otherTopic,sameTitleOtherMessage])
  assert.equal(clusters.length,3)
  const lead=clusters.find(x=>x.members.length===2)!
  assert.equal(lead.leader,a,'the most recent card leads')
  assert.ok(titleSimilarity(a.title,b.title)>0.6&&titleSimilarity(a.title,otherTopic.title)<0.2)
})

test('a card that revises a published card is never folded away, and two revisions never merge',()=>{
  const revised=card('模型迁移安排确认',['m1'],{prior_id:'old-1'}),twin=card('模型迁移安排确认',['m1']),other=card('模型迁移安排确认',['m1'],{prior_id:'old-2'})
  const clusters=clusterCards([twin,revised,other])
  assert.equal(clusters.length,2)
  assert.equal(clusters.find(x=>x.members.length===1)!.leader.prior_id,'old-1','the plain twin folds under the first revision')
})

test('near-identical cards are deleted from the saved state, not just hidden',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-cluster-'))
  const input:TimelineInput={id:'message',version:'v1',kind:'im',text:'Synthetic node is still down',observed_at:'2026-10-17T01:00:00Z',relation:'participant'}
  const base={category:'需要关注',why_now:'Repeated alert needs checking',facts:[{text:'The node is down',quote:'node is still down',ref:'message'}],uncertainty:'',actions:[],refs:['message']}
  const reply={cards:[{...base,title:'Check the node before the deadline'},{...base,title:'Check the node before the deadline today'},{...base,title:'Unrelated billing reminder'}]}
  const path=join(dir,'timeline.json')
  let brief=new TimelineBrief(path,()=>Promise.resolve(reply as never),()=>undefined)
  try{
    await brief.open();brief.update([input],'2026-10-17','UTC');await brief.refresh()
    assert.equal(brief.snapshot().cards.length,2)
    assert.equal((brief.snapshot().cards[0] as {merged_ids?:unknown}).merged_ids,undefined)
    await brief.close()
    brief=new TimelineBrief(path,()=>Promise.resolve({cards:[]}),()=>undefined);await brief.open()
    brief.update([input],'2026-10-17','UTC')
    assert.equal(brief.snapshot().cards.length,2,'the duplicate is gone after restart')
  }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})
