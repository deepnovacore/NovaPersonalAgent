import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

const prefix='personal:context:',provider='fixture-provider'
interface Item {evidence_id:string;stamp:string;start:number;end:number}
interface Batch {id:string;items:Item[]}

test('repeats of one observation across batches merge their refs instead of dropping the later copies',()=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const process=(value:Record<string,unknown>):unknown=>memoryOperation(db,'source_processing',{prefix,provider,...value})
  const add=(key:string,text:string)=>{
    const source_id=prefix+'source:'+key,id=prefix+'e:'+key,now=new Date().toISOString()
    memoryOperation(db,'append_evidence',{id,source_id,source_kind:'file',locator:key,raw_text:text,hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external'})
    memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
    return id
  }
  try{
    const a=add('a','I write the test before the code.'),b=add('b','Tests first again for the next change.')
    const batch=process({action:'claim'}) as Batch,owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
    process({action:'bind',...owner});process({action:'evidence',...owner,refs:batch.items})
    const ref=(id:string)=>batch.items.find(item=>item.evidence_id===id)!
    process({action:'observe',...owner,refs:batch.items,observations:[
      {kind:'style',text:'Writes tests first.',refs:[ref(a)]},
      {kind:'style',text:'writes tests first',refs:[ref(b)]},
    ]})
    const context=process({action:'profile_context',...owner}) as {observations:{text:string;refs:Item[]}[];refs:Item[]}
    assert.equal(context.observations.length,1)
    assert.deepEqual(new Set(context.observations[0]!.refs.map(item=>item.evidence_id)),new Set([a,b]))
    assert.deepEqual(new Set(context.refs.map(item=>item.evidence_id)),new Set([a,b]))
  }finally{db.close()}
})

interface Context {key:string;observations:{text:string;refs:Item[]}[];refs:Item[];items:{text:string;evidence_id:string}[]}
const harness=()=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const process=(value:Record<string,unknown>):unknown=>memoryOperation(db,'source_processing',{prefix,provider,...value})
  let clock=Date.parse('2026-01-01T00:00:00Z'),revision=0
  const add=(key:string,text:string)=>{
    const source_id=prefix+'source:'+key,id=prefix+'e:'+key,now=new Date(clock+=1000).toISOString()
    memoryOperation(db,'append_evidence',{id,source_id,source_kind:'file',locator:key,raw_text:text,hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external'})
    memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
    return id
  }
  // Drains every pending batch, one observe call per batch, and returns the last batch's profile context.
  const drain=(text:string):Context=>{
    let last:Context|null=null
    for(let index=0;index<40;index++){
      const claimed=process({action:'claim'}) as Batch|null
      if(!claimed)break
      const owner={batch_id:claimed.id,task_id:'task:'+claimed.id,run_id:'run:'+claimed.id}
      process({action:'bind',...owner});process({action:'evidence',...owner,refs:claimed.items})
      process({action:'observe',...owner,refs:claimed.items,observations:[{kind:'style',text,refs:claimed.items.slice(0,8)}]})
            last=process({action:'profile_context',...owner}) as Context
      process({action:'publish',...owner,expected_revision:revision++,draft:{about:null,work:[],interests:[]},refs:claimed.items})
      process({action:'commit',...owner,topics:[{title:'Planning',summary:'Index only.',refs:claimed.items}]})
    }
    assert.ok(last,'at least one batch was processed')
    return last
  }
  return {db,add,drain}
}

test('an observation that exceeds the character budget is included partially, newest first, instead of skipped',()=>{
  const {db,add,drain}=harness()
  try{
    for(let i=0;i<13;i++)add('big'+String(i).padStart(2,'0'),'x'.repeat(4000))
    const context=drain('Plans first.')
    assert.equal(context.observations.length,1,'the merged observation is not skipped wholesale')
    const chars=context.items.reduce((total,item)=>total+item.text.length,0)
    assert.ok(chars<=48000&&chars>=44000,'as many slices as fit are taken, got '+chars)
    assert.equal(new Set(context.observations[0]!.refs.map(item=>item.evidence_id)).size,context.refs.length,'distinct originals only')
    assert.ok(context.refs.length>=11&&context.refs.length<13)
    assert.ok(context.refs.some(item=>item.evidence_id===prefix+'e:big12'),'the newest original is kept')
  }finally{db.close()}
})

test('a heavily repeated observation keeps an even sample plus its newest ref, and a newer repeat changes the key',()=>{
  const {db,add,drain}=harness()
  try{
    for(let i=0;i<24;i++)add('old'+String(i).padStart(2,'0'),'Old note '+i+'.')
    const first=drain('Writes tests first.')
    assert.equal(first.observations.length,1)
    const fresh=add('fresh','New note.')
    const second=drain('Writes tests first.')
    const refs=second.observations[0]!.refs.map(item=>item.evidence_id)
    assert.equal(new Set(refs).size,refs.length)
    assert.ok(refs.length<=24)
    assert.ok(refs.includes(fresh),'the newest ref is always selected')
    assert.ok(refs.includes(prefix+'e:old00'),'the oldest history stays represented in the spread')
    assert.notEqual(second.key,first.key,'a newer ref changes the synthesis key')
  }finally{db.close()}
})

test('observations recorded by separate observe calls in separate batches merge at the batch boundary',()=>{
  const {db,add,drain}=harness()
  try{
    for(let i=0;i<10;i++)add('note'+String(i).padStart(2,'0'),'Note '+i+' about plans.')
    const context=drain('Plans first.')
    assert.equal(context.observations.length,1)
    assert.equal(new Set(context.observations[0]!.refs.map(item=>item.evidence_id)).size,10,'refs from both batches are in the one merged observation')
  }finally{db.close()}
})
