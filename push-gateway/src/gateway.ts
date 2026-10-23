import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {IncomingMessage,ServerResponse,RequestListener} from 'node:http';
import type {ProviderName,PushProvider,PushStatus} from './providers.js';
interface Registration {provider:ProviderName;token:string;credentialHash:string;environment?:'sandbox'|'production';device:string}
interface State {version:1;mipush:Record<string,number[]>;registrations:Record<string,Registration>;quota:{day:string;global:number;handles:Record<string,number>;devices:Record<string,number>};receipts:Record<string,{status:PushStatus;digest:string}>}
export interface GatewayOptions {statePath:string;admissionKey:string;providers:Partial<Record<ProviderName,PushProvider>>;limits?:{perHandle:number;global:number};registrationLimit?:number;now?:()=>number}
export interface RegistrationInput {provider:ProviderName;token:string;environment?:'sandbox'|'production'}
export interface PushInput {handle:string;credential:string;notificationId:string;ciphertext:string}
export class GatewayError extends Error {constructor(readonly status:number,code:string){super(code);}}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
const equal=(a:string,b:string)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
function exact(obj:object,keys:string[]) {if(Object.keys(obj).some(k=>!keys.includes(k)))throw new GatewayError(400,'invalid_fields');}
function validString(value:unknown,max:number):value is string{return typeof value==='string' && value.length>0 && value.length<=max;}
function validJwe(value:string) {
 if(!/^[\w-]+\.[\w-]*\.[\w-]+\.[\w-]+\.[\w-]+$/.test(value))return false;
 try {const h=JSON.parse(Buffer.from(value.split('.')[0]!,'base64url').toString()) as {alg?:string;enc?:string};return Object.keys(h).length===2&&h.alg==='dir'&&h.enc==='A256GCM';}catch{return false;}
}
export class Gateway {
 private state:State;private closed=false;private readonly lockPath:string;
 constructor(private readonly options:GatewayOptions) {
  if(options.admissionKey.length<32)throw new Error('admission_key_too_short');
  if(options.limits && (!Number.isSafeInteger(options.limits.perHandle)||options.limits.perHandle<1||!Number.isSafeInteger(options.limits.global)||options.limits.global<1))throw new Error('invalid_limits');
  mkdirSync(dirname(options.statePath),{recursive:true,mode:0o700});this.lockPath=options.statePath+'.lock';
  const lock=openSync(this.lockPath,'wx',0o600);closeSync(lock);
  try {
   this.state=existsSync(options.statePath)?JSON.parse(readFileSync(options.statePath,'utf8')) as State:{version:1,mipush:{},registrations:{},quota:{day:'',global:0,handles:{},devices:{}},receipts:{}};
   if(this.state.version!==1 || !this.state.mipush || !this.state.registrations || !this.state.quota || !this.state.quota.handles || !this.state.receipts)throw new Error('invalid_state');
   // A crash after reserving a send is ambiguous; preserve its unknown receipt, never resend it.
   this.save();
  }catch(e){unlinkSync(this.lockPath);throw e;}
 }
 close(){if(this.closed)return;this.closed=true;unlinkSync(this.lockPath);}
 private save(){if(this.closed)throw new Error('gateway_closed');const temp=this.options.statePath+'.'+opaque()+'.tmp';writeFileSync(temp,JSON.stringify(this.state),{mode:0o600,flush:true,flag:'wx'});renameSync(temp,this.options.statePath);if(process.platform!=='win32'){const dir=openSync(dirname(this.options.statePath),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}}
 authorizeAdmission(key:string){if(!equal(key,this.options.admissionKey))throw new GatewayError(401,'unauthorized');}
 register(input:RegistrationInput):{handle:string;credential:string} {
  exact(input,['provider','token','environment']);
  if(!['apns','fcm','mipush'].includes(input.provider)||!this.options.providers[input.provider]||!validString(input.token,4096)|| (input.environment!==undefined&&!['sandbox','production'].includes(input.environment)))throw new GatewayError(400,'invalid_registration');
  const device=hash(input.provider+'\0'+input.token);
  // Each Space owns an independent handle; quota remains shared by installation token.
  if(Object.keys(this.state.registrations).length >= (this.options.registrationLimit??100_000))throw new GatewayError(429,'registration_limit');
  const handle=opaque(),credential=opaque();
  this.state.registrations[handle]={...input,device,credentialHash:hash(credential)};this.save();return {handle,credential};
 }
 updateRegistration(handle:string,credential:string,input:RegistrationInput) {
  const old=this.authenticate(handle,credential);exact(input,['provider','token','environment']);
  if(!['apns','fcm','mipush'].includes(input.provider)||!this.options.providers[input.provider]||!validString(input.token,4096)||(input.environment!==undefined&&!['sandbox','production'].includes(input.environment)))throw new GatewayError(400,'invalid_registration');
  this.state.registrations[handle]={...input,device:hash(input.provider+'\0'+input.token),credentialHash:old.credentialHash};this.save();return {status:'updated',handle};
 }
 private authenticate(handle:string,credential:string):Registration {
  const r=this.state.registrations[handle];if(!r||!equal(r.credentialHash,hash(credential)))throw new GatewayError(401,'unauthorized');return r;
 }
 unregister(handle:string,credential:string){this.authenticate(handle,credential);delete this.state.registrations[handle];this.save();}
 async push(input:PushInput):Promise<{status:PushStatus;retryable:false}> {
  exact(input,['handle','credential','notificationId','ciphertext']);
  if(!validString(input.handle,128)||!validString(input.credential,128)||!validString(input.notificationId,128)||!/^[A-Za-z0-9_-]+$/.test(input.notificationId)||!validString(input.ciphertext,3000)||!validJwe(input.ciphertext))throw new GatewayError(400,'invalid_push');
  const registration=this.authenticate(input.handle,input.credential);
  const receiptKey=hash(input.handle+'\0'+input.notificationId),digest=hash(input.ciphertext);
  const receipt=this.state.receipts[receiptKey];if(receipt){if(receipt.digest!==digest)throw new GatewayError(409,'notification_conflict');return {status:receipt.status,retryable:false};}
  const now=(this.options.now??Date.now)();const day=new Date(now).toISOString().slice(0,10);
  const recent=(this.state.mipush[registration.device]??[]).filter(time=>time>now-86400_000);
  const handleRecent=(this.state.mipush['h:'+input.handle]??[]).filter(time=>time>now-86400_000);
  if(registration.provider==='mipush'&&(recent.length>=5||handleRecent.length>=5))return {status:'quota_exceeded',retryable:false};
  if(this.state.quota.day!==day)this.state.quota={day,global:0,handles:{},devices:{}};
  const count=this.state.quota.devices[registration.device]??0;
  const perHandle=Math.min(this.options.limits?.perHandle??100,registration.provider==='mipush'?5:Number.MAX_SAFE_INTEGER);
  if(Object.keys(this.state.receipts).length>=1_000_000 || count>=perHandle || (this.state.quota.handles[input.handle]??0)>=perHandle || this.state.quota.global>=(this.options.limits?.global??10_000))return {status:'quota_exceeded',retryable:false};
  if(registration.provider==='mipush'){this.state.mipush[registration.device]=[...recent,now];this.state.mipush['h:'+input.handle]=[...handleRecent,now];}
  this.state.quota.global++;this.state.quota.handles[input.handle]=(this.state.quota.handles[input.handle]??0)+1;this.state.quota.devices[registration.device]=count+1;
  // Reserve before any I/O. Concurrent duplicate requests see unknown and cannot duplicate delivery.
  this.state.receipts[receiptKey]={status:'unknown',digest};
  // Receipts remain durable for each live handle; deleting a handle makes old sends unauthorized.
  this.save();
  let status:PushStatus='unknown';
  try {status=(await this.options.providers[registration.provider]!.send({token:registration.token,handle:input.handle,notificationId:input.notificationId,ciphertext:input.ciphertext,...(registration.environment?{environment:registration.environment}:{})})).status;}catch{}
  if(status==='invalid_token'){
   // A concurrent token rotation must not let feedback for the old token revoke a valid handle at the Host.
   if(this.state.registrations[input.handle]?.device!==registration.device)status='rejected';
   else for(const [handle,r] of Object.entries(this.state.registrations))if(r.device===registration.device)delete this.state.registrations[handle];
  }
  this.state.receipts[receiptKey]={status,digest};this.save();return {status,retryable:false};
 }
}
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
 let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>8192)throw new GatewayError(413,'payload_too_large');chunks.push(Buffer.from(chunk));}
 try {const value:unknown=JSON.parse(Buffer.concat(chunks).toString());if(!value || typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}catch{throw new GatewayError(400,'invalid_json');}
}
export function createGatewayServer(gateway:Gateway):RequestListener {
 return (req:IncomingMessage,res:ServerResponse)=>{void(async()=>{
  const reply=(status:number,value:object)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try {
   const auth=/^Bearer ([^ ]+)$/.exec(req.headers.authorization??'')?.[1]??'';
   if(req.method==='POST'&&req.url==='/v1/registrations'){gateway.authorizeAdmission(auth);reply(201,gateway.register(await body(req) as unknown as RegistrationInput));return;}
   if(req.method==='POST'&&req.url==='/v1/push') {const value=await body(req);exact(value,['handle','notificationId','ciphertext']);reply(200,await gateway.push({...value,credential:auth} as unknown as PushInput));return;}
   const handle=/^\/v1\/registrations\/([\w-]{43})$/.exec(req.url??'')?.[1];
   if(req.method==='PUT'&&handle){reply(200,gateway.updateRegistration(handle,auth,await body(req) as unknown as RegistrationInput));return;}
   if(req.method==='DELETE'&&handle){gateway.unregister(handle,auth);reply(200,{status:'unregistered'});return;}
   reply(404,{error:'not_found'});
  }catch(e){reply(e instanceof GatewayError?e.status:500,{error:e instanceof GatewayError?e.message:'gateway_error'});}
 })();};
}
