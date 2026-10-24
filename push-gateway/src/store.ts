import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {ProviderName,PushStatus} from './providers.js';
export const MAX_LEASE_MS=30*86400_000;
export interface Registration {handle:string;provider:ProviderName;token:string;credentialHash:string;environment?:'sandbox'|'production';device:string;installationId:string;expiresAt:number;requestId:string;requestDigest:string}
export interface Installation {id:string;credentialHash:string;lastSeenAt:number;dailyLimit:number}
export interface Receipt {status:PushStatus;digest:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function deviceIdentity(r:{provider:ProviderName;token:string;environment?:'sandbox'|'production'}):string{return hash(r.provider+'\0'+r.token+(r.provider==='apns'?'\0'+(r.environment??'production'):''))}
/** Indexed, transactional storage for installations, registrations and receipts. */
export class GatewayStore {
 readonly db:DatabaseSync;
 constructor(path:string,now:number,globalLimit:number){
  this.db=new DatabaseSync(path+'.sqlite');chmodSync(path+'.sqlite',0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE NOT NULL,last_seen_at INTEGER NOT NULL,daily_limit INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS installation_expiry ON installations(last_seen_at);
   CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,credential_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS invitation_expiry ON invitations(expires_at);
   CREATE TABLE IF NOT EXISTS registrations(handle TEXT PRIMARY KEY,installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,device TEXT NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(installation_id,request_id));
   CREATE INDEX IF NOT EXISTS registration_expiry ON registrations(expires_at);
   CREATE INDEX IF NOT EXISTS registration_device ON registrations(device);
   CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,handle TEXT NOT NULL REFERENCES registrations(handle) ON DELETE CASCADE,status TEXT NOT NULL,digest TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS receipt_handle ON receipts(handle);
   CREATE TABLE IF NOT EXISTS quota(day TEXT NOT NULL,scope TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,scope));
   CREATE TABLE IF NOT EXISTS mipush(key TEXT PRIMARY KEY,handle TEXT NOT NULL,device TEXT NOT NULL,installation_id TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS mipush_time ON mipush(created_at);
   CREATE INDEX IF NOT EXISTS mipush_device ON mipush(device,created_at);
   CREATE INDEX IF NOT EXISTS mipush_handle ON mipush(handle,created_at);
   CREATE INDEX IF NOT EXISTS mipush_installation ON mipush(installation_id,created_at);`);
  try{this.cleanup(now);if(this.reservedBudget()>globalLimit)throw Error('configured_capacity_below_reservations');}catch(error){this.db.close();throw error;}
 }
 close(){this.db.close()}
 transaction<T>(work:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result}catch(error){this.db.exec('ROLLBACK');throw error}}
 cleanup(now:number){this.transaction(()=>{
  this.db.prepare('DELETE FROM registrations WHERE expires_at<=?').run(now);
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
 reserveReceipt(key:string,handle:string,digest:string){this.db.prepare("INSERT INTO receipts(key,handle,status,digest) VALUES(?,?,'unknown',?)").run(key,handle,digest)}
 finishReceipt(key:string,status:PushStatus){this.db.prepare('UPDATE receipts SET status=? WHERE key=?').run(status,key)}
 quota(day:string,scope:string):number{return Number(this.db.prepare('SELECT count FROM quota WHERE day=? AND scope=?').get(day,scope)?.count??0)}
 incrementQuota(day:string,scope:string){this.db.prepare('INSERT INTO quota(day,scope,count) VALUES(?,?,1) ON CONFLICT(day,scope) DO UPDATE SET count=count+1').run(day,scope)}
 mipushCount(column:'handle'|'device'|'installation_id',value:string,now:number):number{return Number(this.db.prepare(`SELECT count(*) AS count FROM mipush WHERE ${column}=? AND created_at>?`).get(value,now-86400_000)!.count)}
 recordMiPush(key:string,r:Registration,now:number){this.db.prepare('INSERT INTO mipush(key,handle,device,installation_id,created_at) VALUES(?,?,?,?,?)').run(key,r.handle,r.device,r.installationId,now)}
}
