import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

test('prior recipe profile is reported as needing an update without exposing or migrating its content',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:profile-update:',provider='fixture',products=()=>memoryOperation(db,'source_processing',{prefix,provider,action:'products'}) as {profile_needs_update:boolean;draft:unknown;sources:unknown[]}
 const old=JSON.stringify({generation_version:'understanding-v7',draft:{about:{text:'Private previous profile',refs:[]},work:[],interests:[]},refs:[]})
 try{
  assert.equal(products().profile_needs_update,false)
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:other:','old-recipe',1,old)
  assert.equal(products().profile_needs_update,false,'another user scope does not count')
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run(prefix,'old-recipe',1,old)
  const current=products();assert.equal(current.profile_needs_update,true);assert.equal(current.draft,null);assert.deepEqual(current.sources,[])
  assert.equal(db.prepare('SELECT payload_json FROM processing_profiles WHERE prefix=?').get(prefix)?.payload_json,old,'old cache is retained verbatim')
 }finally{db.close()}
})
