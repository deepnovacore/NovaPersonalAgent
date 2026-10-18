import type {DatabaseSync} from 'node:sqlite'
import {authorityRecordSchema,deviceKind,spaceId,transitionSchema,validatePublication,type AuthorityRecord,type DeviceKind} from '../device/space-authority.js'

interface Device {account_id:string;device_id:string;epoch:number}

/** The Hub serializes relationship changes; it never generates a profile. */
export class HubSpaceAuthority {
 constructor(private readonly db:DatabaseSync,private readonly authenticate:(token:string)=>Device){
  db.exec(`CREATE TABLE IF NOT EXISTS hub_authority(account_id TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS hub_authority_receipts(account_id TEXT NOT NULL,transition_id TEXT NOT NULL,initiator TEXT NOT NULL,target TEXT NOT NULL,expected_epoch INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(account_id,transition_id));`)
 }
 private transaction<T>(action:()=>T):T {
  this.db.exec('BEGIN IMMEDIATE')
  try{const value=action();this.db.exec('COMMIT');return value}catch(error){this.db.exec('ROLLBACK');throw error}
 }
 private read(account:string):AuthorityRecord|null {
  const row=this.db.prepare('SELECT value FROM hub_authority WHERE account_id=?').get(account)
  return row?authorityRecordSchema.parse(JSON.parse(String(row.value))):null
 }
 private save(record:AuthorityRecord):AuthorityRecord {
  const parsed=authorityRecordSchema.parse(record)
  this.db.prepare('INSERT INTO hub_authority VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET value=excluded.value').run(parsed.space_id,JSON.stringify(parsed))
  return parsed
 }
 private kind(account:string,id:string):DeviceKind {
  const row=this.db.prepare('SELECT kind FROM hub_devices WHERE account_id=? AND device_id=? AND revoked=0').get(account,id)
  if(!row)throw Error('device_unavailable')
  return deviceKind.parse(row.kind)
 }
 snapshot(token:string){return this.read(this.authenticate(token).account_id)}
 members(token:string){return this.db.prepare('SELECT device_id,kind,revoked FROM hub_devices WHERE account_id=? ORDER BY device_id').all(this.authenticate(token).account_id)}
 initialize(token:string):AuthorityRecord {
  return this.transaction(()=>{
   const device=this.authenticate(token),existing=this.read(device.account_id)
   if(existing){try{this.kind(device.account_id,existing.primary_device_id)}catch{throw Error('recovery_required')}return existing}
   const kind=this.kind(device.account_id,device.device_id)
   if(!['mobile','desktop'].includes(kind))throw Error('device_kind_required')
   return this.save({protocol_version:1,space_id:device.account_id,authority_epoch:1,membership_revision:1,
    primary_device_id:device.device_id,mode:kind==='desktop'?'pc_primary':'mobile_primary',pending:null})
  })
 }
 prepare(token:string,raw:unknown):AuthorityRecord {
  const request=transitionSchema.parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),record=this.read(device.account_id)
   if(!record)throw Error('authority_uninitialized')
   if(record.primary_device_id!==device.device_id)throw Error('primary_required')
   if(record.authority_epoch!==request.expected_epoch)throw Error('stale_authority')
   if(record.pending){
    const old=record.pending
    if(old.transition_id===request.transition_id&&old.target_device_id===request.target_device_id)return record
    throw Error('authority_transition')
   }
   if(this.db.prepare('SELECT 1 FROM hub_authority_receipts WHERE account_id=? AND transition_id=?').get(device.account_id,request.transition_id))throw Error('transition_id_conflict')
   if(request.target_device_id===device.device_id)throw Error('already_primary')
   const kind=this.kind(device.account_id,request.target_device_id)
   if(!['mobile','desktop'].includes(kind))throw Error('device_kind_required')
   if(kind!=='desktop'&&(record.mode==='pc_primary'||this.db.prepare("SELECT 1 FROM hub_devices WHERE account_id=? AND kind='desktop' AND revoked=0").get(device.account_id)))throw Error('pc_primary_required')
   record.pending={...request,from_device_id:device.device_id,acknowledged:[device.device_id]}
   record.membership_revision++
   return this.save(record)
  })
 }
 acknowledge(token:string,transitionId:string):AuthorityRecord {
  spaceId.parse(transitionId)
  return this.transaction(()=>{
   const device=this.authenticate(token),record=this.read(device.account_id),pending=record?.pending
   if(!record||pending?.transition_id!==transitionId)throw Error('transition_not_found')
   if(device.device_id!==pending.target_device_id)throw Error('recipient_required')
   this.kind(device.account_id,pending.from_device_id)
   if(!pending.acknowledged.includes(device.device_id)){pending.acknowledged.push(device.device_id);record.membership_revision++}
   return this.save(record)
  })
 }
 commit(token:string,transitionId:string):AuthorityRecord {
  spaceId.parse(transitionId)
  return this.transaction(()=>{
   const device=this.authenticate(token)
   const receipt=this.db.prepare('SELECT initiator,value FROM hub_authority_receipts WHERE account_id=? AND transition_id=?').get(device.account_id,transitionId)
   if(receipt){if(receipt.initiator!==device.device_id)throw Error('primary_required');return authorityRecordSchema.parse(JSON.parse(String(receipt.value)))}
   const record=this.read(device.account_id),pending=record?.pending
   if(!record||pending?.transition_id!==transitionId)throw Error('transition_not_found')
   if(pending.from_device_id!==device.device_id)throw Error('primary_required')
   if(!pending.acknowledged.includes(pending.target_device_id))throw Error('handoff_incomplete')
   const kind=this.kind(device.account_id,pending.target_device_id)
   const next=this.save({...record,primary_device_id:pending.target_device_id,mode:kind==='desktop'?'pc_primary':'mobile_primary',
    authority_epoch:record.authority_epoch+1,membership_revision:record.membership_revision+1,pending:null})
   this.db.prepare('INSERT INTO hub_authority_receipts VALUES(?,?,?,?,?,?)').run(device.account_id,transitionId,device.device_id,pending.target_device_id,pending.expected_epoch,JSON.stringify(next))
   return next
  })
 }
 cancel(token:string,transitionId:string):AuthorityRecord {
  spaceId.parse(transitionId)
  return this.transaction(()=>{
   const device=this.authenticate(token),record=this.read(device.account_id)
   if(record?.pending?.transition_id!==transitionId)throw Error('transition_not_found')
   if(record.primary_device_id!==device.device_id)throw Error('primary_required')
   return this.save({...record,membership_revision:record.membership_revision+1,pending:null})
  })
 }
 validatePublisher(token:string,epoch:number):AuthorityRecord {
  const device=this.authenticate(token),record=this.read(device.account_id)
  if(!record)throw Error('authority_uninitialized')
  validatePublication(record,device.device_id,epoch)
  return record
 }
 /** Local operator command only; never exposed as an account-device HTTP route. */
 recover(account:string,raw:unknown):AuthorityRecord {
  spaceId.parse(account)
  const request=transitionSchema.extend({retired_device_id:spaceId}).strict().parse(raw)
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT initiator,target,expected_epoch,value FROM hub_authority_receipts WHERE account_id=? AND transition_id=?').get(account,request.transition_id)
   const initiator='retired:'+request.retired_device_id
   if(prior){if(prior.initiator!==initiator||prior.target!==request.target_device_id||Number(prior.expected_epoch)!==request.expected_epoch)throw Error('transition_id_conflict');return authorityRecordSchema.parse(JSON.parse(String(prior.value)))}
   const record=this.read(account)
   if(record?.authority_epoch!==request.expected_epoch)throw Error('stale_authority')
   if(record.primary_device_id!==request.retired_device_id||request.retired_device_id===request.target_device_id)throw Error('retired_primary_required')
   const kind=this.kind(account,request.target_device_id)
   if(!['desktop','mobile'].includes(kind))throw Error('device_kind_required')
   if(kind==='mobile'&&this.db.prepare("SELECT 1 FROM hub_devices WHERE account_id=? AND kind='desktop' AND revoked=0 AND device_id<>?").get(account,request.retired_device_id))throw Error('pc_primary_required')
   this.db.prepare('UPDATE hub_devices SET revoked=1 WHERE account_id=? AND device_id=?').run(account,request.retired_device_id)
   const next=this.save({...record,authority_epoch:record.authority_epoch+1,membership_revision:record.membership_revision+1,primary_device_id:request.target_device_id,mode:kind==='desktop'?'pc_primary':'mobile_primary',pending:null})
   this.db.prepare('INSERT INTO hub_authority_receipts VALUES(?,?,?,?,?,?)').run(account,request.transition_id,initiator,request.target_device_id,request.expected_epoch,JSON.stringify(next))
   return next
  })
 }
}
