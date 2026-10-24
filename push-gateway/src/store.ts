import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {ProviderName,PushStatus} from './providers.js';
export const MAX_LEASE_MS=30*86400_000;
export interface Registration {handle:string;provider:ProviderName;token:string;credentialHash:string;environment?:'sandbox'|'production';device:string;installationId:string;expiresAt:number;requestId:string;requestDigest:string}
export interface Installation {id:string;credentialHash:string;lastSeenAt:number;dailyLimit:number}
export interface Receipt {status:PushStatus;digest:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function deviceIdentity(r:{provider:ProviderName;token:string;environment?:'sandbox'|'production'}):string{return hash(r.provider+'\0'+r.token+(r.provider==='apns'?'\0'+(r.environment??'production'):''))}
/** Indexed point writes replace whole-state JSON rewrites. The legacy JSON is retained as a recovery copy. */
export class GatewayStore {
 readonly db:DatabaseSync;
 constructor(path:string,now:number,globalLimit:number,installationLimit:number,leaseMs:number){
  this.db=new DatabaseSync(path+'.sqlite');chmodSync(path+'.sqlite',0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE NOT NULL,last_seen_at INTEGER NOT NULL,daily_limit INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS installation_expiry ON installations(last_seen_at);
   CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,credential_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS invitation_expiry ON invitations(expires_at);
   CREATE TABLE IF NOT EXISTS registrations(handle TEXT PRIMARY KEY,installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,device TEXT NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(installation_id,request_id));
   CREATE INDEX IF NOT EXISTS registration_expiry ON registrations(expires_at);
   CREATE INDEX IF NOT EXISTS registration_device ON registrations(device);
   CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,handle TEXT NOT NULL REFERENCES registrations(handle) ON DELETE CASCADE,status TEXT NOT NULL,digest TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS receipt_handle ON receipts(handle);
   CREATE TABLE IF NOT EXISTS legacy_receipts(key TEXT PRIMARY KEY,status TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS legacy_receipt_expiry ON legacy_receipts(expires_at);
   CREATE TABLE IF NOT EXISTS quota(day TEXT NOT NULL,scope TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,scope));
   CREATE TABLE IF NOT EXISTS mipush(key TEXT PRIMARY KEY,handle TEXT NOT NULL,device TEXT NOT NULL,installation_id TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS mipush_time ON mipush(created_at);
   CREATE INDEX IF NOT EXISTS mipush_device ON mipush(device,created_at);
   CREATE INDEX IF NOT EXISTS mipush_handle ON mipush(handle,created_at);
   CREATE INDEX IF NOT EXISTS mipush_installation ON mipush(installation_id,created_at);`);
  try{if(!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get())this.transaction(()=>{
   if(existsSync(path))this.importLegacy(JSON.parse(readFileSync(path,'utf8')) as unknown,now,globalLimit,installationLimit,leaseMs);
   this.db.prepare("INSERT INTO metadata(key,value) VALUES('initialized','1')").run();
  });this.cleanup(now);if(this.reservedBudget()>globalLimit)throw Error('configured_capacity_below_reservations');}catch(error){this.db.close();throw error;}
 }
 close(){this.db.close()}
 transaction<T>(work:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result}catch(error){this.db.exec('ROLLBACK');throw error}}
 cleanup(now:number){this.transaction(()=>{
  this.db.prepare('DELETE FROM registrations WHERE expires_at<=?').run(now);
  this.db.prepare('DELETE FROM legacy_receipts WHERE expires_at<=?').run(now);
  this.db.prepare('DELETE FROM installations WHERE last_seen_at<=?').run(now-MAX_LEASE_MS);
  this.db.prepare('DELETE FROM invitations WHERE expires_at<=?').run(now);
  this.db.prepare('DELETE FROM quota WHERE day<?').run(new Date(now).toISOString().slice(0,10));
  this.db.prepare('DELETE FROM mipush WHERE created_at<=?').run(now-86400_000);
 })}
 installation(id:string):Installation|undefined {const r=this.db.prepare('SELECT id,credential_hash,last_seen_at,daily_limit FROM installations WHERE id=?').get(id);return r?{id:String(r.id),credentialHash:String(r.credential_hash),lastSeenAt:Number(r.last_seen_at),dailyLimit:Number(r.daily_limit)}:undefined}
 installationByCredential(credentialHash:string):Installation|undefined {const r=this.db.prepare('SELECT id FROM installations WHERE credential_hash=?').get(credentialHash);return r?this.installation(String(r.id)):undefined}
 touchInstallation(id:string,now:number){this.db.prepare('UPDATE installations SET last_seen_at=? WHERE id=?').run(now,id)}
 reservedBudget():number{return Number(this.db.prepare('SELECT COALESCE(SUM(daily_limit),0) AS count FROM installations').get()!.count)}
 putInstallation(value:Installation){this.db.prepare('INSERT INTO installations(id,credential_hash,last_seen_at,daily_limit) VALUES(?,?,?,?)').run(value.id,value.credentialHash,value.lastSeenAt,value.dailyLimit)}
 registration(handle:string):Registration|undefined {const r=this.db.prepare('SELECT payload FROM registrations WHERE handle=?').get(handle);return r?JSON.parse(String(r.payload)) as Registration:undefined}
 registrationByRequest(installationId:string,requestId:string):Registration|undefined {const r=this.db.prepare('SELECT handle FROM registrations WHERE installation_id=? AND request_id=?').get(installationId,requestId);return r?this.registration(String(r.handle)):undefined}
 registrationCount(installationId?:string):number{return Number(installationId?this.db.prepare('SELECT count(*) AS count FROM registrations WHERE installation_id=?').get(installationId)!.count:this.db.prepare('SELECT count(*) AS count FROM registrations').get()!.count)}
 putRegistration(value:Registration){this.db.prepare('INSERT INTO registrations(handle,installation_id,expires_at,device,request_id,request_digest,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET device=excluded.device,payload=excluded.payload').run(value.handle,value.installationId,value.expiresAt,value.device,value.requestId,value.requestDigest,JSON.stringify(value))}
 removeRegistration(handle:string){this.db.prepare('DELETE FROM registrations WHERE handle=?').run(handle)}
 removeDevice(device:string){this.db.prepare('DELETE FROM registrations WHERE device=?').run(device)}
 receipt(key:string):Receipt|undefined {const r=this.db.prepare('SELECT status,digest FROM receipts WHERE key=?').get(key);return r?{status:r.status as PushStatus,digest:String(r.digest)}:undefined}
 legacyReceipt(key:string,now:number):Receipt|undefined {const r=this.db.prepare('SELECT status,digest FROM legacy_receipts WHERE key=? AND expires_at>?').get(key,now);return r?{status:r.status as PushStatus,digest:String(r.digest)}:undefined}
 reserveReceipt(key:string,handle:string,digest:string){this.db.prepare("INSERT INTO receipts(key,handle,status,digest) VALUES(?,?,'unknown',?)").run(key,handle,digest)}
 finishReceipt(key:string,status:PushStatus){this.db.prepare('UPDATE receipts SET status=? WHERE key=?').run(status,key)}
 quota(day:string,scope:string):number{return Number(this.db.prepare('SELECT count FROM quota WHERE day=? AND scope=?').get(day,scope)?.count??0)}
 incrementQuota(day:string,scope:string){this.db.prepare('INSERT INTO quota(day,scope,count) VALUES(?,?,1) ON CONFLICT(day,scope) DO UPDATE SET count=count+1').run(day,scope)}
 mipushCount(column:'handle'|'device'|'installation_id',value:string,now:number):number{return Number(this.db.prepare(`SELECT count(*) AS count FROM mipush WHERE ${column}=? AND created_at>?`).get(value,now-86400_000)!.count)}
 recordMiPush(key:string,r:Registration,now:number){this.db.prepare('INSERT INTO mipush(key,handle,device,installation_id,created_at) VALUES(?,?,?,?,?)').run(key,r.handle,r.device,r.installationId,now)}
 private importLegacy(value:unknown,now:number,globalLimit:number,installationLimit:number,leaseMs:number){
  if(!value||typeof value!=='object')throw Error('invalid_legacy_state');
  const state=value as {version?:unknown;registrations?:unknown;receipts?:unknown;quota?:unknown;mipush?:unknown};
  const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  if(state.version!==1||!record(state.registrations)||!record(state.receipts)||!record(state.quota)||!record(state.mipush))throw Error('invalid_legacy_state');
  const byDevice=new Map<string,string>(),legacyDevices=new Map<string,Set<string>>();
  for(const [handle,raw] of Object.entries(state.registrations)){
   if(!record(raw)||!['apns','fcm','mipush'].includes(String(raw.provider))||typeof raw.token!=='string'||typeof raw.credentialHash!=='string'||typeof raw.device!=='string'||raw.environment!==undefined&&!['sandbox','production'].includes(String(raw.environment)))throw Error('invalid_legacy_state');
   const old=raw as unknown as Omit<Registration,'handle'|'installationId'|'expiresAt'|'requestId'|'requestDigest'>,r={...old,device:deviceIdentity(old)};
   const identities=legacyDevices.get(old.device)??new Set<string>();identities.add(r.device);legacyDevices.set(old.device,identities);let installationId=byDevice.get(r.device);
   if(!installationId){installationId='legacy-'+hash(r.device);byDevice.set(r.device,installationId);if(this.reservedBudget()+installationLimit>globalLimit)throw Error('migration_capacity_exceeded');this.putInstallation({id:installationId,credentialHash:'legacy-unusable-'+hash(r.device),lastSeenAt:now,dailyLimit:installationLimit})}
   this.putRegistration({...r,handle,installationId,expiresAt:now+leaseMs,requestId:handle,requestDigest:'legacy'});
  }
  // Legacy receipt keys are hashes of handle+notificationId and cannot be inverted.
  // Keep them separately for the migration lease; every legacy handle checks them before sending.
  this.db.exec('CREATE TABLE IF NOT EXISTS legacy_receipts(key TEXT PRIMARY KEY,status TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL)');
  for(const [key,raw] of Object.entries(state.receipts)){if(!record(raw)||!['accepted','invalid_token','quota_exceeded','rejected','unknown'].includes(String(raw.status))||typeof raw.digest!=='string')throw Error('invalid_legacy_state');this.db.prepare('INSERT INTO legacy_receipts(key,status,digest,expires_at) VALUES(?,?,?,?)').run(key,String(raw.status),raw.digest,now+leaseMs)}
  const q=state.quota;if(typeof q.day!=='string'||!Number.isSafeInteger(q.global)||!record(q.handles)||!record(q.devices))throw Error('invalid_legacy_state');
  const putQuota=(scope:string,count:unknown)=>{if(!Number.isSafeInteger(count)||Number(count)<0)throw Error('invalid_legacy_state');this.db.prepare('INSERT INTO quota(day,scope,count) VALUES(?,?,?)').run(String(q.day),scope,Number(count))};
  putQuota('global',q.global);for(const [handle,count] of Object.entries(q.handles))putQuota('h:'+handle,count);for(const [device,count] of Object.entries(q.devices)){for(const current of legacyDevices.get(device)??[device]){putQuota('d:'+current,count);const installation=byDevice.get(current);if(installation)putQuota('i:'+installation,count)}}
  for(const [device,raw] of Object.entries(state.mipush)){if(!Array.isArray(raw)||raw.some(t=>!Number.isSafeInteger(t)))throw Error('invalid_legacy_state');for(const [index,time] of raw.entries()){if(Number(time)<=now-86400_000)continue;const isHandle=device.startsWith('h:'),handle=isHandle?device.slice(2):'';this.db.prepare('INSERT INTO mipush(key,handle,device,installation_id,created_at) VALUES(?,?,?,?,?)').run('legacy-'+hash(device+':'+index),handle,isHandle?'':device,isHandle?'':byDevice.get(device)??'',Number(time))}}
 }
}
