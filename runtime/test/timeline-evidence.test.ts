import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

test('timeline evidence includes authorized non-mention messages and mail, excludes revoked, foreign and expired originals and versions authorization',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:timeline:',provider='fixture',now=new Date().toISOString()
 const add=(key:string,kind='im',extra:Record<string,unknown>={})=>{
  const source_id=prefix+key
  memoryOperation(db,'append_evidence',JSON.parse(JSON.stringify({id:prefix+'e:'+key,source_id,source_kind:kind,locator:key,raw_text:'Synthetic pending issue',hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'sender',recipient_id:'self',account_id:'account',mention:'none',auto_capture:false},...extra})))
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
 }
 try{
  add('legacy','im',{source_metadata:undefined});add('ordinary');add('mail','mail');add('expired','im',{retention_until:'2000-01-01T00:00:00Z'});add('revoked')
  memoryOperation(db,'source_grant',{source_id:prefix+'revoked',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null}})
  const rows=memoryOperation(db,'timeline_evidence',{source_prefix:prefix,provider,limit:64}) as {id:string}[]
  const first=(rows.find(r=>r.id===prefix+'e:ordinary') as unknown as {hash:string}).hash
  memoryOperation(db,'source_grant',{source_id:prefix+'ordinary',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  const after=memoryOperation(db,'timeline_evidence',{source_prefix:prefix,provider,limit:64}) as {id:string;hash:string}[]
  assert.notEqual(after.find(r=>r.id===prefix+'e:ordinary')!.hash,first,'grant revisions invalidate cached synthesis')
  assert.deepEqual(rows.map(r=>r.id).sort(),[prefix+'e:legacy',prefix+'e:mail',prefix+'e:ordinary'])
  assert.deepEqual(memoryOperation(db,'timeline_evidence',{source_prefix:'personal:other:',provider,limit:64}),[])
  assert.deepEqual(memoryOperation(db,'timeline_evidence',{source_prefix:prefix,provider:'wrong',limit:64}),[])
 }finally{db.close()}
})

test('two-week pool admits thousands of ordinary messages and includes the boundary',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:large:',provider='fixture',source_id=prefix+'chat',now=new Date().toISOString(),since=new Date(Date.now()-14*86400000).toISOString()
 try{
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  for(let i=0;i<1100;i++)memoryOperation(db,'append_evidence',{id:prefix+'e:'+i,source_id,source_kind:'im',locator:String(i),raw_text:'Ordinary message '+i,hash:String(i),observed_at:i===0?since:i===1?new Date(Date.parse(since)-1).toISOString():now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'peer',recipient_id:'self',account_id:'account',chat_id:'chat',mention:'none',auto_capture:false}})
  const rows=memoryOperation(db,'timeline_evidence',{source_prefix:prefix,provider,since,limit:5000}) as {id:string}[]
  assert.equal(rows.length,1099);assert(rows.some(r=>r.id===prefix+'e:0'));assert(!rows.some(r=>r.id===prefix+'e:1'))
 }finally{db.close()}
})
