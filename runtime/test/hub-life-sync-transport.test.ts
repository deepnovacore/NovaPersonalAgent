import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {AddressInfo} from 'node:net'
import {createServer} from 'node:http'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'
import {LifeSyncTransport,HubResponseError,saveHubCredentials,loadHubCredentials} from '../src/hub/life-sync-transport.js'

test('sync transport uses private separate credentials and returns bounded validated snapshots',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'hub-sync-'))),store=new HubStore(':memory:'),server=createHubServer(store)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const credentials={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:store.enroll('alice','desktop').token}
 try{
  assert.equal(await loadHubCredentials(join(dir,'absent')),null)
  const path=join(dir,'credentials')
  await saveHubCredentials(path,credentials)
  assert.deepEqual(await loadHubCredentials(path),credentials)
  if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600)
  assert.match(await readFile(path,'utf8'),/token/)
  const client=new LifeSyncTransport(credentials)
  assert.equal((await client.snapshot()).cursor,0)
  const first=await client.mutate({op_id:'first',input:{op:'create',kind:'todo',title:'First'}})
  assert.equal(first.result.version,1)
  assert.equal((await client.changes(0)).events.length,1)
  await assert.rejects(client.mutate({op_id:'stale',input:{op:'update',kind:'todo',id:first.result.id,expected_version:0,title:'Stale'}}),error=>error instanceof HubResponseError&&error.code==='version_conflict'&&error.snapshot?.cursor===1)
  const invalid=new LifeSyncTransport({...credentials,token:'a'.repeat(43)})
  await assert.rejects(invalid.snapshot(),error=>error instanceof Error&&error.message==='unauthorized'&&!error.message.includes(credentials.token))
  assert.throws(()=>new LifeSyncTransport({...credentials,url:'http://example.com'}),/hub_url_invalid/)
  assert.throws(()=>new LifeSyncTransport({...credentials,url:'https://user:secret@example.com'}),/hub_url_invalid/)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(dir,{recursive:true,force:true})}
})


test('sync transport does not follow redirects or expose response/error secrets',async()=>{
 let requests=0
 const token='a'.repeat(43)
 const server=createServer((_req,res)=>{requests++;res.writeHead(302,{location:'/secret-'+token});res.end(token)})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const client=new LifeSyncTransport({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token})
  await assert.rejects(client.snapshot(),error=>error instanceof Error&&error.message==='hub_transport_failed'&&!String(error).includes(token))
  assert.equal(requests,1)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
