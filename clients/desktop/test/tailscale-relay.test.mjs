import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as wait} from 'node:timers/promises'
import {createTailscaleRelay, tailscaleEndpoint, assertServePortFree} from '../src/main/tailscale-relay.mjs'

const status = {BackendState:'Running', Self:{DNSName:'desktop.example.ts.net.'}, CertDomains:['desktop.example.ts.net']}
test('Tailscale requires login, a node DNS name and enabled HTTPS; rejects unsafe origins', () => {
  assert.equal(tailscaleEndpoint(status), 'https://desktop.example.ts.net:8443')
  for (const [value, code] of [[{...status, BackendState:'Stopped'},'tailscale_not_running'],
    [{...status, CertDomains:[]},'tailscale_https_required'],
    [{...status, Self:{DNSName:'elsewhere.invalid'}},'tailscale_https_required']])
    assert.throws(() => tailscaleEndpoint(value), {message:code})
})
test('never replaces another Serve or Funnel handler, including foreground sessions', () => {
  assert.doesNotThrow(() => assertServePortFree({TCP:{443:{HTTPS:true}}}))
  for (const config of [{TCP:{8443:{HTTPS:true}}}, {Web:{'desktop.example.ts.net:8443':{Handlers:{}}}},
    {Foreground:{session:{TCP:{8443:{HTTPS:true}}}}}, {AllowFunnel:{'desktop.example.ts.net:8443':true}}])
    assert.throws(() => assertServePortFree(config), {message:'tailscale_port_in_use'})
})
async function harness(t, overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'nova-tailscale-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const calls=[], servers=[]
  const owner=createTailscaleRelay({directory:()=>join(root,'relay'),
    run:async args=>{calls.push(args);return args[0]==='status'?status:{}},
    loadRelay:async()=>({RelayServer:class {
      constructor(options){this.options=options;servers.push(this)}
      async listen(){return 'http://127.0.0.1:34567'}
      async close(){this.closed=true}
    }}),
    serve:async options=>{calls.push(['serve',options]);return {alive:()=>true,close:async()=>calls.push(['stop'])}},
    ...overrides})
  t.after(()=>owner.close())
  return {root,owner,calls,servers}
}
test('automatic credentials stay in memory; repeated starts share one loopback server and persist only the origin',async t=>{
  const h=await harness(t)
  const [a,b]=await Promise.all([h.owner.ensure(),h.owner.ensure()])
  assert.deepEqual(a,b);assert.equal(h.servers.length,1)
  assert.equal(a.relayUrl,'https://desktop.example.ts.net:8443')
  assert.ok(a.bootstrapToken.length>=32)
  const options=h.servers[0].options
  assert.equal(options.bind,'127.0.0.1');assert.equal(options.port,0)
  assert.deepEqual(options.trustedProxyAddresses,['127.0.0.1'])
  const persisted=await readFile(join(h.root,'relay','managed.json'),'utf8')
  assert.deepEqual(JSON.parse(persisted),{v:1,relayUrl:a.relayUrl})
  assert.ok(!persisted.includes(a.bootstrapToken))
  assert.deepEqual(await readdir(join(h.root,'relay')),['managed.json'])
  await h.owner.close();assert.equal(h.servers[0].closed,true)
})
test('failed HTTPS setup closes the listener, returns no provider detail and allows retry',async t=>{
  let fail=true
  const h=await harness(t,{serve:async()=>{if(fail)throw Error('secret provider output');return {alive:()=>true,close:async()=>{}}}})
  await assert.rejects(h.owner.ensure(),{message:'tailscale_serve_failed'})
  assert.equal(h.servers[0].closed,true)
  fail=false;await h.owner.ensure();assert.equal(h.servers.length,2)
})
test('restore uses the original namespace with fresh bootstrap credentials and refuses a changed node name',async t=>{
  const h=await harness(t);const first=await h.owner.ensure();await h.owner.close()
  const restored=await h.owner.restore(first.relayUrl)
  assert.equal(restored.relayUrl,first.relayUrl);assert.notEqual(restored.bootstrapToken,first.bootstrapToken)
  assert.equal(h.servers[0].options.securityPath,h.servers[1].options.securityPath)
  await h.owner.close()
  await assert.rejects(h.owner.restore('https://another.example.ts.net:8443'),{message:'tailscale_identity_changed'})
  assert.equal(h.servers.length,2)
})
test('restore does nothing for a manually configured relay',async t=>{
  const h=await harness(t)
  assert.equal(await h.owner.restore('https://manual.example'),null)
  assert.equal(h.calls.length,0)
})
test('the first setup selects a free port and pins it across restart',async t=>{
  const h=await harness(t,{run:async args=>args[0]==='status'?status:{TCP:{8443:{HTTPS:true}}}})
  const first=await h.owner.ensure()
  assert.equal(first.relayUrl,'https://desktop.example.ts.net:9443')
  await h.owner.close()
  assert.equal((await h.owner.restore(first.relayUrl)).relayUrl,first.relayUrl)
})
test('an exited Serve session is restarted without changing the relay namespace',async t=>{
  let alive=true,starts=0
  const h=await harness(t,{retryMs:10,serve:async()=>{starts++;alive=true;return {alive:()=>alive,close:async()=>{}}}})
  await h.owner.ensure();alive=false
  for(let n=0;n<100&&starts<2;n++)await wait(10)
  assert.equal(starts,2)
  assert.equal(h.servers[0].closed,true)
  assert.equal(h.servers[0].options.securityPath,h.servers[1].options.securityPath)
})
