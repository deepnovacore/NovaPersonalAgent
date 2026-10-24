import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {assertId,assertPrincipal,RelayError,validateEnvelope,type RelayAuthority,type RelayEnvelope,type RelayPrincipal} from './protocol.js';
import {deviceFingerprint,spaceId,validatePublicKey,verifyControl,verifyEnvelope,type JWK} from './crypto.js';
export interface DevicePublicIdentity {device:string;signingPublicKey:JWK;encryptionPublicKey:JWK}
export interface DeviceRecord extends DevicePublicIdentity {business_versions:number[];selected_version:number}
export interface SpaceRecord {space:string;host:string;epoch:number}
export interface LoginChallenge {id:string;nonce:string;space:string;device:string;epoch:number;expiresAt:number}
export interface PairingRequest extends DeviceRecord {id:string;space:string;expiresAt:number;fingerprint:string}
export interface Invitation {id:string;space:string;secret:string;expiresAt:number;host:string;hostSigningPublicKey:JWK;business_versions:number[]}
export interface PairingInput extends DevicePublicIdentity {invitationId:string;secret:string;proof:string;business_versions:number[]}
interface SecurityOptions {bootstrapToken:string;now?:()=>number;maxSpaces?:number;maxDevicesPerSpace?:number;maxPendingPerSpace?:number;maxSessionsPerSpace?:number;maxControlOperations?:number}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function equal(left:string,right:string):boolean {const a=Buffer.from(left);const b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function deviceInput(input:DevicePublicIdentity):DevicePublicIdentity {
 assertId(input.device);validatePublicKey(input.signingPublicKey,'signing');validatePublicKey(input.encryptionPublicKey,'encryption');
 // Store only public standard members, ignoring unsupported caller metadata.
 return {device:input.device,signingPublicKey:{kty:'OKP',crv:'Ed25519',x:input.signingPublicKey.x!},
  encryptionPublicKey:{kty:'EC',crv:'P-256',x:input.encryptionPublicKey.x!,y:input.encryptionPublicKey.y!}};
}
function businessVersions(input:unknown):number[] {
 if(!Array.isArray(input)||input.length<1||input.length>16||input.some(v=>!Number.isSafeInteger(v)||v<1)||new Set(input).size!==input.length)throw new RelayError('invalid_business_versions');
 return [...input] as number[];
}
const supportedBusinessVersions=[1];
/** Durable public membership only. No endpoint private keys or content keys belong here. */
export class SecurityStore implements RelayAuthority {
 private readonly db:DatabaseSync;private readonly clock:()=>number;
 private readonly maxSpaces:number;private readonly maxDevices:number;private readonly maxPending:number;private readonly maxSessions:number;private readonly maxOperations:number;
 constructor(path:string,private readonly options:SecurityOptions){
  if(typeof options?.bootstrapToken!=='string'||options.bootstrapToken.length<24)throw new RelayError('bootstrap_token_required');
  this.clock=options.now??Date.now;this.maxSpaces=options.maxSpaces??10000;this.maxDevices=options.maxDevicesPerSpace??64;
  this.maxPending=options.maxPendingPerSpace??32;this.maxSessions=options.maxSessionsPerSpace??512;this.maxOperations=options.maxControlOperations??10000;
  for(const n of [this.maxSpaces,this.maxDevices,this.maxPending,this.maxSessions,this.maxOperations])if(!Number.isSafeInteger(n)||n<1)throw new RelayError('invalid_options');
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS security_clock (id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
   INSERT OR IGNORE INTO security_clock VALUES(1,0);
   CREATE TABLE IF NOT EXISTS security_spaces(space TEXT PRIMARY KEY,host TEXT NOT NULL,epoch INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_devices(space TEXT NOT NULL,device TEXT NOT NULL,signing TEXT NOT NULL,encryption TEXT NOT NULL,versions TEXT NOT NULL,selected INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(space,device),UNIQUE(space,signing));
   CREATE TABLE IF NOT EXISTS security_challenges(id TEXT PRIMARY KEY,space TEXT NOT NULL,device TEXT NOT NULL,epoch INTEGER NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_sessions(hash TEXT PRIMARY KEY,space TEXT NOT NULL,device TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_invitations(id TEXT PRIMARY KEY,space TEXT NOT NULL,secret TEXT NOT NULL,expires INTEGER NOT NULL,versions TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS security_requests(id TEXT PRIMARY KEY,space TEXT NOT NULL,device TEXT NOT NULL,signing TEXT NOT NULL,encryption TEXT NOT NULL,expires INTEGER NOT NULL,versions TEXT NOT NULL,selected INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_operations(space TEXT NOT NULL,op_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,epoch INTEGER NOT NULL,response TEXT NOT NULL,PRIMARY KEY(space,op_id));
   CREATE TABLE IF NOT EXISTS security_pairing_claims(invitation TEXT PRIMARY KEY,space TEXT NOT NULL,digest TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL,response TEXT NOT NULL);`);
 }
 private transaction<T>(fn:()=>T):T{this.now();this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private now():number {
  const value=this.clock();if(!Number.isSafeInteger(value)||value<0)throw new RelayError('invalid_clock');
  this.db.prepare('UPDATE security_clock SET value=max(value,?) WHERE id=1').run(value);
  return Number(this.db.prepare('SELECT value FROM security_clock WHERE id=1').get()!.value);
 }
 private cleanup(space:string):void{const now=this.now();for(const table of ['security_challenges','security_sessions','security_invitations','security_requests','security_pairing_claims'])this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(now);
  // A receipt can only be replayed at its result epoch. Remove invalid history, never a live receipt.
  this.db.prepare('DELETE FROM security_operations WHERE space=? AND epoch<>(SELECT epoch FROM security_spaces WHERE space=?)').run(space,space);
 }
 private capacity(table:string,space:string,limit:number):void {if(Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE space=?`).get(space)!.n)>=limit)throw new RelayError('security_capacity_exceeded');}
 private device(space:string,device:string):DeviceRecord {
  assertId(space);assertId(device);const row=this.db.prepare('SELECT signing,encryption,versions,selected FROM security_devices WHERE space=? AND device=? AND revoked=0').get(space,device);
  if(!row)throw new RelayError('device_inactive');return {device,signingPublicKey:JSON.parse(String(row.signing)),encryptionPublicKey:JSON.parse(String(row.encryption)),business_versions:JSON.parse(String(row.versions)),selected_version:Number(row.selected)};
 }
 private host(p:RelayPrincipal):SpaceRecord {this.assertActive(p);const s=this.getSpace(p.space);if(s.host!==p.device)throw new RelayError('host_required');return s;}
 private proof(proof:string,key:JWK,payload:unknown):void {if(JSON.stringify(verifyControl(proof,key))!==JSON.stringify(payload))throw new RelayError('invalid_signature');}
 createSpace(input:{space:string;host:DevicePublicIdentity;proof:string},bootstrapToken:string):SpaceRecord {
  if(typeof bootstrapToken!=='string'||!equal(hash(bootstrapToken),hash(this.options.bootstrapToken)))throw new RelayError('bootstrap_denied');
  assertId(input.space);const host=deviceInput(input.host);
  if(spaceId(host.signingPublicKey)!==input.space)throw new RelayError('invalid_space_identity');
  this.proof(input.proof,host.signingPublicKey,{v:1,purpose:'space-create',space:input.space,host:input.host});
  return this.transaction(()=>{
   if(this.db.prepare('SELECT 1 FROM security_spaces WHERE space=?').get(input.space))throw new RelayError('space_exists');
   if(Number(this.db.prepare('SELECT count(*) AS n FROM security_spaces').get()!.n)>=this.maxSpaces)throw new RelayError('security_capacity_exceeded');
   this.db.prepare('INSERT INTO security_spaces VALUES(?,?,1)').run(input.space,host.device);
   this.db.prepare('INSERT INTO security_devices(space,device,signing,encryption,versions,selected) VALUES(?,?,?,?,?,?)').run(input.space,host.device,JSON.stringify(host.signingPublicKey),JSON.stringify(host.encryptionPublicKey),JSON.stringify(supportedBusinessVersions),1);
   return {space:input.space,host:host.device,epoch:1};
  });
 }
 getSpace(space:string):SpaceRecord {assertId(space);const row=this.db.prepare('SELECT space,host,epoch FROM security_spaces WHERE space=?').get(space);if(!row)throw new RelayError('space_unknown');return {space:String(row.space),host:String(row.host),epoch:Number(row.epoch)};}
 assertActive(p:RelayPrincipal):void {assertPrincipal(p);this.device(p.space,p.device);if(this.getSpace(p.space).epoch!==p.epoch)throw new RelayError('stale_epoch');}
 assertCanSend(p:RelayPrincipal,e:RelayEnvelope):void {
  this.assertActive(p);validateEnvelope(e,p,1024*1024);this.device(p.space,e.to);verifyEnvelope(e,this.device(p.space,p.device).signingPublicKey);
  // Star topology: Clients may only address the fixed Host.
  const host=this.getSpace(p.space).host;if(p.device!==host&&e.to!==host)throw new RelayError('host_route_required');
 }
 listDevices(p:RelayPrincipal):DeviceRecord[]{this.assertActive(p);return this.db.prepare('SELECT device FROM security_devices WHERE space=? AND revoked=0 ORDER BY device').all(p.space).map(r=>this.device(p.space,String(r.device)));}
 beginLogin(space:string,device:string):LoginChallenge {
  this.device(space,device);return this.transaction(()=>{this.device(space,device);this.cleanup(space);this.capacity('security_challenges',space,this.maxPending);
   const value={id:randomUUID(),nonce:randomBytes(32).toString('base64url'),space,device,epoch:this.getSpace(space).epoch,expiresAt:this.now()+60_000};
   this.db.prepare('INSERT INTO security_challenges VALUES(?,?,?,?,?,?)').run(value.id,space,device,value.epoch,value.nonce,value.expiresAt);return value;
  });
 }
 completeLogin(input:{challengeId:string;proof:string}):{token:string;principal:RelayPrincipal;expiresAt:number;selected_version:number}{
  assertId(input.challengeId);return this.transaction(()=>{
   const row=this.db.prepare('SELECT * FROM security_challenges WHERE id=?').get(input.challengeId);if(!row||Number(row.expires)<=this.now())throw new RelayError('invalid_challenge');
   const principal={space:String(row.space),device:String(row.device),epoch:Number(row.epoch)};this.assertActive(principal);
   this.proof(input.proof,this.device(principal.space,principal.device).signingPublicKey,{v:1,purpose:'relay-login',challengeId:input.challengeId,nonce:row.nonce,...principal,expiresAt:Number(row.expires)});
   this.cleanup(principal.space);this.capacity('security_sessions',principal.space,this.maxSessions);const token=randomBytes(32).toString('base64url');const expiresAt=this.now()+900_000;
   this.db.prepare('DELETE FROM security_challenges WHERE id=?').run(input.challengeId);
   this.db.prepare('INSERT INTO security_sessions VALUES(?,?,?,?,?)').run(hash(token),principal.space,principal.device,principal.epoch,expiresAt);return {token,principal,expiresAt,selected_version:this.device(principal.space,principal.device).selected_version};
  });
 }
 authenticate(header:string|undefined):RelayPrincipal {
  if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))throw new RelayError('unauthorized');
  const row=this.db.prepare('SELECT * FROM security_sessions WHERE hash=?').get(hash(header.slice(7)));
  if(!row||Number(row.expires)<=this.now())throw new RelayError('unauthorized');
  const p={space:String(row.space),device:String(row.device),epoch:Number(row.epoch)};try{this.assertActive(p);}catch{throw new RelayError('unauthorized');}return p;
 }
 private operation<T>(p:RelayPrincipal,opId:string,kind:string,target:string):T|undefined {
  const row=this.db.prepare('SELECT * FROM security_operations WHERE space=? AND op_id=?').get(p.space,opId);
  if(!row)return undefined;
  if(row.kind!==kind||row.target!==target)throw new RelayError('op_conflict');
  if(Number(row.epoch)!==this.getSpace(p.space).epoch)throw new RelayError('stale_control_receipt');
  return JSON.parse(String(row.response)) as T;
 }
 private operationCapacity(space:string):void {
  this.cleanup(space);
  // One current-epoch revocation receipt has reserved capacity, independently of confirmations.
  if(Number(this.db.prepare("SELECT count(*) AS n FROM security_operations WHERE space=? AND kind='confirm'").get(space)!.n)>=this.maxOperations)throw new RelayError('security_capacity_exceeded');
 }
 private recordOperation(p:RelayPrincipal,opId:string,kind:string,target:string,epoch:number,result:unknown):void {
  this.db.prepare('INSERT INTO security_operations VALUES(?,?,?,?,?,?)').run(p.space,opId,kind,target,epoch,JSON.stringify(result));
 }
 createInvitation(p:RelayPrincipal,options:{ttlMs?:number;business_versions?:number[]}={}):Invitation {
  const s=this.host(p);const ttl=options.ttlMs??300_000;if(!Number.isSafeInteger(ttl)||ttl<1||ttl>600_000)throw new RelayError('invalid_ttl');
  const versions=businessVersions(options.business_versions??supportedBusinessVersions);
  if(versions.some(v=>!supportedBusinessVersions.includes(v)))throw new RelayError('unsupported_business_version');
  return this.transaction(()=>{this.host(p);this.cleanup(p.space);this.capacity('security_invitations',p.space,this.maxPending);
   const value={id:randomUUID(),space:p.space,secret:randomBytes(32).toString('base64url'),expiresAt:this.now()+ttl,host:s.host,hostSigningPublicKey:this.device(p.space,s.host).signingPublicKey,business_versions:versions};
   this.db.prepare('INSERT INTO security_invitations VALUES(?,?,?,?,?)').run(value.id,p.space,hash(value.secret),value.expiresAt,JSON.stringify(versions));return value;
  });
 }
 requestPairing(input:PairingInput):PairingRequest {
  assertId(input.invitationId);const d=deviceInput(input);const versions=businessVersions(input.business_versions);
  if(typeof input.secret!=='string'||input.secret.length>100)throw new RelayError('invalid_invitation');
  const payload={v:1,purpose:'pair-request',invitationId:input.invitationId,secret:input.secret,device:input.device,signingPublicKey:input.signingPublicKey,encryptionPublicKey:input.encryptionPublicKey,business_versions:input.business_versions};
  this.proof(input.proof,d.signingPublicKey,payload);const digest=hash(JSON.stringify(payload));
  return this.transaction(()=>{
   const claim=this.db.prepare('SELECT * FROM security_pairing_claims WHERE invitation=?').get(input.invitationId);
   if(claim){
    if(Number(claim.expires)<=this.now()||Number(claim.epoch)!==this.getSpace(String(claim.space)).epoch)throw new RelayError('invalid_invitation');
    if(claim.digest!==digest)throw new RelayError('id_conflict');
    return JSON.parse(String(claim.response)) as PairingRequest;
   }
   const row=this.db.prepare('SELECT * FROM security_invitations WHERE id=?').get(input.invitationId);
   if(!row||Number(row.expires)<=this.now()||!equal(String(row.secret),hash(input.secret)))throw new RelayError('invalid_invitation');
   const advertised=businessVersions(JSON.parse(String(row.versions)));
   const compatible=versions.filter(v=>advertised.includes(v)&&supportedBusinessVersions.includes(v));
   if(!compatible.length)throw new RelayError('unsupported_business_version');
   const selected=Math.max(...compatible),space=String(row.space);
   if(this.db.prepare('SELECT 1 FROM security_devices WHERE space=? AND (device=? OR signing=?)').get(space,d.device,JSON.stringify(d.signingPublicKey)))throw new RelayError('device_exists');
   this.cleanup(space);this.capacity('security_requests',space,this.maxPending);
   this.capacity('security_pairing_claims',space,this.maxPending);
   const request={id:randomUUID(),space,...d,expiresAt:Number(row.expires),fingerprint:deviceFingerprint(d.signingPublicKey,d.encryptionPublicKey),business_versions:versions,selected_version:selected};
   this.db.prepare('INSERT INTO security_requests VALUES(?,?,?,?,?,?,?,?)').run(request.id,space,d.device,JSON.stringify(d.signingPublicKey),JSON.stringify(d.encryptionPublicKey),request.expiresAt,JSON.stringify(versions),selected);
   this.db.prepare('INSERT INTO security_pairing_claims VALUES(?,?,?,?,?,?)').run(input.invitationId,space,digest,this.getSpace(space).epoch,request.expiresAt,JSON.stringify(request));
   this.db.prepare('DELETE FROM security_invitations WHERE id=?').run(input.invitationId);return request;
  });
 }
 pendingPairings(p:RelayPrincipal):PairingRequest[]{this.host(p);return this.db.prepare('SELECT * FROM security_requests WHERE space=? AND expires>? ORDER BY id').all(p.space,this.now()).map(row=>({id:String(row.id),space:p.space,device:String(row.device),signingPublicKey:JSON.parse(String(row.signing)),encryptionPublicKey:JSON.parse(String(row.encryption)),expiresAt:Number(row.expires),fingerprint:deviceFingerprint(JSON.parse(String(row.signing)),JSON.parse(String(row.encryption))),business_versions:JSON.parse(String(row.versions)),selected_version:Number(row.selected)}));}
 confirmPairing(p:RelayPrincipal,id:string,opId:string):DeviceRecord {
  this.host(p);assertId(id);assertId(opId);return this.transaction(()=>{
   this.host(p);const replay=this.operation<DeviceRecord>(p,opId,'confirm',id);if(replay)return replay;
   this.operationCapacity(p.space);const row=this.db.prepare('SELECT * FROM security_requests WHERE id=? AND space=?').get(id,p.space);if(!row||Number(row.expires)<=this.now())throw new RelayError('invalid_pairing_request');
   this.capacity('security_devices',p.space,this.maxDevices);
   if(this.db.prepare('SELECT 1 FROM security_devices WHERE space=? AND (device=? OR signing=?)').get(p.space,row.device!,row.signing!))throw new RelayError('device_exists');
   this.db.prepare('INSERT INTO security_devices(space,device,signing,encryption,versions,selected) VALUES(?,?,?,?,?,?)').run(p.space,row.device!,row.signing!,row.encryption!,row.versions!,row.selected!);
   this.db.prepare('DELETE FROM security_requests WHERE id=?').run(id);
   const result=this.device(p.space,String(row.device));this.recordOperation(p,opId,'confirm',id,p.epoch,result);return result;
  });
 }
 revokeDevice(p:RelayPrincipal,device:string,opId:string):{epoch:number;remainingDevices:DeviceRecord[]} {
  const s=this.host(p);assertId(device);assertId(opId);if(device===s.host)throw new RelayError('cannot_revoke_host');
  return this.transaction(()=>{
   const current=this.host(p);const replay=this.operation<{epoch:number;remainingDevices:DeviceRecord[]}>(p,opId,'revoke',device);if(replay)return replay;
   this.device(p.space,device);const epoch=current.epoch+1;if(!Number.isSafeInteger(epoch))throw new RelayError('epoch_exhausted');
   this.db.prepare('UPDATE security_devices SET revoked=1 WHERE space=? AND device=?').run(p.space,device);
   this.db.prepare('UPDATE security_spaces SET epoch=? WHERE space=?').run(epoch,p.space);
   for(const table of ['security_sessions','security_challenges','security_invitations','security_requests','security_pairing_claims'])this.db.prepare(`DELETE FROM ${table} WHERE space=?`).run(p.space);
   // Advancing the epoch invalidates all prior receipts, including confirmations. Revocation
   // must remain available at capacity, and its new receipt must survive response loss/restart.
   this.db.prepare('DELETE FROM security_operations WHERE space=?').run(p.space);
   const result={epoch,remainingDevices:this.listDevices({...p,epoch})};this.recordOperation(p,opId,'revoke',device,epoch,result);return result;
  });
 }
 close():void{this.db.close();}
}
export function authenticate(store:SecurityStore,authorization:string|undefined):RelayPrincipal{return store.authenticate(authorization);}
