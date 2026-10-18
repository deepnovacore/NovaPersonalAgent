import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {authorityRecordSchema} from '../device/space-authority.js'
import {sharedScheduleSchema} from '../device/schedule-ownership.js'
import type {ScheduleService,Schedule,ScheduleRun,SharedScheduleCoordinator} from '../personal-agent/scheduled-tasks.js'
const identitySchema=z.object({hub_id:z.string(),account_id:z.string(),device_id:z.string()})
type Request=(path:string,body?:unknown)=>Promise<unknown>
/** An adapter around the ordinary Task scheduler; receiving a replica never runs it. */
export class HubScheduleCoordinator implements SharedScheduleCoordinator {
 private identity:z.infer<typeof identitySchema>|null=null
 private disk:BoundedJsonStore<z.infer<typeof identitySchema>|null>
 private opened=false
 private syncing:Promise<void>|undefined
 constructor(private service:ScheduleService,private request:Request){this.disk=new BoundedJsonStore(service.path+'.hub-binding',identitySchema.nullable(),8192)}
 private async identify(){
  if(!this.opened){this.identity=await this.disk.read(null);this.opened=true}
  const value=identitySchema.parse(await this.request('identity'))
  if(this.identity&&JSON.stringify(this.identity)!==JSON.stringify(value))throw Error('schedule_hub_identity_changed')
  if(!this.identity){await this.disk.write(value);this.identity=value}
  return value
 }
 sync():Promise<void>{return this.syncing??=this.syncOnce().finally(()=>{this.syncing=undefined})}
 private async syncOnce(){
  const identity=await this.identify()
  for(const item of this.service.list().filter(item=>item.shared?.owner_revision===0)){
   const authority=authorityRecordSchema.parse(await this.request('authority'))
   const {title,goal,acceptance,rule,context}=item
   await this.request('schedule-owners/register',{id:item.id,authority_epoch:authority.authority_epoch,frontier:item.cursor,definition:{title,goal,acceptance,rule,context}})
  }
  const items=z.array(sharedScheduleSchema).max(64).parse(await this.request('schedule-owners'))
  for(const item of items)if(item.owner_device_id===identity.device_id){
   await this.service.acceptShared({id:item.id,definition:item.definition,frontier:item.frontier,owner_revision:item.revision,enabled:item.enabled&&!item.pending},identity.account_id)
   for(const claim of Object.values(item.claims))if(claim.status==='reserved')await this.service.recoverSharedReservation(item.id,claim)
  }
 }
 async claim(item:Schedule,run:ScheduleRun){
  await this.identify()
  if(!run.slot||!item.shared?.owner_revision)return false
  const result=z.object({status:z.enum(['reserved','running','terminal']),task_id:z.string().nullable()}).parse(await this.request('schedule-owners/claim',{id:item.id,owner_revision:item.shared.owner_revision,run_id:run.run_id,slot_key:run.slot.slot_key,scheduled_at:run.slot.scheduled_at}))
  // A lost local database must not turn an uncertain previously dispatched run into a retry.
  return result.status==='reserved'
 }
 async bind(item:Schedule,run:ScheduleRun,taskId:string){
  await this.identify()
  await this.request('schedule-owners/checkpoint',{id:item.id,owner_revision:item.shared!.owner_revision,run_id:run.run_id,task_id:taskId,terminal:false})
 }
 async finish(item:Schedule,run:ScheduleRun){
  await this.identify()
  if(!run.task_id)throw Error('scheduled_task_required')
  await this.request('schedule-owners/checkpoint',{id:item.id,owner_revision:item.shared!.owner_revision,run_id:run.run_id,task_id:run.task_id,terminal:true})
 }
}
