import {chmodSync,closeSync,constants,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,unlinkSync,writeFileSync,type Stats} from 'node:fs'
import {isAbsolute,join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createConnection,type AddressInfo} from 'node:net'
import {createServer,type Server} from 'node:http'
import {z} from 'zod'
import {DatabaseSync} from 'node:sqlite'
import {HubStore} from './store.js'
import {createHubServer} from './server.js'
import {readLimitedJson} from './http-body.js'

const metadataSchema=z.object({version:z.literal(1),account_id:z.string().uuid(),hub_id:z.string().uuid().optional()}).strict()
const adminRequest=z.discriminatedUnion('action',[
 z.object({action:z.literal('status')}).strict(),z.object({action:z.literal('invite'),url:z.string().max(2048)}).strict(),
 z.object({action:z.literal('cancel')}).strict(),z.object({action:z.literal('devices')}).strict(),
 z.object({action:z.literal('revoke'),device_id:z.string().uuid()}).strict(),
])
function inspect(path:string,kind:'file'|'socket'|'directory'):Stats|undefined {
 let stat:Stats
 try{stat=lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||!(kind==='file'?stat.isFile()&&stat.nlink===1:kind==='socket'?stat.isSocket():stat.isDirectory()))throw Error('managed_hub_unsafe_state')
 return stat
}
function sameFile(path:string,expected:Stats){const current=lstatSync(path);return current.dev===expected.dev&&current.ino===expected.ino}
function writeMetadata(path:string,value:unknown){
 const temporary=path+'.tmp-'+randomUUID(),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
 renameSync(temporary,path)
 const dir=openSync(resolve(path,'..'),constants.O_RDONLY)
 try{fsyncSync(dir)}finally{closeSync(dir)}
}
function acquireLock(path:string){
 // The OS releases SQLite's file lock on crashes. Unlike reclaiming a PID file,
 // concurrent restarters cannot accidentally remove a new owner's lock.
 const lock=new DatabaseSync(path,{allowExtension:false})
 try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')}catch{lock.close();throw Error('managed_hub_already_running')}
 chmodSync(path,0o600)
 return ()=>{try{lock.exec('ROLLBACK')}finally{lock.close()}}
}
async function clearStaleSocket(path:string){
 const prior=inspect(path,'socket')
 if(!prior)return
 const stale=await new Promise<boolean>(resolve=>{
  const client=createConnection(path)
  client.setTimeout(1000)
  client.once('connect',()=>{client.destroy();resolve(false)})
  client.once('timeout',()=>{client.destroy();resolve(false)})
  client.once('error',error=>{client.destroy();resolve((error as NodeJS.ErrnoException).code==='ECONNREFUSED')})
 })
 if(!stale||!sameFile(path,prior))throw Error('managed_hub_socket_in_use')
 unlinkSync(path)
}
function listen(server:Server,pathOrPort:string|number):Promise<void>{
 return new Promise((resolve,reject)=>{
  const failed=(error:Error)=>{server.off('listening',ready);reject(error)}
  const ready=()=>{server.off('error',failed);resolve()}
  server.once('error',failed);server.once('listening',ready)
  if(typeof pathOrPort==='string')server.listen(pathOrPort);else server.listen(pathOrPort,'127.0.0.1')
 })
}
async function closeServer(server:Server|undefined){
 if(!server?.listening)return
 await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})
}

/** This process owns a separate database; a CLI database can never become managed implicitly. */
export async function startManagedHub(options:{dataDir:string;port?:number}){
 process.umask(0o077)
 const directory=options.dataDir,port=options.port??8787
 if(!isAbsolute(directory)||!Number.isInteger(port)||port<0||port>65535)throw Error('managed_hub_invalid_options')
 const socketPath=join(directory,'admin.sock')
 if(Buffer.byteLength(socketPath)>100)throw Error('managed_hub_socket_path_too_long')
 mkdirSync(directory,{recursive:true,mode:0o700})
 inspect(directory,'directory')
 if(realpathSync(directory)!==resolve(directory))throw Error('managed_hub_unsafe_state')
 chmodSync(directory,0o700)
 const dbPath=join(directory,'hub.sqlite'),metadataPath=join(directory,'managed.json')
 for(const file of ['managed.json','hub.sqlite','hub.sqlite-wal','hub.sqlite-shm','daemon.lock','daemon.lock-journal','daemon.lock-wal','daemon.lock-shm'])inspect(join(directory,file),'file')
 const hasMetadata=existsSync(metadataPath)
 if(!hasMetadata&&['hub.sqlite','hub.sqlite-wal','hub.sqlite-shm'].some(file=>existsSync(join(directory,file))))throw Error('managed_hub_unowned_database')
 const release=acquireLock(join(directory,'daemon.lock'))
 let store:HubStore|undefined,http:Server|undefined,admin:Server|undefined,closing:Promise<void>|undefined,ready=false
 const close=()=>closing??=(async()=>{ready=false;await closeServer(http);await closeServer(admin);store?.close();release()})()
 try{
  await clearStaleSocket(socketPath)
  admin=createServer((req,res)=>{void(async()=>{
   const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',connection:'close'});res.end(JSON.stringify(value))}
   if(req.headers.origin!==undefined){reply(403,{error:'origin_forbidden'});return}
   if(req.method!=='POST'||req.url!=='/admin'){reply(404,{error:'not_found'});return}
   if(!ready||!store){reply(503,{error:'not_ready'});return}
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){reply(415,{error:'json_required'});return}
   try{
    const request=adminRequest.parse(await readLimitedJson(req))
    if(request.action==='status')reply(200,{hub_id:store.hubId,account_id:metadata.account_id,port:(http!.address() as AddressInfo).port,...store.invitationStatus(metadata.account_id)})
    else if(request.action==='invite')reply(200,store.createInvitation(metadata.account_id,request.url))
    else if(request.action==='devices')reply(200,{devices:store.listDevices(metadata.account_id)})
    else if(request.action==='cancel'){store.cancelInvitation(metadata.account_id);reply(200,{ok:true})}
    else {store.revoke(metadata.account_id,request.device_id);reply(200,{ok:true})}
   }catch(error){
    const message=error instanceof Error?error.message:''
    const statuses:Record<string,number>={invalid_hub_url:400,payload_too_large:413,request_timeout:408,device_capacity:409}
    reply(statuses[message]??400,{error:statuses[message]?message:'invalid_request'})
   }
  })().catch(()=>res.destroy())})
  admin.requestTimeout=10000;admin.headersTimeout=10000;admin.maxConnections=16
  await listen(admin,socketPath);chmodSync(socketPath,0o600)
  const metadata=hasMetadata?metadataSchema.parse(JSON.parse(readFileSync(metadataPath,'utf8'))):{version:1 as const,account_id:randomUUID()}
  if(metadata.hub_id&&!existsSync(dbPath))throw Error('managed_hub_database_missing')
  if(!hasMetadata)writeMetadata(metadataPath,metadata)
  store=new HubStore(dbPath)
  if(metadata.hub_id&&metadata.hub_id!==store.hubId)throw Error('managed_hub_identity_mismatch')
  writeMetadata(metadataPath,{...metadata,hub_id:store.hubId})
  // A QR shown by a previous daemon lifetime must never revive after stop/re-enable.
  store.cancelInvitation(metadata.account_id)
  for(const file of ['managed.json','hub.sqlite','hub.sqlite-wal','hub.sqlite-shm']){
   const path=join(directory,file)
   if(inspect(path,'file'))chmodSync(path,0o600)
  }
  http=createHubServer(store);http.requestTimeout=10000;http.headersTimeout=10000;http.maxConnections=128
  await listen(http,port);ready=true
  return {close,port:(http.address() as AddressInfo).port}
 }catch(error){await close();throw error}
}
