import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import type {IncomingMessage,ServerResponse,RequestListener} from 'node:http';
import type {ProviderName,PushProvider,PushStatus} from './providers.js';
import {GatewayStore,MAX_LEASE_MS,deviceIdentity,type Registration,type Installation} from './store.js';
import {GatewayHttpGuard,GatewayHttpError,type GatewayHttpOptions} from './http-policy.js';
import {verifyInvitation} from './admission.js';
export interface GatewayOptions {statePath:string;admissionKey:string;providers:Partial<Record<ProviderName,PushProvider>>;limits?:{perHandle:number;global:number};installationDailyLimit?:number;registrationLimit?:number;registrationTtlMs?:number;now?:()=>number}
export interface RegistrationInput {provider:ProviderName;token:string;environment?:'sandbox'|'production';registrationId?:string}
export interface PushInput {handle:string;credential:string;notificationId:string;ciphertext:string;expiresAt?:number}
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
 private readonly store:GatewayStore;private closed=false;private readonly owner:DatabaseSync;private cleanupAt=0;
 private readonly leaseMs:number;private readonly globalLimit:number;private readonly installationLimit:number;
 constructor(private readonly options:GatewayOptions) {
  if(options.admissionKey.length<32)throw new Error('admission_key_too_short');
  this.globalLimit=options.limits?.global??10_000;this.installationLimit=options.installationDailyLimit??options.limits?.perHandle??100;this.leaseMs=options.registrationTtlMs??MAX_LEASE_MS;
  for(const value of [options.limits?.perHandle??100,this.globalLimit,this.installationLimit,options.registrationLimit??100_000,this.leaseMs])if(!Number.isSafeInteger(value)||value<1)throw new Error('invalid_limits');
  if(this.leaseMs>MAX_LEASE_MS||this.installationLimit>this.globalLimit)throw new Error('invalid_limits');
  mkdirSync(dirname(options.statePath),{recursive:true,mode:0o700});
  // A connection-lifetime SQLite owner lock is released by the OS after SIGKILL.
  // A separate lock database leaves the data WAL readable for backup/inspection.
  this.owner=new DatabaseSync(options.statePath+'.owner.sqlite');chmodSync(options.statePath+'.owner.sqlite',0o600);
  try {this.owner.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(value INTEGER)');this.store=new GatewayStore(options.statePath,this.now(),this.globalLimit,this.installationLimit,this.leaseMs)}catch(error){this.owner.close();throw error}
 }
 private now(){return (this.options.now??Date.now)()}
 private maintain(now=this.now()){if(this.closed)throw Error('gateway_closed');if(now>=this.cleanupAt){this.store.cleanup(now);this.cleanupAt=now+60_000}}
 close(){if(this.closed)return;this.closed=true;this.store.close();this.owner.close()}
 enroll(invitation:string,credential:string):{installationId:string;expiresAt:number} {
  if(!/^[A-Za-z0-9_-]{43}$/.test(credential))throw new GatewayError(400,'invalid_installation_credential');
  const now=this.now();this.maintain(now);let claim:ReturnType<typeof verifyInvitation>;
  try{claim=verifyInvitation(this.options.admissionKey,invitation,now)}catch{throw new GatewayError(401,'invalid_invitation')}
  const credentialHash=hash(credential);
  return this.store.transaction(()=>{
   const prior=this.store.db.prepare('SELECT installation_id,credential_hash FROM invitations WHERE id=?').get(claim.id);
   if(prior){if(prior.installation_id!==claim.installationId||!equal(String(prior.credential_hash),credentialHash))throw new GatewayError(401,'invitation_used');const installation=this.store.installation(claim.installationId);if(!installation)throw new GatewayError(401,'invalid_invitation');this.store.touchInstallation(installation.id,now);return {installationId:installation.id,expiresAt:now+MAX_LEASE_MS}}
   if(this.store.installationByCredential(credentialHash)||this.store.installation(claim.installationId))throw new GatewayError(409,'installation_exists');
   if(this.store.reservedBudget()+this.installationLimit>this.globalLimit)throw new GatewayError(429,'installation_capacity');
   this.store.putInstallation({id:claim.installationId,credentialHash,lastSeenAt:now,dailyLimit:this.installationLimit});
   this.store.db.prepare('INSERT INTO invitations(id,installation_id,credential_hash,expires_at) VALUES(?,?,?,?)').run(claim.id,claim.installationId,credentialHash,claim.expiresAt);
   return {installationId:claim.installationId,expiresAt:now+MAX_LEASE_MS};
  });
 }
 private installation(credential:string,now=this.now()):Installation {
  this.maintain(now);const installation=this.store.installationByCredential(hash(credential));
  if(!installation||installation.lastSeenAt<=now-MAX_LEASE_MS)throw new GatewayError(401,'unauthorized');return installation;
 }
 installationInfo(credential:string):{installationId:string;expiresAt:number} {const now=this.now(),installation=this.installation(credential,now);this.store.touchInstallation(installation.id,now);return {installationId:installation.id,expiresAt:now+MAX_LEASE_MS}}
 private validateRegistration(input:RegistrationInput){exact(input,['provider','token','environment','registrationId']);if(!['apns','fcm','mipush'].includes(input.provider)||!this.options.providers[input.provider]||!validString(input.token,4096)||(input.environment!==undefined&&!['sandbox','production'].includes(input.environment))||(input.registrationId!==undefined&&!/^[A-Za-z0-9_-]{16,128}$/.test(input.registrationId)))throw new GatewayError(400,'invalid_registration')}
 register(input:RegistrationInput,installationCredential:string):{handle:string;credential:string;expiresAt:number} {
  const now=this.now(),installation=this.installation(installationCredential,now);this.validateRegistration(input);
  const requestId=input.registrationId??opaque(),requestDigest=hash(JSON.stringify([input.provider,input.token,input.environment??null]));
  const credentialFor=(handle:string)=>createHmac('sha256',installationCredential).update('push-handle\0'+handle).digest('base64url');
  return this.store.transaction(()=>{
   const previous=this.store.registrationByRequest(installation.id,requestId);
   if(previous&&previous.expiresAt>now){if(previous.requestDigest!==requestDigest)throw new GatewayError(409,'registration_conflict');this.store.touchInstallation(installation.id,now);return {handle:previous.handle,credential:credentialFor(previous.handle),expiresAt:previous.expiresAt}}
   if(previous)this.store.removeRegistration(previous.handle);
   if(this.store.registrationCount(installation.id)>=16)throw new GatewayError(429,'installation_handle_limit');
   if(this.store.registrationCount()>=(this.options.registrationLimit??100_000))throw new GatewayError(429,'registration_limit');
   const handle=opaque(),credential=credentialFor(handle),expiresAt=now+this.leaseMs;
   this.store.putRegistration({handle,provider:input.provider,token:input.token,...(input.environment?{environment:input.environment}:{}),device:deviceIdentity(input),credentialHash:hash(credential),installationId:installation.id,expiresAt,requestId,requestDigest});this.store.touchInstallation(installation.id,now);return {handle,credential,expiresAt};
  });
 }
 updateRegistration(handle:string,credential:string,input:RegistrationInput) {
  const now=this.now(),old=this.authenticate(handle,credential,now);this.validateRegistration(input);if(input.registrationId!==undefined)throw new GatewayError(400,'invalid_fields');
  const {environment:_environment,...base}=old;
  this.store.transaction(()=>{this.store.putRegistration({...base,provider:input.provider,token:input.token,...(input.environment?{environment:input.environment}:{}),device:deviceIdentity(input)});this.store.touchInstallation(old.installationId,now)});return {status:'updated',handle,expiresAt:old.expiresAt};
 }
 private authenticate(handle:string,credential:string,now=this.now()):Registration {
  this.maintain(now);const r=this.store.registration(handle);if(!r||r.expiresAt<=now||!equal(r.credentialHash,hash(credential)))throw new GatewayError(401,'unauthorized');const installation=this.store.installation(r.installationId);if(!installation||installation.lastSeenAt<=now-MAX_LEASE_MS)throw new GatewayError(401,'unauthorized');return r;
 }
 unregister(handle:string,credential:string){this.authenticate(handle,credential);this.store.removeRegistration(handle)}
 async push(input:PushInput):Promise<{status:PushStatus;retryable:false}> {
  exact(input,['handle','credential','notificationId','ciphertext','expiresAt']);
  if(!validString(input.handle,128)||!validString(input.credential,128)||!validString(input.notificationId,128)||!/^[A-Za-z0-9_-]+$/.test(input.notificationId)||!validString(input.ciphertext,3000)||!validJwe(input.ciphertext)||(input.expiresAt!==undefined&&!Number.isSafeInteger(input.expiresAt)))throw new GatewayError(400,'invalid_push');
  const now=this.now(),registration=this.authenticate(input.handle,input.credential,now),receiptKey=hash(input.handle+'\0'+input.notificationId),digest=hash(JSON.stringify([input.ciphertext,input.expiresAt??null]));
  const receipt=this.store.receipt(receiptKey);if(receipt){if(receipt.digest!==digest)throw new GatewayError(409,'notification_conflict');return {status:receipt.status,retryable:false}}
  if(registration.installationId.startsWith('legacy-')){const legacy=this.store.legacyReceipt(receiptKey,now);if(legacy){if(legacy.digest!==hash(input.ciphertext))throw new GatewayError(409,'notification_conflict');return {status:legacy.status,retryable:false}}}
  const expiresAt=Math.min(input.expiresAt??now+86400_000,now+86400_000);if(expiresAt<=now)return {status:'rejected',retryable:false};
  this.store.touchInstallation(registration.installationId,now);
  const day=new Date(now).toISOString().slice(0,10),installation=this.store.installation(registration.installationId)!;
  const reserved=this.store.transaction(()=>{
   if(registration.provider==='mipush'&&(['handle','device','installation_id'] as const).some((column)=>this.store.mipushCount(column,column==='handle'?input.handle:column==='device'?registration.device:registration.installationId,now)>=5))return false;
   const scopes:[string,number][]=[['global',this.globalLimit],['h:'+input.handle,this.options.limits?.perHandle??100],['d:'+registration.device,this.options.limits?.perHandle??100],['i:'+registration.installationId,installation.dailyLimit]];
   if(scopes.some(([scope,limit])=>this.store.quota(day,scope)>=limit))return false;
   for(const [scope] of scopes)this.store.incrementQuota(day,scope);
   if(registration.provider==='mipush')this.store.recordMiPush(receiptKey,registration,now);
   this.store.reserveReceipt(receiptKey,input.handle,digest);this.store.touchInstallation(registration.installationId,now);return true;
  });
  if(!reserved)return {status:'quota_exceeded',retryable:false};
  let status:PushStatus='unknown';
  try{status=(await this.options.providers[registration.provider]!.send({token:registration.token,handle:input.handle,notificationId:input.notificationId,ciphertext:input.ciphertext,expiresAt,...(registration.environment?{environment:registration.environment}:{})})).status}catch{}
  this.store.transaction(()=>{
   if(status==='invalid_token'){if(this.store.registration(input.handle)?.device!==registration.device)status='rejected';else this.store.removeDevice(registration.device)}
   // A concurrent revocation/lease expiry may already have removed the receipt; never resurrect it.
   this.store.finishReceipt(receiptKey,status);
  });return {status,retryable:false};
 }
}
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
 let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>8192)throw new GatewayError(413,'payload_too_large');chunks.push(Buffer.from(chunk));}
 try {const value:unknown=JSON.parse(Buffer.concat(chunks).toString());if(!value || typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}catch{throw new GatewayError(400,'invalid_json')}
}
export function createGatewayServer(gateway:Gateway,options:GatewayHttpOptions={}):RequestListener {
 const guard=new GatewayHttpGuard(options);
 return (req:IncomingMessage,res:ServerResponse)=>{void(async()=>{
  const reply=(status:number,value:object)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
  try {
   guard.check(req,res);
   const auth=/^Bearer ([^ ]+)$/.exec(req.headers.authorization??'')?.[1]??'';
   if(req.method==='GET'&&req.url==='/v1/installation'){reply(200,gateway.installationInfo(auth));return}
   if(req.method==='POST'&&req.url==='/v1/installations'){const value=await body(req);exact(value,['credential']);if(typeof value.credential!=='string')throw new GatewayError(400,'invalid_installation_credential');reply(201,gateway.enroll(auth,value.credential));return}
   if(req.method==='POST'&&req.url==='/v1/registrations'){reply(201,gateway.register(await body(req) as unknown as RegistrationInput,auth));return}
   if(req.method==='POST'&&req.url==='/v1/push'){const value=await body(req);exact(value,['handle','notificationId','ciphertext','expiresAt']);reply(200,await gateway.push({...value,credential:auth} as unknown as PushInput));return}
   const handle=/^\/v1\/registrations\/([\w-]{43})$/.exec(req.url??'')?.[1];
   if(req.method==='PUT'&&handle){reply(200,gateway.updateRegistration(handle,auth,await body(req) as unknown as RegistrationInput));return}
   if(req.method==='DELETE'&&handle){gateway.unregister(handle,auth);reply(200,{status:'unregistered'});return}
   reply(404,{error:'not_found'});
  }catch(e){reply(e instanceof GatewayError||e instanceof GatewayHttpError?e.status:500,{error:e instanceof GatewayError||e instanceof GatewayHttpError?e.message:'gateway_error'})}
 })();};
}
