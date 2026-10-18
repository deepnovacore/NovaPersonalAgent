import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {spaceId} from './space-authority.js'
import type {HubSpaceAuthority} from '../hub/space-authority.js'
import {scheduleInputSchema,scheduleHash} from '../personal-agent/scheduled-tasks.js'

const revision=z.number().int().positive(),instant=z.string().datetime()
const claimSchema=z.object({run_id:spaceId,slot_key:z.string().min(1).max(512),scheduled_at:instant,status:z.enum(['reserved','running','terminal']),task_id:z.string().nullable()}).strict()
export const sharedScheduleSchema=z.object({id:spaceId,owner_device_id:spaceId,revision,enabled:z.boolean().default(true),definition:scheduleInputSchema,frontier:instant,claims:z.record(z.string(),claimSchema),pending:z.object({id:spaceId,target:spaceId,ack:z.boolean()}).nullable()}).strict()
const ownerSchema=sharedScheduleSchema
export type SharedSchedule=z.infer<typeof ownerSchema>
/** A device owns execution until a drained, explicit handoff. Presence is irrelevant. */
export class ScheduleOwnership {
 constructor(private db:DatabaseSync,private authenticate:(token:string)=>{account_id:string;device_id:string},private authority:HubSpaceAuthority){db.exec('CREATE TABLE IF NOT EXISTS hub_schedule_owners(account_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(account_id,id))')}
 private tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
 private get(account:string,id:string):SharedSchedule{const row=this.db.prepare('SELECT value FROM hub_schedule_owners WHERE account_id=? AND id=?').get(account,id);if(!row)throw Error('shared_schedule_missing');return ownerSchema.parse(JSON.parse(String(row.value)))}
 private save(account:string,value:SharedSchedule){if(Object.keys(value.claims).length>4096)throw Error('schedule_capacity');this.db.prepare('INSERT INTO hub_schedule_owners VALUES(?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET value=excluded.value').run(account,value.id,JSON.stringify(ownerSchema.parse(value)));return value}
 list(token:string){const device=this.authenticate(token);return this.db.prepare('SELECT value FROM hub_schedule_owners WHERE account_id=?').all(device.account_id).map(r=>ownerSchema.parse(JSON.parse(String(r.value))))}
 register(token:string,raw:unknown){
  const q=z.object({id:spaceId,authority_epoch:revision,definition:scheduleInputSchema,frontier:instant}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token);this.authority.validatePublisher(token,q.authority_epoch)
   const kind=this.db.prepare('SELECT kind FROM hub_devices WHERE account_id=? AND device_id=?').get(device.account_id,device.device_id)?.kind
   if(kind!=='desktop')throw Error('pc_primary_required')
   const existing=this.list(token).find(v=>v.id===q.id)
   if(existing){if(existing.owner_device_id!==device.device_id||scheduleHash(existing.definition)!==scheduleHash(q.definition))throw Error('shared_schedule_conflict');return existing}
   if(this.list(token).length>=64)throw Error('schedule_capacity')
   return this.save(device.account_id,{id:q.id,owner_device_id:device.device_id,revision:1,enabled:true,definition:q.definition,frontier:q.frontier,claims:{},pending:null})
  })
 }
 claim(token:string,raw:unknown){
  const q=z.object({id:spaceId,owner_revision:revision,run_id:spaceId,slot_key:z.string().min(1).max(512),scheduled_at:instant}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   if(item.owner_device_id!==device.device_id)throw Error('schedule_owner_required')
   if(item.revision!==q.owner_revision||item.pending||!item.enabled)throw Error('stale_schedule_owner')
   const prior=item.claims[q.run_id]
   if(prior){if(prior.slot_key!==q.slot_key||prior.scheduled_at!==q.scheduled_at)throw Error('occurrence_conflict');return prior}
   if(Object.values(item.claims).some(v=>v.slot_key===q.slot_key))throw Error('occurrence_conflict')
   if(Object.values(item.claims).some(v=>v.status!=='terminal'))throw Error('schedule_unresolved')
   if(Date.parse(q.scheduled_at)<=Date.parse(item.frontier))throw Error('stale_schedule_frontier')
   const claim={run_id:q.run_id,slot_key:q.slot_key,scheduled_at:q.scheduled_at,status:'reserved' as const,task_id:null}
   item.claims[q.run_id]=claim;item.frontier=q.scheduled_at;this.save(device.account_id,item);return claim
  })
 }
 checkpoint(token:string,raw:unknown){
  const q=z.object({id:spaceId,owner_revision:revision,run_id:spaceId,task_id:z.string().min(1).max(512),terminal:z.boolean()}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   if(item.owner_device_id!==device.device_id)throw Error('schedule_owner_required')
   if(item.revision!==q.owner_revision||item.pending)throw Error('stale_schedule_owner')
   const claim=item.claims[q.run_id];if(!claim)throw Error('occurrence_missing')
   if(claim.task_id&&claim.task_id!==q.task_id)throw Error('occurrence_conflict')
   if(claim.status==='terminal'&&!q.terminal)throw Error('occurrence_terminal')
   claim.task_id=q.task_id;claim.status=q.terminal?'terminal':'running';this.save(device.account_id,item);return claim
  })
 }
 handoff(token:string,raw:unknown){
  const q=z.object({id:spaceId,owner_revision:revision,transition_id:spaceId,action:z.enum(['prepare','ack','commit','cancel']),target:spaceId.optional()}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   if(item.revision!==q.owner_revision)throw Error('stale_schedule_owner')
   if(q.action==='ack'){
    if(item.pending?.id!==q.transition_id||item.pending.target!==device.device_id)throw Error('schedule_recipient_required')
    item.pending.ack=true;return this.save(device.account_id,item)
   }
   if(item.owner_device_id!==device.device_id)throw Error('schedule_owner_required')
   if(q.action==='prepare'){
    if(Object.values(item.claims).some(v=>v.status!=='terminal'))throw Error('schedule_unresolved')
    if(!q.target||q.target===device.device_id)throw Error('invalid_schedule_target')
    if(!this.db.prepare("SELECT 1 FROM hub_devices WHERE account_id=? AND device_id=? AND kind='desktop' AND revoked=0").get(device.account_id,q.target))throw Error('invalid_schedule_target')
    if(item.pending&&(item.pending.id!==q.transition_id||item.pending.target!==q.target))throw Error('schedule_handoff_conflict')
    item.pending??={id:q.transition_id,target:q.target,ack:false}
   }else{
    if(item.pending?.id!==q.transition_id)throw Error('schedule_handoff_missing')
    if(q.action==='commit'){if(!item.pending.ack)throw Error('handoff_incomplete');if(!this.db.prepare('SELECT 1 FROM hub_devices WHERE account_id=? AND device_id=? AND revoked=0').get(device.account_id,item.pending.target))throw Error('invalid_schedule_target');item.owner_device_id=item.pending.target;item.revision++}
    item.pending=null
   }
   return this.save(device.account_id,item)
  })
 }
 control(token:string,raw:unknown){
  const q=z.object({id:spaceId,owner_revision:revision,enabled:z.boolean()}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   if(item.owner_device_id!==device.device_id)throw Error('schedule_owner_required')
   if(item.revision!==q.owner_revision||item.pending)throw Error('stale_schedule_owner')
   item.enabled=q.enabled
   // Do not invalidate an already dispatched run: pausing governs new claims.
   return this.save(device.account_id,item)
  })
 }
}
