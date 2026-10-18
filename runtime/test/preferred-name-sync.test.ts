import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPreferredNameSync} from '../src/personal-agent/preferred-name-sync.js'
import {createIdentityContextSync} from '../src/personal-agent/identity-context.js'

test('committed rename reaches durable settings and a new provider session uses the latest name',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-name-sync-')),memoryPath=join(directory,'memory'),settingsPath=join(directory,'settings')
 try{
  await writeFile(memoryPath,'旧名字');await writeFile(settingsPath,'旧名字');let name='旧名字',epoch=1
  const options={readMemory:()=>readFile(memoryPath,'utf8'),readSettings:()=>name,saveSettings:async (value:string)=>{await writeFile(settingsPath,value);name=value}}
  const sync=createPreferredNameSync(options)
  await sync.commitMemory(async()=>{await writeFile(memoryPath,'新名字');return {state:'committed'}})
  assert.equal(await readFile(settingsPath,'utf8'),'新名字')
  const injected:string[]=[],provider=createIdentityContextSync({identity:()=>({assistant_name:'nova',user_name:name}),epoch:()=>epoch,inject: text=>{try{injected.push((JSON.parse(text) as {user_name:string}).user_name)
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}})
  await provider(new AbortController().signal);epoch++;await provider(new AbortController().signal)
  assert.deepEqual(injected,['新名字','新名字'])
  name='旧缓存';await createPreferredNameSync(options).synchronize();assert.equal(name,'新名字')
 }finally{await rm(directory,{recursive:true,force:true})}
})
test('a failed settings mirror is reported and restart repairs it from durable memory',async()=>{
 let name='旧名字',memory:string|null='旧名字',failed=true
 const options={readMemory:()=>{try{return Promise.resolve(memory)}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},readSettings:()=>name,saveSettings: (value:string)=>{try{if(failed){failed=false;throw Error('disk unavailable')}name=value
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}
 await assert.rejects(createPreferredNameSync(options).commitMemory(()=>{try{memory='新名字'
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}),/disk unavailable/)
 assert.equal(memory,'新名字');assert.equal(name,'旧名字')
 await createPreferredNameSync(options).synchronize();assert.equal(name,'新名字')
})
test('failed memory admission leaves settings unchanged; forgetting clears both without reviving the old name',async()=>{
 let name='旧名字',memory:string|null='旧名字'
 const sync=createPreferredNameSync({readMemory:()=>{try{return Promise.resolve(memory)}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},readSettings:()=>name,saveSettings: (value:string)=>{try{name=value
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}})
 await assert.rejects(sync.commitMemory(()=>{try{throw Error('memory consent required')}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}),/consent/)
 assert.equal(name,'旧名字')
 await sync.commitMemory(()=>{try{memory=null
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}});assert.equal(name,'')
 await sync.synchronize();assert.equal(name,'')
})
test('concurrent renames serialize and unsupported memory does not clear a settings-only profile',async()=>{
 let name='旧名字',memory:string|null='旧名字',release:(()=>void)|undefined
 const sync=createPreferredNameSync({readMemory:()=>{try{return Promise.resolve(memory)}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},readSettings:()=>name,saveSettings: (value:string)=>{try{name=value
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}})
 const first=sync.commitMemory(async()=>{await new Promise<void>(resolve=>{release=resolve});memory='一'})
 await new Promise(resolve=>setImmediate(resolve))
 const second=sync.commitMemory(()=>{try{memory='二'
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}})
 release!();await Promise.all([first,second]);assert.equal(name,'二')
 await createPreferredNameSync({readMemory:()=>{try{return Promise.resolve(undefined)}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},readSettings:()=>name,saveSettings:()=>{try{throw Error('must not write')}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}).synchronize()
 assert.equal(name,'二')
})
