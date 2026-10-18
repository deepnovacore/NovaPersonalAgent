import test from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'
import type {AddressInfo} from 'node:net'
test('explicit operator recovery retires the exact missing primary and cannot downgrade while another PC exists',()=>{
 const hub=new HubStore(':memory:');try{
  const old=hub.enroll('s','old','desktop'),pc=hub.enroll('s','new','desktop'),phone=hub.enroll('s','phone','mobile')
  hub.authority.initialize(old.token)
  assert.throws(()=>hub.authority.recover('s',{retired_device_id:old.device_id,target_device_id:phone.device_id,expected_epoch:1,transition_id:'recover'}),/pc_primary_required/)
  const recovered=hub.authority.recover('s',{retired_device_id:old.device_id,target_device_id:pc.device_id,expected_epoch:1,transition_id:'recover'})
  assert.equal(recovered.authority_epoch,2)
  assert.deepEqual(hub.authority.recover('s',{retired_device_id:old.device_id,target_device_id:pc.device_id,expected_epoch:1,transition_id:'recover'}),recovered)
  assert.throws(()=>hub.authority.validatePublisher(old.token,1),/unauthorized/)
  assert.throws(()=>hub.authority.recover('s',{retired_device_id:pc.device_id,target_device_id:phone.device_id,expected_epoch:1,transition_id:'stale'}),/stale_authority/)
  const independent=hub.authority.recover('s',{retired_device_id:pc.device_id,target_device_id:phone.device_id,expected_epoch:2,transition_id:'no-pc'})
  assert.equal(independent.mode,'mobile_primary')
 }finally{hub.close()}
})

test('authority HTTP requires authenticated enrollment and validates transition bodies', async () => {
 const hub=new HubStore(':memory:'),server=createHubServer(hub)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1/authority`
 const phone=hub.enroll('space','phone','mobile'),pc=hub.enroll('space','pc','desktop')
 const call=(token:string,path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
 try {
  assert.equal((await fetch(url)).status,401)
  assert.equal((await call(phone.token,'/initialize',{})).status,200)
  assert.equal((await call(pc.token,'/prepare',{expected_epoch:1,target_device_id:pc.device_id,transition_id:'steal'})).status,403)
  assert.equal((await call(phone.token,'/prepare',{expected_epoch:1,target_device_id:pc.device_id,transition_id:'bind'})).status,200)
  assert.equal((await call(phone.token,'/commit',{transition_id:'bind',acknowledged:[pc.device_id]})).status,400)
  assert.equal((await call(phone.token,'/commit',{transition_id:'bind'})).status,409)
  assert.equal((await call(pc.token,'/ack',{transition_id:'bind'})).status,200)
  assert.equal((await call(phone.token,'/commit',{transition_id:'bind'})).status,200)
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));hub.close()}
})

test('space publication remains PC-owned across disconnects and rejects mobile overwrite', () => {
 const hub = new HubStore(':memory:')
 try {
  const phone = hub.enroll('space', 'Phone', 'mobile')
  const pc = hub.enroll('space', 'PC', 'desktop')
  const initial = hub.authority.initialize(phone.token)
  assert.equal(initial.primary_device_id, phone.device_id)
  const transfer = hub.authority.prepare(phone.token, {expected_epoch:1, target_device_id:pc.device_id, transition_id:'bind-pc'})
  assert.equal(transfer.pending?.target_device_id, pc.device_id)
  assert.ok(transfer.membership_revision>initial.membership_revision)
  assert.throws(() => hub.authority.validatePublisher(phone.token, 1), /authority_transition/)
  assert.throws(() => hub.authority.commit(phone.token, 'bind-pc'), /handoff_incomplete/)
  hub.authority.acknowledge(pc.token, 'bind-pc')
  const bound = hub.authority.commit(phone.token, 'bind-pc')
  assert.equal(bound.authority_epoch, 2)
  assert.equal(bound.mode, 'pc_primary')
  assert.throws(() => hub.authority.validatePublisher(phone.token, 2), /publisher_required/)
  hub.authority.validatePublisher(pc.token, 2)
  assert.equal(hub.authority.snapshot(phone.token)?.primary_device_id, pc.device_id)
  assert.throws(() => hub.authority.prepare(phone.token, {expected_epoch:2,target_device_id:phone.device_id,transition_id:'steal'}), /primary_required/)
  assert.equal(hub.authority.commit(phone.token, 'bind-pc').authority_epoch, 2)
 } finally { hub.close() }
})

test('new PC does not seize ownership; transfer is fenced and revoked owner needs explicit recovery', () => {
 const hub = new HubStore(':memory:')
 try {
  const one=hub.enroll('space','PC1','desktop'), two=hub.enroll('space','PC2','desktop')
  const phone=hub.enroll('space','phone','mobile'), outsider=hub.enroll('other','Other','desktop')
  hub.authority.initialize(one.token)
  assert.equal(hub.authority.initialize(two.token).primary_device_id,one.device_id)
  assert.throws(()=>hub.authority.prepare(one.token,{expected_epoch:1,target_device_id:phone.device_id,transition_id:'downgrade'}),/pc_primary_required/)
  hub.authority.prepare(one.token,{expected_epoch:1,target_device_id:two.device_id,transition_id:'transfer'})
  assert.throws(()=>hub.authority.acknowledge(outsider.token,'transfer'),/transition_not_found/)
  hub.authority.acknowledge(two.token,'transfer')
  hub.authority.commit(one.token,'transfer')
  assert.throws(()=>hub.authority.validatePublisher(one.token,1),/stale_authority/)
  assert.throws(()=>hub.authority.prepare(two.token,{expected_epoch:1,target_device_id:one.device_id,transition_id:'stale'}),/stale_authority/)
  hub.revoke('space',two.device_id)
  assert.throws(()=>hub.authority.initialize(phone.token),/recovery_required/)
  assert.equal(hub.authority.snapshot(phone.token)?.primary_device_id,two.device_id)
 } finally { hub.close() }
})
