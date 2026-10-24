import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {notificationStore} from '../src/notifications/store.js'
test('notification store retires legacy route field without changing routing or dedupe',async()=>{
 const root=await mkdtemp(join(tmpdir(),'notification-upgrade-')),path=join(root,'state.json')
 const state={schema_version:1 as const,user_scope:'test',route_revision:2,primary_binding_id:'desktop',configured:true,bindings:[],deliveries:[],dedupe:{retained:1},migrated:true,cutoff:100}
 try{for(const legacy_binding_id of [null,'retired']){
  await writeFile(path,JSON.stringify({...state,legacy_binding_id}),{mode:0o600});const store=notificationStore(path)
  assert.deepEqual(await store.read(state),state);await store.write(state);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),state)
 }}finally{await rm(root,{recursive:true,force:true})}
})
