import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as runtime from '@nova-personal-agent/runtime/space-host'
import {RelayClient} from '@nova-personal-agent/relay/client'
import {generateDeviceIdentity, signControl, signEnvelope, encryptBody, generateContentKey} from '@nova-personal-agent/relay/crypto'
import {createSpaceCreateHandler} from '../src/main/space-create.mjs'
import {createTailscaleRelay} from '../src/main/tailscale-relay.mjs'

test('real relay/runtime recover a lost persistence result; pairing and ciphertext survive relay restart',async t=>{
  const root=await mkdtemp(join(realpathSync(tmpdir()),'nova-space-integration-'))
  let loopback, persists=0
  // Only the Tailscale network boundary is simulated; relay, signatures and disk state are real.
  const owner=createTailscaleRelay({directory:()=>join(root,'relay'),
    run:async args=>args[0]==='status'?{BackendState:'Running',Self:{DNSName:'desktop.example.ts.net'},CertDomains:['desktop.example.ts.net']}:{},
    serve:async({target})=>{loopback=target;return {alive:()=>true,close:async()=>{}}}})
  t.after(async()=>{await owner.close();await rm(root,{recursive:true,force:true})})
  const handler=createSpaceCreateHandler({allowed:()=>true,directory:()=>root,configured:()=>false,loadRuntime:async()=>runtime,
    prepareRelay:async()=>({...await owner.ensure(),relayUrl:loopback}),
    persist:async()=>{if(persists++===0)throw Error('simulated settings write failure')}})
  assert.deepEqual(await handler({}, {mode:'tailscale'}),{ok:false,error:'space_create_failed'})
  const original=runtime.readHostSpaceConfig(join(root,'config.json'))
  assert.deepEqual(await handler({}, {mode:'tailscale'}),{ok:true})
  assert.equal(runtime.readHostSpaceConfig(join(root,'config.json')).space,original.space)
  const makeClient=identity=>new RelayClient({url:loopback,space:original.space,device:identity.device,
    signChallenge:c=>signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},identity.signingPrivateKey)})
  const host=makeClient(original.identity), phoneIdentity=await generateDeviceIdentity(),phone=makeClient(phoneIdentity)
  const invitation=await host.createInvitation()
  const payload={v:1,purpose:'pair-request',invitationId:invitation.id,secret:invitation.secret,device:phoneIdentity.device,
    signingPublicKey:phoneIdentity.signingPublicKey,encryptionPublicKey:phoneIdentity.encryptionPublicKey,business_versions:[1]}
  const request=await phone.requestPairing({...payload,proof:await signControl(payload,phoneIdentity.signingPrivateKey)})
  await host.confirmPairing(request.id,'integration-confirm')
  const envelope=await signEnvelope({v:1,space:original.space,id:'durable-restart-message',from:original.identity.device,to:phoneIdentity.device,
    chan:'mailbox',epoch:1,expiresAt:null,body:await encryptBody({text:'synthetic restart test'},generateContentKey())},original.identity.signingPrivateKey)
  await host.send(envelope)
  host.stop();phone.stop();await owner.close()
  await owner.restore('https://desktop.example.ts.net:8443')
  const restored=makeClient(phoneIdentity)
  const page=await restored.read()
  assert.equal(page.messages[0].envelope.id,envelope.id)
  assert.equal(await restored.acknowledge(page.nextCursor),page.nextCursor)
  restored.stop()
})
