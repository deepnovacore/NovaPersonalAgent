import {createHash} from 'node:crypto';
import {connect} from 'node:http2';
import {importPKCS8, SignJWT} from 'jose';
export type ProviderName = 'apns' | 'fcm' | 'mipush';
export type PushStatus = 'accepted' | 'invalid_token' | 'quota_exceeded' | 'rejected' | 'unknown';
export interface PushMessage {token:string;handle:string;notificationId:string;ciphertext:string;expiresAt?:number;environment?:'sandbox'|'production'}
export interface PushProvider {send(message:PushMessage):Promise<{status:PushStatus}>}
const MAX_RETENTION_MS=24*60*60*1000;
function deadline(m:PushMessage):number|undefined {const now=Date.now(),value=m.expiresAt??now+MAX_RETENTION_MS;return Number.isSafeInteger(value)&&value>now?Math.min(value,now+MAX_RETENTION_MS):undefined;}
const collapse=(m:PushMessage)=>createHash('sha256').update(m.handle).digest('hex').slice(0,32);
export const genericNotification = {title:'Nova',body:'Open Nova to view new updates.'} as const;
/** Credentials live only in this process. Responses and logs never include provider bodies. */
export class ApnsProvider implements PushProvider {
 private cached: {jwt:string;until:number}|undefined;
 constructor(private readonly config:{teamId:string;keyId:string;privateKey:string;topic:string}, private readonly transport = apnsHttp2) {}
 async send(m:PushMessage):Promise<{status:PushStatus}> {
  const expiresAt=deadline(m);if(expiresAt===undefined)return {status:'rejected'};
  if(!this.cached || this.cached.until<Date.now()) {
   const key=await importPKCS8(this.config.privateKey,'ES256');
   this.cached={jwt:await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:this.config.keyId}).setIssuer(this.config.teamId).setIssuedAt().sign(key),until:Date.now()+45*60_000};
  }
  if(expiresAt<=Date.now())return {status:'rejected'};
  const payload={aps:{alert:genericNotification,'mutable-content':1,sound:'default'},handle:m.handle,notificationId:m.notificationId,ciphertext:m.ciphertext};
  if(Buffer.byteLength(JSON.stringify(payload))>4096) return {status:'rejected'};
  const r=await this.transport(m.environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com',`/3/device/${encodeURIComponent(m.token)}`,{'authorization':`bearer ${this.cached.jwt}`,'apns-topic':this.config.topic,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(expiresAt/1000)),'apns-collapse-id':collapse(m)},JSON.stringify(payload));
  if(r.status===200)return {status:'accepted'};
  if(r.status===410 || (r.status===400 && ['BadDeviceToken','DeviceTokenNotForTopic'].includes(r.reason))) return {status:'invalid_token'};
  return {status:r.status===429?'quota_exceeded':r.status>=500?'unknown':'rejected'};
 }
}
export async function apnsHttp2(origin:string,path:string,headers:Record<string,string>,body:string):Promise<{status:number;reason:string}> {
 return new Promise((resolve,reject)=>{
  const session=connect(origin);let complete=false;
  const finish=(error?:Error,result?:{status:number;reason:string})=>{if(complete)return;complete=true;session.destroy();if(error)reject(error);else resolve(result!);};
  session.on('error',()=>finish(new Error('provider_transport_failed')));
  session.setTimeout(10_000,()=>finish(new Error('provider_timeout')));
  const req=session.request({':method':'POST',':path':path,...headers});let status=0;let response='';
  req.on('response',h=>{status=Number(h[':status']);});
  req.on('data',(b:Buffer)=>{if(response.length<8192)response+=b.toString();});
  req.on('error',()=>finish(new Error('provider_transport_failed')));
  req.on('end',()=>{let reason='';try{reason=(JSON.parse(response) as {reason?:string}).reason??'';}catch{}finish(undefined,{status,reason});});req.end(body);
 });
}
export class FcmProvider implements PushProvider {
 private cached:{token:string;until:number}|undefined;
 constructor(private readonly config:{projectId:string;clientEmail:string;privateKey:string},private readonly request:typeof fetch=fetch){}
 async send(m:PushMessage):Promise<{status:PushStatus}> {
  const expiresAt=deadline(m);if(expiresAt===undefined)return {status:'rejected'};
  if(!this.cached || this.cached.until<Date.now()) {
   const key=await importPKCS8(this.config.privateKey,'RS256');
   const assertion=await new SignJWT({scope:'https://www.googleapis.com/auth/firebase.messaging'}).setProtectedHeader({alg:'RS256'}).setIssuer(this.config.clientEmail).setSubject(this.config.clientEmail).setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('1h').sign(key);
   const response=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(10_000)});
   if(!response.ok)return {status:'rejected'};
   const body=await response.json() as {access_token?:string;expires_in?:number};
   if(!body.access_token)return {status:'rejected'};
   this.cached={token:body.access_token,until:Date.now()+Math.max(0,Math.min(body.expires_in??3600,3600)-60)*1000};
  }
  const remaining=Math.floor((expiresAt-Date.now())/1000);if(remaining<=0)return {status:'rejected'};
  const payload={message:{token:m.token,data:{handle:m.handle,notificationId:m.notificationId,ciphertext:m.ciphertext},android:{priority:'HIGH',ttl:`${remaining}s`,collapse_key:collapse(m)}}};
  if(Buffer.byteLength(JSON.stringify(payload))>4096)return {status:'rejected'};
  const response=await this.request(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,{method:'POST',headers:{authorization:`Bearer ${this.cached.token}`,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000)});
  if(response.ok)return {status:'accepted'};
  let code='';try {const body=await response.json() as {error?:{details?:{errorCode?:string}[]}};code=body.error?.details?.find(x=>x.errorCode)?.errorCode??'';}catch{}
  if(code==='UNREGISTERED')return {status:'invalid_token'};
  // INVALID_ARGUMENT can describe payload errors: never revoke a token based only on HTTP 400.
  return {status:response.status===429?'quota_exceeded':response.status>=500?'unknown':'rejected'};
 }
}
export class MiPushProvider implements PushProvider {
 constructor(private readonly config:{appSecret:string;packageName:string;channelId:string;origin?:'https://api.xmpush.xiaomi.com'|'https://api.xmpush.global.xiaomi.com'},private readonly request:typeof fetch=fetch){}
 async send(m:PushMessage):Promise<{status:PushStatus}> {
  const expiresAt=deadline(m);if(expiresAt===undefined)return {status:'rejected'};
  const remaining=expiresAt-Date.now();if(remaining<=0)return {status:'rejected'};
  const body=new URLSearchParams({registration_id:m.token,restricted_package_name:this.config.packageName,title:genericNotification.title,description:genericNotification.body,payload:JSON.stringify({handle:m.handle,notificationId:m.notificationId}),pass_through:'0',notify_type:'-1','extra.channel_id':this.config.channelId,'extra.notify_effect':'1',time_to_live:String(remaining),notify_id:String(parseInt(collapse(m).slice(0,7),16))});
  const response=await this.request(`${this.config.origin??'https://api.xmpush.xiaomi.com'}/v3/message/regid`,{method:'POST',headers:{authorization:`key=${this.config.appSecret}`,'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(10_000)});
  if(response.status>=500)return {status:'unknown'};
  if(response.status===429)return {status:'quota_exceeded'};
  const result=await response.json() as {code?:number};
  if(response.ok && result.code===0)return {status:'accepted'};
  if(result.code===200001 || result.code===200002)return {status:'quota_exceeded'};
  // Vendor invalid-registration codes vary by region/version; unknown rejection does not guess token invalidity.
  return {status:'rejected'};
 }
}
