import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash,randomBytes} from 'node:crypto'
import {HubStore} from '../src/hub/store.js'

const url='https://nova.example.ts.net'
const request=(invite:{code:string;hub_id:string;account_id:string})=>({code:invite.code,hub_id:invite.hub_id,account_id:invite.account_id,device_name:'My phone'})
test('pairing invitation persists only its hash, survives restart, and redeems exactly once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-pairing-')),path=join(dir,'hub.sqlite')
 let store=new HubStore(path)
 try{
  const invite=store.createInvitation('alice',url)
  assert.equal(invite.type,'nova.hub');assert.equal(invite.version,1)
  assert.equal(Buffer.from(invite.code,'base64url').length,32)
  assert.ok(invite.expires_at>Date.now());assert.ok(invite.expires_at<=Date.now()+300000)
  store.close()
  assert.ok(!readFileSync(path).includes(Buffer.from(invite.code)))
  const db=new DatabaseSync(path)
  const rows=db.prepare('SELECT * FROM hub_invitations').all();db.close()
  assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(invite.code))
  store=new HubStore(path)
  const device=store.redeemInvitation(request(invite))
  assert.equal(device.device_name,'My phone');assert.equal(device.hub_id,invite.hub_id)
  assert.equal(Buffer.from(device.token,'base64url').length,32)
  assert.equal(store.identity(device.token).account_id,'alice')
  assert.equal(store.listDevices('alice')[0]?.device_name,'My phone')
  assert.equal(store.listDevices('alice')[0]?.kind,'mobile')
  assert.throws(()=>store.redeemInvitation(request(invite)),/invalid_pairing/)
  store.revoke('alice',device.device_id)
  assert.throws(()=>store.identity(device.token),/unauthorized/)
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
test('refresh, cancel, exact expiry boundary and identity mismatch leave no usable stale invitation',()=>{
 let now=1000
 const store=new HubStore(':memory:',{now:()=>now})
 try{
  const first=store.createInvitation('alice',url),second=store.createInvitation('alice',url)
  assert.throws(()=>store.redeemInvitation(request(first)),/invalid_pairing/)
  assert.throws(()=>store.redeemInvitation({...request(second),hub_id:'wrong'}),/pairing_identity_mismatch/)
  assert.throws(()=>store.redeemInvitation({...request(second),account_id:'bob'}),/pairing_identity_mismatch/)
  store.cancelInvitation('alice')
  assert.throws(()=>store.redeemInvitation(request(second)),/invalid_pairing/)
  const third=store.createInvitation('alice',url);now=third.expires_at
  assert.throws(()=>store.redeemInvitation(request(third)),/invalid_pairing/)
  now=third.expires_at-1
  assert.equal(store.redeemInvitation(request(third)).account_id,'alice')
 }finally{store.close()}
})
test('device capacity includes CLI enrollment and failed redemption rolls back invitation consumption',()=>{
 const store=new HubStore(':memory:')
 try{
  const first=store.enroll('alice','Desktop','desktop')
  for(let i=1;i<32;i++)store.enroll('alice',`device ${i}`)
  const invite=store.createInvitation('alice',url)
  assert.throws(()=>store.enroll('alice','too many'),/device_capacity/)
  assert.throws(()=>store.redeemInvitation(request(invite)),/device_capacity/)
  assert.equal(store.listDevices('alice').length,32)
  store.revoke('alice',first.device_id)
  assert.equal(store.redeemInvitation(request(invite)).device_name,'My phone')
  assert.equal(store.listDevices('alice').filter(d=>!d.revoked).length,32)
  assert.equal(store.listDevices('bob').length,0)
 }finally{store.close()}
})
test('invitations require an exact HTTPS Tailscale origin',()=>{
 const store=new HubStore(':memory:')
 try{
  for(const bad of ['http://nova.example.ts.net','https://ts.net','https://evilts.net','https://a.ts.net.evil.test','https://user@a.ts.net','https://@a.ts.net','https://a.ts.net/path','https://a.ts.net/?x','https://a.ts.net/#x','https://a..ts.net','https://-a.ts.net','https://a_.ts.net','https://a.ts.net/../',' https://a.ts.net'])assert.throws(()=>store.createInvitation('alice',bad),/invalid_hub_url/,bad)
  assert.equal(store.createInvitation('alice','https://nova.example.ts.net/').url,url)
 }finally{store.close()}
})

test('legacy device schema migrates without losing existing credentials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-migrate-')),path=join(dir,'hub.sqlite'),token=randomBytes(32).toString('base64url')
 const db=new DatabaseSync(path)
 db.exec('CREATE TABLE hub_devices(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,device_id TEXT NOT NULL,epoch INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,device_id))')
 db.prepare('INSERT INTO hub_devices VALUES(?,?,?,?,0)').run(createHash('sha256').update(token).digest('hex'),'legacy','legacy-phone',1)
 db.close()
 const store=new HubStore(path)
 try{
  assert.equal(store.identity(token).device_id,'legacy-phone')
  assert.deepEqual(store.listDevices('legacy'),[{device_id:'legacy-phone',device_name:'Device',kind:'unknown',device_epoch:1,revoked:false}])
  const added=store.enroll('legacy','Named desktop','desktop')
  assert.equal(store.listDevices('legacy')[1]?.device_name,added.device_name)
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
