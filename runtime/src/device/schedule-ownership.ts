import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {scheduleInputSchema,scheduleHash} from '../personal-agent/scheduled-tasks.js'

const spaceId=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),instant=z.string().datetime()
const claimSchema=z.object({run_id:spaceId,slot_key:z.string().min(1).max(512),scheduled_at:instant,status:z.enum(['reserved','running','terminal']),task_id:z.string().nullable()}).strict()
export const scheduleClaimsSchema=z.object({id:spaceId,owner_device_id:spaceId,enabled:z.boolean().default(true),definition:scheduleInputSchema,frontier:instant,claims:z.record(z.string(),claimSchema)}).strict()
const ownerSchema=scheduleClaimsSchema
export type ScheduleClaims=z.infer<typeof ownerSchema>
/** Durable occurrence reservations belong to the fixed Host; presence never changes ownership. */
export class ScheduleOwnership {
 constructor(private db:DatabaseSync,private authenticate:(token:string)=>{account_id:string;device_id:string},private requireHost:(token:string)=>void){db.exec('CREATE TABLE IF NOT EXISTS schedule_claims(account_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(account_id,id))')}
 private tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
 private get(account:string,id:string):ScheduleClaims{const row=this.db.prepare('SELECT value FROM schedule_claims WHERE account_id=? AND id=?').get(account,id);if(!row)throw Error('shared_schedule_missing');return ownerSchema.parse(JSON.parse(String(row.value)))}
 private save(account:string,value:ScheduleClaims){if(Object.keys(value.claims).length>4096)throw Error('schedule_capacity');this.db.prepare('INSERT INTO schedule_claims VALUES(?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET value=excluded.value').run(account,value.id,JSON.stringify(ownerSchema.parse(value)));return value}
 list(token:string){const device=this.authenticate(token);return this.db.prepare('SELECT value FROM schedule_claims WHERE account_id=?').all(device.account_id).map(r=>ownerSchema.parse(JSON.parse(String(r.value))))}
 register(token:string,raw:unknown){
  const q=z.object({id:spaceId,definition:scheduleInputSchema,frontier:instant}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token);this.requireHost(token)
   const existing=this.list(token).find(v=>v.id===q.id)
   if(existing){if(existing.owner_device_id!==device.device_id||scheduleHash(existing.definition)!==scheduleHash(q.definition))throw Error('shared_schedule_conflict');return existing}
   if(this.list(token).length>=64)throw Error('schedule_capacity')
   return this.save(device.account_id,{id:q.id,owner_device_id:device.device_id,enabled:true,definition:q.definition,frontier:q.frontier,claims:{}})
  })
 }
 claim(token:string,raw:unknown){
  const q=z.object({id:spaceId,run_id:spaceId,slot_key:z.string().min(1).max(512),scheduled_at:instant}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   this.requireHost(token)
   if(!item.enabled)throw Error('schedule_disabled')
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
  const q=z.object({id:spaceId,run_id:spaceId,task_id:z.string().min(1).max(512),terminal:z.boolean()}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   this.requireHost(token)
   const claim=item.claims[q.run_id];if(!claim)throw Error('occurrence_missing')
   if(claim.task_id&&claim.task_id!==q.task_id)throw Error('occurrence_conflict')
   if(claim.status==='terminal'&&!q.terminal)throw Error('occurrence_terminal')
   claim.task_id=q.task_id;claim.status=q.terminal?'terminal':'running';this.save(device.account_id,item);return claim
  })
 }
 control(token:string,raw:unknown){
  const q=z.object({id:spaceId,enabled:z.boolean()}).strict().parse(raw)
  return this.tx(()=>{const device=this.authenticate(token),item=this.get(device.account_id,q.id)
   this.requireHost(token)
   item.enabled=q.enabled
   // Do not invalidate an already dispatched run: pausing governs new claims.
   return this.save(device.account_id,item)
  })
 }
}
