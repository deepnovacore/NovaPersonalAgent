import {createHash,randomBytes} from 'node:crypto';
import {CompactEncrypt} from 'jose';
import {z} from 'zod';
import {BoundedJsonStore} from '../storage/bounded-json.js';
const statusSchema=z.enum(['accepted','invalid_token','quota_exceeded','rejected','unknown']);
export type SpacePushStatus=z.infer<typeof statusSchema>;
const registrationSchema=z.object({handle:z.string(),credential:z.string(),key:z.string()});
const stateSchema=z.object({v:z.literal(1),registrations:z.record(z.string(),registrationSchema),receipts:z.record(z.string(),z.object({status:statusSchema,digest:z.string()}))});
const inputSchema=z.object({handle:z.string().min(1).max(128),credential:z.string().min(1).max(256),gateway_url:z.string().optional()}).strict();
export interface PushKeyMessage {v:1;type:'push.key';handle:string;notification_key:string}
export interface SpacePushDeliveryOptions {path:string;gatewayUrl:string;request?:typeof fetch}
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function normalizeGateway(value:string):string {
 const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('invalid_push_gateway');return url.origin;
}
/** Host process lock and one owner per journal are required, as for the SpaceHost journal. */
export class SpacePushDelivery {
 readonly #store:BoundedJsonStore<z.infer<typeof stateSchema>>;readonly #gateway:string;readonly #request:typeof fetch;
 #state:z.infer<typeof stateSchema>={v:1,registrations:{},receipts:{}};#opened=false;#tail:Promise<unknown>=Promise.resolve();
 constructor(readonly options:SpacePushDeliveryOptions){this.#gateway=normalizeGateway(options.gatewayUrl);this.#request=options.request??fetch;this.#store=new BoundedJsonStore(options.path,stateSchema,16*1024*1024)}
 #serial<T>(work:()=>Promise<T>):Promise<T>{const run=this.#tail.then(work);this.#tail=run.catch(()=>{ /* Keep the serial queue usable after a caller-visible failure. */ });return run}
 async open(){if(this.#opened)return;try{this.#state=await this.#store.read(this.#state)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}this.#opened=true;await this.#store.write(this.#state)}
 async register(device:string,input:unknown):Promise<PushKeyMessage>{return this.#serial(async()=>{
  if(!this.#opened)throw Error('push_closed');const parsed=inputSchema.parse(input);
  if(parsed.gateway_url!==undefined&&normalizeGateway(parsed.gateway_url)!==this.#gateway)throw Error('gateway_not_allowed');
  const current=this.#state.registrations[device];
  if(current?.handle===parsed.handle&&current.credential!==parsed.credential)throw Error('push_credential_conflict');
  const registration=current?.handle===parsed.handle?current:{handle:parsed.handle,credential:parsed.credential,key:randomBytes(32).toString('base64url')};
  this.#state.registrations[device]=registration;await this.#store.write(this.#state);
  // Mailbox delivery of this message is E2E; only the destination Client receives the key.
  return {v:1,type:'push.key',handle:registration.handle,notification_key:registration.key};
 })}
 async revoke(device:string){await this.#serial(async()=>{
  const registration=this.#state.registrations[device];if(!registration)return;delete this.#state.registrations[device];await this.#store.write(this.#state);
  try{await this.#request(`${this.#gateway}/v1/registrations/${encodeURIComponent(registration.handle)}`,{method:'DELETE',headers:{authorization:`Bearer ${registration.credential}`},redirect:'error',signal:AbortSignal.timeout(10_000)});}catch{/* Local revocation takes effect even while gateway is unavailable. */}
 })}
 async prune(devices:string[]){for(const device of Object.keys(this.#state.registrations))if(!devices.includes(device))await this.revoke(device)}
 async send(device:string,notification:{id:string;title:string;body:string}):Promise<{status:SpacePushStatus;retryable:false}>{return this.#serial(async()=>{
  if(!this.#opened)throw Error('push_closed');const registration=this.#state.registrations[device];if(!registration)return {status:'rejected',retryable:false};
  if(!notification.id||notification.id.length>128)throw Error('invalid_notification_id');
  const receiptId=fingerprint([device,registration.handle,notification.id]),digest=fingerprint(notification),old=this.#state.receipts[receiptId];
  if(old){if(old.digest!==digest)throw Error('notification_conflict');return {status:old.status,retryable:false}}
  // Persist reservation before provider I/O. Process death or lost response can never cause an automatic second send.
  this.#state.receipts[receiptId]={status:'unknown',digest};await this.#store.write(this.#state);
  let status:SpacePushStatus='unknown';
  try {
   let title=notification.title.slice(0,120),body=notification.body.slice(0,1024);
   let ciphertext=await new CompactEncrypt(Buffer.from(JSON.stringify({title,body}))).setProtectedHeader({alg:'dir',enc:'A256GCM'}).encrypt(Buffer.from(registration.key,'base64url'));
   // Unicode can exceed the provider's byte limit: preserve a generic, encrypted fallback.
   if(Buffer.byteLength(ciphertext)>3000){title='Nova';body='Open Nova to view new updates.';ciphertext=await new CompactEncrypt(Buffer.from(JSON.stringify({title,body}))).setProtectedHeader({alg:'dir',enc:'A256GCM'}).encrypt(Buffer.from(registration.key,'base64url'))}
   const response=await this.#request(`${this.#gateway}/v1/push`,{method:'POST',headers:{authorization:`Bearer ${registration.credential}`,'content-type':'application/json'},body:JSON.stringify({handle:registration.handle,notificationId:notification.id,ciphertext}),redirect:'error',signal:AbortSignal.timeout(10_000)});
   if(response.ok){const parsed=z.object({status:statusSchema}).safeParse(await response.json());if(parsed.success)status=parsed.data.status}
   else if(response.status===401){status='invalid_token'}else if(response.status===429){status='quota_exceeded'}else if(response.status>=400&&response.status<500){status='rejected'}
  }catch{/* Ambiguous transport/provider errors are deliberately unknown. */}
  if(status==='invalid_token')delete this.#state.registrations[device];this.#state.receipts[receiptId]={status,digest};await this.#store.write(this.#state);return {status,retryable:false};
 })}
}
