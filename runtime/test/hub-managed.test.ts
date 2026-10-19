import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {request} from 'node:http'
import {createServer as createNetServer} from 'node:net'
import {mkdtempSync,rmSync,unlinkSync,statSync,symlinkSync,writeFileSync,existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {HubStore} from '../src/hub/store.js'

const entry=fileURLToPath(new URL('../src/hub/managed-entry.js',import.meta.url))
function launch(dir:string){
 const child=spawn(process.execPath,[entry,'--data-dir',dir,'--port','0'],{stdio:'pipe'})
 let output='';child.stdout.on('data',data=>{output+=String(data)})
 child.stderr.on('data',data=>{output+=String(data)})
 const exit=new Promise<number|null>(resolve=>child.once('exit',resolve))
 const ready=new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('daemon readiness timeout: '+output))},10000)
  const onData=(data:Buffer)=>{if(String(data).includes('Nova managed Hub ready')){clearTimeout(timer);resolve()}}
  child.stdout.on('data',onData)
  child.once('exit',()=>{clearTimeout(timer);reject(Error('daemon exited: '+output))})
 })
 return {child,ready,exit,output:()=>output}
}
async function stop(child:ChildProcessWithoutNullStreams){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM')})}
function admin(dir:string,body:unknown,headers:Record<string,string>={}):Promise<{status:number;body:Record<string,unknown>}>{
 return new Promise((resolve,reject)=>{
  const req=request({socketPath:join(dir,'admin.sock'),method:'POST',path:'/admin',headers:{'content-type':'application/json',...headers}},res=>{
   let data='';res.setEncoding('utf8');res.on('data',chunk=>{data+=chunk});res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(data) as Record<string,unknown>})}catch{reject(Error('invalid admin JSON'))}})
  });req.on('error',reject);req.end(JSON.stringify(body))
 })
}
test('managed daemon owns private state, survives restart, scopes admin operations and refuses a second daemon',async()=>{
 const dir=mkdtempSync('/private/tmp/nova-hub-')
 let daemon=launch(dir)
 try{
  await daemon.ready
  const first=await admin(dir,{action:'status'})
  assert.equal(first.status,200);assert.equal(first.body.invitation_active,false)
  assert.equal(statSync(dir).mode&0o777,0o700)
  for(const file of ['admin.sock','managed.json','hub.sqlite','hub.sqlite-wal','hub.sqlite-shm'])if(existsSync(join(dir,file)))assert.equal(statSync(join(dir,file)).mode&0o777,0o600,file)
  const other=launch(dir);await assert.rejects(other.ready,/daemon exited/);assert.notEqual(await other.exit,0)
  assert.equal((await admin(dir,{action:'status'})).body.hub_id,first.body.hub_id)
  assert.equal((await admin(dir,{action:'status'},{origin:'https://evil.test'})).status,403)
  const invite=(await admin(dir,{action:'invite',url:'https://nova.example.ts.net'})).body
  assert.equal((await admin(dir,{action:'status'})).body.invitation_active,true)
  const port=first.body.port,origin=`http://127.0.0.1:${String(port)}`
  assert.equal((await fetch(origin+'/admin',{method:'POST',body:'{}'})).status,401)
  const response=await fetch(origin+'/hub/v1/pairing/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:invite.code,hub_id:invite.hub_id,account_id:invite.account_id,device_name:'Managed phone'})})
  assert.equal(response.status,200)
  const device=await response.json() as {token:string;device_id:string}
  assert.equal((await admin(dir,{action:'status'})).body.invitation_active,false)
  assert.equal(((await admin(dir,{action:'devices'})).body.devices as {device_name:string}[])[0]?.device_name,'Managed phone')
  await admin(dir,{action:'revoke',device_id:device.device_id})
  assert.equal((await fetch(origin+'/hub/v1/identity',{headers:{authorization:`Bearer ${device.token}`}})).status,401)
  assert.ok(!daemon.output().includes(device.token));assert.ok(!daemon.output().includes(String(invite.code)))
  await stop(daemon.child)
  assert.equal(existsSync(join(dir,'admin.sock')),false)
  daemon=launch(dir);await daemon.ready
  const second=(await admin(dir,{action:'status'})).body
  assert.equal(second.account_id,first.body.account_id);assert.equal(second.hub_id,first.body.hub_id)
  const cancelled=await admin(dir,{action:'invite',url:'https://nova.example.ts.net'})
  assert.equal(cancelled.status,200)
  assert.equal((await admin(dir,{action:'cancel'})).status,200)
  assert.equal((await admin(dir,{action:'status'})).body.invitation_active,false)
 }finally{await stop(daemon.child);rmSync(dir,{recursive:true,force:true})}
})
test('managed daemon rejects symlink state and never adopts a preexisting CLI database',async()=>{
 const root=mkdtempSync('/private/tmp/nova-hub-')
 try{
  const store=new HubStore(join(root,'hub.sqlite'));store.enroll('cli-account','Existing CLI');store.close()
  const before=readFileSync(join(root,'hub.sqlite'))
  let daemon=launch(root);await assert.rejects(daemon.ready,/daemon exited/);assert.notEqual(await daemon.exit,0)
  assert.deepEqual(readFileSync(join(root,'hub.sqlite')),before)
  rmSync(join(root,'hub.sqlite'))
  writeFileSync(join(root,'other'),'untouched');symlinkSync(join(root,'other'),join(root,'managed.json'))
  daemon=launch(root);await assert.rejects(daemon.ready,/daemon exited/);assert.notEqual(await daemon.exit,0)
  assert.equal(readFileSync(join(root,'other'),'utf8'),'untouched')
  const alias=root+'-alias';symlinkSync(root,alias)
  try{daemon=launch(alias);await assert.rejects(daemon.ready,/daemon exited/);assert.notEqual(await daemon.exit,0)}finally{unlinkSync(alias)}
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('managed crash recovery preserves identity and invalidates previously displayed invitations',async()=>{
 const dir=mkdtempSync('/private/tmp/nova-hub-')
 let daemon=launch(dir)
 try{
  await daemon.ready
  const first=(await admin(dir,{action:'status'})).body
  const invite=(await admin(dir,{action:'invite',url:'https://nova.example.ts.net'})).body
  daemon.child.kill('SIGKILL');await daemon.exit
  daemon=launch(dir);await daemon.ready
  const second=(await admin(dir,{action:'status'})).body
  assert.equal(second.account_id,first.account_id);assert.equal(second.hub_id,first.hub_id)
  assert.equal(second.invitation_active,false);assert.equal(second.expires_at,undefined)
  const replay=await fetch(`http://127.0.0.1:${String(second.port)}/hub/v1/pairing/redeem`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:invite.code,hub_id:invite.hub_id,account_id:invite.account_id,device_name:'Old QR'})})
  assert.equal(replay.status,400)
 }finally{await stop(daemon.child);rmSync(dir,{recursive:true,force:true})}
})

test('two crash restarters preserve the winning daemon socket',async()=>{
 const dir=mkdtempSync('/private/tmp/nova-hub-'),initial=launch(dir)
 const restarters:ReturnType<typeof launch>[]=[]
 try{
  await initial.ready
  const before=(await admin(dir,{action:'status'})).body
  initial.child.kill('SIGKILL');await initial.exit
  restarters.push(launch(dir),launch(dir))
  const results=await Promise.allSettled(restarters.map(daemon=>daemon.ready))
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
  assert.equal((await admin(dir,{action:'status'})).body.hub_id,before.hub_id)
 }finally{await stop(initial.child);await Promise.all(restarters.map(daemon=>stop(daemon.child)));rmSync(dir,{recursive:true,force:true})}
})

test('an active existing socket is preserved even without a daemon lock',async()=>{
 const dir=mkdtempSync('/private/tmp/nova-hub-'),path=join(dir,'admin.sock'),server=createNetServer(socket=>socket.end())
 await new Promise<void>(resolve=>server.listen(path,resolve))
 const inode=statSync(path).ino,daemon=launch(dir)
 try{
  await assert.rejects(daemon.ready,/daemon exited/)
  assert.notEqual(await daemon.exit,0)
  assert.equal(statSync(path).ino,inode)
 }finally{await stop(daemon.child);await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true})}
})
