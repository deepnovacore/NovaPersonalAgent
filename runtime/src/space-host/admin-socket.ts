import {createServer,createConnection,type Server,type Socket} from 'node:net';
import {chmod,lstat,unlink} from 'node:fs/promises';
import {z} from 'zod';
/** Local-only admin channel for the headless Host. The 0700 config directory and the 0600 socket are the authentication. */
export interface SpaceAdminTarget {status():unknown;invitation():Promise<unknown>;pairings():Promise<unknown>;confirmPairing(id:string,fingerprint:string):Promise<unknown>;revoke(device:string):Promise<unknown>}
export const SPACE_ADMIN_REQUEST_LIMIT=16*1024;
const request=z.discriminatedUnion('method',[
 z.object({id:z.union([z.string().max(64),z.number().int()]),method:z.literal('status'),params:z.object({}).strict().optional()}).strict(),
 z.object({id:z.union([z.string().max(64),z.number().int()]),method:z.literal('invitation'),params:z.object({}).strict().optional()}).strict(),
 z.object({id:z.union([z.string().max(64),z.number().int()]),method:z.literal('pairings'),params:z.object({}).strict().optional()}).strict(),
 z.object({id:z.union([z.string().max(64),z.number().int()]),method:z.literal('confirm_pairing'),params:z.object({id:z.string().min(1).max(256),fingerprint:z.string().min(1).max(512)}).strict()}).strict(),
 z.object({id:z.union([z.string().max(64),z.number().int()]),method:z.literal('revoke'),params:z.object({device:z.string().min(1).max(256)}).strict()}).strict(),
]);
export const adminSocketPath=(configPath:string)=>configPath+'.admin.sock';
const connectable=(path:string)=>new Promise<boolean>(resolve=>{const socket=createConnection(path);socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))});
async function dispatch(target:SpaceAdminTarget,value:z.infer<typeof request>):Promise<unknown>{
 if(value.method==='status')return target.status();
 if(value.method==='invitation')return target.invitation();
 if(value.method==='pairings')return target.pairings();
 if(value.method==='confirm_pairing')return target.confirmPairing(value.params.id,value.params.fingerprint);
 return target.revoke(value.params.device);
}
function serve(target:SpaceAdminTarget,socket:Socket){
 let buffer='',chain:Promise<void>=Promise.resolve();
 const reject=(error:string)=>{socket.end(JSON.stringify({id:null,ok:false,error})+'\n')};
 socket.setEncoding('utf8');socket.on('error',()=>socket.destroy());
 socket.on('data',(chunk:string)=>{
  buffer+=chunk;
  for(let index=buffer.indexOf('\n');index>=0;index=buffer.indexOf('\n')){
   const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
   if(Buffer.byteLength(line)>SPACE_ADMIN_REQUEST_LIMIT)return reject('request_too_large');
   let parsed:z.infer<typeof request>;
   try{parsed=request.parse(JSON.parse(line))}catch{return reject('malformed_request')}
   chain=chain.then(async()=>{let reply:object;try{reply={id:parsed.id,ok:true,data:await dispatch(target,parsed)??null}}catch(error){reply={id:parsed.id,ok:false,error:error instanceof Error?error.message.slice(0,128):'request_failed'}}if(!socket.destroyed)socket.write(JSON.stringify(reply)+'\n')});
  }
  if(Buffer.byteLength(buffer)>SPACE_ADMIN_REQUEST_LIMIT)reject('request_too_large');
 });
}
/** Returns undefined (after a diagnostic) when the socket cannot be offered; Host startup never fails because of it. */
export async function startSpaceAdminSocket(target:SpaceAdminTarget,path:string,onDiagnostic?:(code:string)=>void):Promise<{close():Promise<void>}|undefined>{
 if(process.platform==='win32')return undefined;
 if(Buffer.byteLength(path)>(process.platform==='darwin'?103:107)){onDiagnostic?.('space_admin_socket_unavailable');return undefined}
 try{
  const existing=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error});
  if(existing){if(!existing.isSocket()||await connectable(path))throw Error('space_admin_socket_occupied');await unlink(path)}
  const connections=new Set<Socket>(),server:Server=createServer(socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));serve(target,socket)});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve()})});
  await chmod(path,0o600);
  return {close:async()=>{for(const socket of connections)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(path).catch(()=>undefined)}};
 }catch{onDiagnostic?.('space_admin_socket_unavailable');return undefined}
}
/** One request/response round trip for the CLI. */
export function spaceAdminRequest(path:string,method:string,params?:object,timeoutMs=60000):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const socket=createConnection(path);let buffer='';const id=Math.floor(Math.random()*2**31);
  const fail=(error:Error)=>{clearTimeout(timer);socket.destroy();reject(error)},timer=setTimeout(()=>fail(Error('space_admin_timeout')),timeoutMs);
  socket.setEncoding('utf8');
  socket.once('connect',()=>socket.write(JSON.stringify({id,method,...(params?{params}:{})})+'\n'));
  socket.on('error',error=>fail(['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??'')?Error('space_host_not_running'):error));
  socket.on('close',()=>fail(Error('space_admin_closed')));
  socket.on('data',(chunk:string)=>{buffer+=chunk;const index=buffer.indexOf('\n');if(index<0)return;
   try{const reply=z.object({id:z.unknown(),ok:z.boolean(),data:z.unknown().optional(),error:z.string().optional()}).parse(JSON.parse(buffer.slice(0,index)));clearTimeout(timer);socket.removeAllListeners('close');socket.destroy();if(reply.ok)resolve(reply.data);else reject(Error(reply.error??'request_failed'))}catch(error){fail(error instanceof Error?error:Error('space_admin_invalid_reply'))}});
 });
}
