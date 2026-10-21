import test from 'node:test'
import assert from 'node:assert/strict'

const posixService={skip:process.platform==='win32'?'LaunchAgent service fixtures require POSIX ownership and Unix sockets':false}

const status = {BackendState:'Running',Self:{DNSName:'mac.example.ts.net.'}}
const mapping = {TCP:{'8443':{HTTPS:true}},Web:{'mac.example.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:8787'}}}}}

test('Hub network validates exact Serve mapping and leaves port 443 independent', async () => {
 const {inspectHubNetwork} = await import('../src/main/hub-network.mjs')
 assert.equal(inspectHubNetwork(status,mapping).url,'https://mac.example.ts.net:8443')
 assert.equal(inspectHubNetwork(status,{TCP:{'443':{HTTPS:true}},Web:{'mac.example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}}).state,'needs_serve')
 assert.equal(inspectHubNetwork(status,{...mapping,AllowFunnel:{'mac.example.ts.net:8443':true}}).state,'public_endpoint')
 const shadow=structuredClone(mapping);shadow.Web['mac.example.ts.net:8443'].Handlers['/hub']={Proxy:'http://127.0.0.1:9999'}
 assert.equal(inspectHubNetwork(status,shadow).state,'conflict')
 assert.equal(inspectHubNetwork(status,{TCP:{'8443':{HTTPS:true}}}).state,'conflict')
 assert.equal(inspectHubNetwork(status,null).state,'unavailable')
 assert.equal(inspectHubNetwork({BackendState:'Running',Self:{DNSName:'evil.example'}},{}).state,'needs_login')
})

test('LaunchAgent uses owned executable and escapes plist paths without secrets', async () => {
 const {hubLaunchPlist} = await import('../src/main/hub-service.mjs')
 const xml=hubLaunchPlist({label:'ai.nova.hub.test',executable:'/Applications/Nova & Co.app/Contents/MacOS/Nova',entry:'/app/runtime/managed-entry.js',dataDir:'/private/test/hub'})
 assert.match(xml,/Nova &amp; Co/);assert.match(xml,/ELECTRON_RUN_AS_NODE/);assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);assert.match(xml,/<key>KeepAlive<\/key><true\/>/)
 assert.doesNotMatch(xml,/token|API_KEY/)
})

test('closing a panel invalidates an in-flight invitation and never returns its QR', async () => {
 const {createHubConnection}=await import('../src/main/hub-connection.mjs')
 let release,cancelled=0
 const service={status:async()=>({running:true}),enable:async()=>{},admin:async frame=>{
  if(frame.action==='invite')return new Promise(resolve=>{release=resolve})
  if(frame.action==='cancel')cancelled++
  if(frame.action==='devices')return {devices:[]}
  return {invitation_active:true}
 }}
 const connection=createHubConnection({service,network:async()=>({state:'ready',url:'https://mac.example.ts.net:8443'}),renderQr:async()=> 'data:image/png;base64,test'})
 const opening=connection.action('refresh');await new Promise(resolve=>setImmediate(resolve))
 const closing=connection.action('cancel');release({expires_at:Date.now()+300000})
 assert.equal((await opening).image,undefined);await closing;assert.ok(cancelled>0)
})

test('Hub IPC is settings-sender bound and blocked during acceptance', async () => {
 const {installHubIpc}=await import('../src/main/hub-integration.mjs')
 let handler,calls=0;const sender={}
 const ipcMain={handle:(_channel,fn)=>{handler=fn}}
 installHubIpc({ipcMain,getSender:()=>sender,action:async()=>{calls++;return {state:'ready'}},enabled:()=>true})
 assert.equal((await handler({sender:{}},'enable')).state,'unavailable')
 assert.equal((await handler({sender},'enable')).state,'ready');assert.equal(calls,1)
 installHubIpc({ipcMain,getSender:()=>sender,action:async()=>{calls++},enabled:()=>false})
 assert.equal((await handler({sender},'enable')).state,'unsupported');assert.equal(calls,1)
})

test('network configuration and removal touch only the verified Hub port', async () => {
 const {createHubNetwork}=await import('../src/main/hub-network.mjs')
 const calls=[];let configured=false
 const network=createHubNetwork({binary:'/fake/tailscale',run:async args=>{
  calls.push(args)
  if(args[0]==='status')return {stdout:JSON.stringify(status)}
  if(args[1]==='status')return {stdout:JSON.stringify(configured?mapping:{})}
  configured=args.at(-1)!=='off';return {stdout:''}
 }})
 assert.equal((await network('configure')).created,true)
 assert.equal((await network('remove')).removed,true)
 assert.deepEqual(calls.filter(args=>args.includes('--bg')), [['serve','--bg','--https=8443','http://127.0.0.1:8787'],['serve','--bg','--https=8443','http://127.0.0.1:8787','off']])
})

test('LaunchAgent survives app recreation, upgrades once, stops persistently and keeps data', posixService, async () => {
 const {createHubService}=await import('../src/main/hub-service.mjs')
 const {mkdtemp,readFile,writeFile,access,rm}=await import('node:fs/promises')
 const root=await mkdtemp('/tmp/nova-hub-service-');let running=false,starts=0
 const run=async(_exe,args)=>{
  if(args[0]==='print'&&!running)throw Error('missing')
  if(args[0]==='bootstrap'){running=true;starts++}
  if(args[0]==='bootout')running=false
  return {stdout:''}
 }
 const adminRequest=async()=>{if(!running)throw Error('offline');return {hub_id:'stable'}}
 const options={homeDir:root,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/Applications/Nova.app/runtime/managed-entry.js',appVersion:'1',run,adminRequest}
 try{
  const first=createHubService(options);await first.enable();await first.enable();assert.equal(starts,1)
  await writeFile(`${first.dataDir}/sentinel`,'keep')
  const next=createHubService({...options,appVersion:'2'});await next.restore();assert.equal(starts,2)
  assert.equal((await next.status()).hub_id,'stable');await next.stop();assert.equal(running,false)
  await next.restore();assert.equal(running,false)
  await assert.rejects(access(`${root}/Library/LaunchAgents/${next.label}.plist`))
  await next.enable();assert.equal(starts,3);await next.remove()
  assert.equal(await readFile(`${first.dataDir}/sentinel`,'utf8'),'keep')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('failed service bootstrap does not leave an enabled login job', posixService, async () => {
 const {createHubService}=await import('../src/main/hub-service.mjs')
 const {mkdtemp,access,rm}=await import('node:fs/promises')
 const root=await mkdtemp('/tmp/nova-hub-service-fail-')
 const service=createHubService({homeDir:root,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/app/managed-entry.js',appVersion:'1',run:async()=>{throw Error('launchctl_failure')},adminRequest:async()=>{throw Error('offline')}})
 try{
  await assert.rejects(service.enable())
  assert.equal((await service.status()).enabled,false)
  await assert.rejects(access(`${root}/Library/LaunchAgents/${service.label}.plist`))
 }finally{await rm(root,{recursive:true,force:true})}
})

for (const action of ['stop','remove']) {
 test(`${action} cancels pairing and disables service despite network cleanup failure`, async () => {
  const {createHubConnection}=await import('../src/main/hub-connection.mjs')
  for (const networkState of ['unavailable','needs_login','conflict','public_endpoint','throws']) {
   let owned=true;const calls=[]
   const service={
    admin:async frame=>{calls.push(frame.action)},
    networkOwned:async value=>{if(value!==undefined)owned=value;return owned},
    [action]:async()=>{calls.push(action)},
   }
   const connection=createHubConnection({service,network:async()=>{
    calls.push('network')
    if(networkState==='throws')throw Error('offline')
    return {state:networkState}
   }})
   const view=await connection.action(action)
   assert.equal(view.state,'idle',networkState)
   assert.equal(view.network_cleanup_pending,true,networkState)
   assert.equal(view.installed,action==='stop',networkState)
   assert.equal(owned,true,'failed cleanup must retain ownership')
   assert.ok(calls.indexOf('cancel')>=0 && calls.indexOf('cancel')<calls.indexOf(action),'cancel before stopping')
   assert.ok(calls.indexOf(action)<calls.indexOf('network'),'stop must not wait on network cleanup')
  }
 })
}

test('successful cleanup clears its ownership record after stopping', async () => {
 const {createHubConnection}=await import('../src/main/hub-connection.mjs')
 let owned=true
 const service={admin:async()=>{},stop:async()=>{},networkOwned:async value=>{if(value!==undefined)owned=value;return owned}}
 const connection=createHubConnection({service,network:async()=>({state:'needs_serve',removed:true})})
 const view=await connection.action('stop')
 assert.equal(view.state,'idle');assert.equal(view.installed,true)
 assert.equal(view.network_cleanup_pending,false);assert.equal(owned,false)
})

for (const action of ['stop','remove']) {
 test(`pending startup restore cannot undo ${action}`, posixService, async () => {
  const {createHubService}=await import('../src/main/hub-service.mjs')
  const {mkdtemp,access,rm}=await import('node:fs/promises')
  const root=await mkdtemp('/tmp/nova-hub-race-')
  let running=false,hold=false,release,reached;const calls=[]
  const held=new Promise(resolve=>{reached=resolve})
  const run=async(_exe,args)=>{
   calls.push(args[0])
   if(args[0]==='print'){
    if(hold){hold=false;reached();await new Promise(resolve=>{release=resolve})}
    if(!running)throw Error('missing')
   }
   if(args[0]==='bootstrap')running=true
   if(args[0]==='bootout')running=false
   return {stdout:''}
  }
  const options={homeDir:root,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/app/hub.js',appVersion:'1',run,
   adminRequest:async(_socket,frame)=>{if(!running)throw Error('offline');calls.push(frame.action);return {hub_id:'stable'}}}
  try{
   await createHubService(options).enable()
   const service=createHubService({...options,appVersion:'2'})
   hold=true;const restoring=service.restore();await held
   const stopping=service[action]()
   // Old code completes stop while restore is suspended; serialized code waits.
   await Promise.race([stopping,new Promise(resolve=>setTimeout(resolve,40))])
   release();await Promise.all([restoring,stopping])
   assert.equal(running,false)
   assert.equal((await service.status()).enabled,false)
   assert.equal((await service.status()).installed,action==='stop')
   await service.restore();assert.equal(running,false)
   await assert.rejects(access(`${root}/Library/LaunchAgents/${service.label}.plist`))
   assert.ok(calls.lastIndexOf('cancel')<calls.lastIndexOf('bootout') && calls.lastIndexOf('cancel')>=0,'cancel persisted invitation before shutdown')
  }finally{release?.();await rm(root,{recursive:true,force:true})}
 })
}

test('enable rejects a loaded foreign label without an ownership manifest', posixService, async () => {
 const {createHubService}=await import('../src/main/hub-service.mjs')
 const {mkdtemp,access,rm}=await import('node:fs/promises')
 const root=await mkdtemp('/tmp/nova-hub-foreign-');const calls=[]
 let running=false
 const service=createHubService({homeDir:root,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/app/hub.js',appVersion:'1',
  run:async(_exe,args)=>{calls.push(args[0]);if(args[0]==='bootstrap')running=true;return {stdout:''}},
  adminRequest:async()=>{if(!running)throw Error('offline');return {}}})
 try{
  await assert.rejects(service.enable(),/hub_service_conflict/)
  assert.deepEqual(calls,['print'])
  await assert.rejects(access(`${service.dataDir}/service.json`))
  await assert.rejects(access(`${root}/Library/LaunchAgents/${service.label}.plist`))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('service rejects socket paths beyond the managed runtime limit before launch', posixService, async () => {
 const {createHubService}=await import('../src/main/hub-service.mjs')
 const {mkdtemp,rm}=await import('node:fs/promises')
 const root=await mkdtemp('/tmp/nova-hub-path-')
 const suffix='/.nova/hub-desktop/admin.sock'
 const homeDir=`${root}/${'x'.repeat(101-Buffer.byteLength(root)-1-Buffer.byteLength(suffix))}`
 let running=false;const calls=[]
 const service=createHubService({homeDir,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/app/hub.js',appVersion:'1',
  run:async(_exe,args)=>{calls.push(args[0]);if(args[0]==='print'&&!running)throw Error('missing');if(args[0]==='bootstrap')running=true;return {stdout:''}},
  adminRequest:async()=>{if(!running)throw Error('offline');return {}}})
 try{
  await assert.rejects(service.enable(),/hub_path_too_long/)
  assert.deepEqual(calls,[])
 }finally{await rm(root,{recursive:true,force:true})}
})

test('device revocation remains available when Tailscale is offline', async () => {
 const {createHubConnection}=await import('../src/main/hub-connection.mjs')
 let revoked=false
 const connection=createHubConnection({service:{status:async()=>({running:true}),admin:async frame=>{
  if(frame.action==='revoke')revoked=true
  if(frame.action==='devices')return {devices:[{device_id:'device',device_name:'Phone',revoked:false}]}
  return {}
 }},network:async()=>({state:'needs_login'})})
 const result=await connection.action('revoke','device')
 assert.equal(revoked,true);assert.equal(result.devices.length,1)
})

test('pending network cleanup stays visible after service removal and polling', async () => {
 const {createHubConnection}=await import('../src/main/hub-connection.mjs')
 const connection=createHubConnection({service:{status:async()=>({running:false,enabled:false,installed:false}),networkOwned:async()=>true},network:async()=>({state:'unavailable'})})
 assert.equal((await connection.action('status')).network_cleanup_pending,true)
})

test('upgrade waits until launchd removes a terminating job before bootstrap', posixService, async () => {
 const {createHubService}=await import('../src/main/hub-service.mjs')
 const {mkdtemp,rm}=await import('node:fs/promises')
 const root=await mkdtemp('/tmp/nova-launchd-')
 let running=false,terminating=0,starts=0
 const run=async(_exe,args)=>{
  if(args[0]==='print'){
   if(terminating>0){terminating--;return {stdout:'state = SIGTERMed'}}
   if(!running)throw Error('missing')
  }
  if(args[0]==='bootout'){running=false;terminating=2}
  if(args[0]==='bootstrap'){
   if(terminating>0)throw Error('job_still_loaded')
   running=true;starts++
  }
  return {stdout:''}
 }
 const options={homeDir:root,executable:'/Applications/Nova.app/Contents/MacOS/Nova',entry:'/app/hub.js',appVersion:'1',run,
  adminRequest:async()=>{if(!running)throw Error('socket_closed');return {hub_id:'stable'}}}
 try{
  await createHubService(options).enable()
  const upgraded=createHubService({...options,appVersion:'2'})
  await upgraded.restore()
  assert.equal(starts,2);assert.equal((await upgraded.status()).hub_id,'stable')
  await upgraded.stop();assert.equal(terminating,0);assert.equal(running,false)
 }finally{await rm(root,{recursive:true,force:true})}
})
