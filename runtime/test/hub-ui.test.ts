import test from 'node:test'
import assert from 'node:assert/strict'
import type {AddressInfo} from 'node:net'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'

test('Hub serves a public console shell while every data endpoint stays authenticated',async()=>{
 const store=new HubStore(':memory:'),server=createHubServer(store)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
 try{
  const page=await fetch(origin)
  assert.equal(page.status,200)
  assert.match(page.headers.get('content-type')??'',/text\/html/)
  assert.match(await page.text(),/Nova Hub/)
  assert.match(page.headers.get('content-security-policy')??'',/default-src 'none'/)
  assert.match(page.headers.get('content-security-policy')??'',/connect-src 'self'/)
  assert.doesNotMatch(page.headers.get('content-security-policy')??'',/unsafe-inline|unsafe-eval/)
  assert.equal(page.headers.get('cache-control'),'no-store')
  assert.equal(page.headers.get('x-content-type-options'),'nosniff')
  for(const [path,type] of [['/hub-ui/style.css','text/css'],['/hub-ui/app.js','text/javascript'],['/hub-ui/icon.svg','image/svg+xml']]){
   const asset=await fetch(origin+path)
   assert.equal(asset.status,200,path)
   assert.ok(asset.headers.get('content-type')?.startsWith(type!),path)
   assert.ok((await asset.text()).length>0,path)
   const head=await fetch(origin+path,{method:'HEAD'})
   assert.equal(head.status,200,path)
   assert.equal(await head.text(),'')
  }
  for(const path of ['/hub/v1/identity','/hub/v1/devices','/hub/v1/tasks','/hub/v1/state','/hub/v1/authority/members']){
   assert.equal((await fetch(origin+path)).status,401,path)
  }
  const {token}=store.enroll('test-account','test console','desktop')
  const headers={authorization:`Bearer ${token}`}
  assert.equal((await fetch(origin+'/hub/v1/devices',{headers})).status,200)
  for(const path of ['/hub-ui/nope.js','/hub-ui/%2e%2e/server.ts','/package.json']){
   assert.equal((await fetch(origin+path,{headers})).status,404,path)
  }
  assert.equal((await fetch(origin,{method:'POST',headers})).status,404)
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close()}
})
