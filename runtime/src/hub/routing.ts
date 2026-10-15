import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {canonicalJson} from '../text/canonical-json.js'

const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/)
const capability=z.enum(['android_native','ios_native','desktop_computer','desktop_browser','desktop_coding'])
const announcement=z.object({name:z.string().trim().min(1).max(100),capabilities:z.array(capability).min(1).max(5),targets:z.array(z.object({id:z.string().min(1).max(300),label:z.string().min(1).max(200),capability}).strict()).max(256).optional()}).strict()
const commandSchema=z.discriminatedUnion('kind',[
 z.object({command_id:id,task_id:id,target_device_id:id,kind:z.literal('start'),expires_at:z.number().int(),goal:z.string().trim().min(1).max(4000),acceptance:z.string().trim().min(1).max(2000),capability,target:z.string().min(1).max(300)}).strict(),
 z.object({command_id:id,task_id:id,target_device_id:id,kind:z.literal('cancel'),expires_at:z.number().int()}).strict(),
])
const ackSchema=z.object({command_id:id,decision:z.enum(['accepted','rejected'])}).strict()
const eventSchema=z.object({task_id:id,seq:z.number().int().positive(),phase:z.enum(['running','waiting_approval','verifying','completed','cancelled','interrupted']),summary:z.string().max(2000)}).strict()
type Command=z.infer<typeof commandSchema>
interface Device {account_id:string;device_id:string;epoch:number}
interface Routed {command:Command;sender_device_id:string}
interface Projection {task_id:string;owner_device_id:string;sender_device_id:string;goal:string;acceptance:string;phase:string;seq:number;summary:string}

/** Delivery and projections only. Never imports or invokes an executor or Life. */
export class HubRouting {
 constructor(private readonly db:DatabaseSync,private readonly authenticate:(token:string)=>Device){
  db.exec(`
   CREATE TABLE IF NOT EXISTS hub_presence(account_id TEXT NOT NULL,device_id TEXT NOT NULL,value TEXT NOT NULL,seen INTEGER NOT NULL,PRIMARY KEY(account_id,device_id));
   CREATE TABLE IF NOT EXISTS hub_commands(account_id TEXT NOT NULL,command_id TEXT NOT NULL,sender TEXT NOT NULL,target TEXT NOT NULL,deadline INTEGER NOT NULL,payload TEXT NOT NULL,decision TEXT,PRIMARY KEY(account_id,command_id));
   CREATE TABLE IF NOT EXISTS hub_tasks(account_id TEXT NOT NULL,task_id TEXT NOT NULL,owner TEXT NOT NULL,sender TEXT NOT NULL,start_command TEXT NOT NULL,projection TEXT NOT NULL,PRIMARY KEY(account_id,task_id));
   CREATE TABLE IF NOT EXISTS hub_task_events(account_id TEXT NOT NULL,task_id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,task_id,seq));`)
 }
 private transaction<T>(run:()=>T):T{
  this.db.exec('BEGIN IMMEDIATE')
  try{const result=run();this.db.exec('COMMIT');return result}catch(error){this.db.exec('ROLLBACK');throw error}
 }
 private live(account:string,device:string){return this.db.prepare('SELECT 1 FROM hub_devices WHERE account_id=? AND device_id=? AND revoked=0').get(account,device)!==undefined}
 heartbeat(token:string,raw:unknown){
  const value=announcement.parse(raw),device=this.authenticate(token),seen=Date.now()
  this.db.prepare('INSERT INTO hub_presence VALUES(?,?,?,?) ON CONFLICT(account_id,device_id) DO UPDATE SET value=excluded.value,seen=excluded.seen').run(device.account_id,device.device_id,JSON.stringify(value),seen)
  return {device_id:device.device_id,device_epoch:device.epoch,seen}
 }
 devices(token:string){
  const device=this.authenticate(token)
  return this.db.prepare('SELECT p.device_id,p.value,p.seen FROM hub_presence p JOIN hub_devices d ON p.account_id=d.account_id AND p.device_id=d.device_id WHERE p.account_id=? AND d.revoked=0 ORDER BY p.device_id').all(device.account_id).map(row=>({device_id:String(row.device_id),...announcement.parse(JSON.parse(String(row.value))),online:Number(row.seen)>Date.now()-90000,last_seen:Number(row.seen)}))
 }
 submit(token:string,raw:unknown){
  const command=commandSchema.parse(raw)
  return this.transaction(()=>{
   const sender=this.authenticate(token),account=sender.account_id,payload=canonicalJson(command)
   const prior=this.db.prepare('SELECT sender,payload FROM hub_commands WHERE account_id=? AND command_id=?').get(account,command.command_id)
   if(prior){if(prior.sender!==sender.device_id||prior.payload!==payload)throw Error('command_id_conflict');return {command_id:command.command_id,task_id:command.task_id}}
   const now=Date.now()
   if(command.expires_at<=now||command.expires_at>now+15*60000)throw Error('deadline_invalid')
   if(!this.live(account,command.target_device_id))throw Error('target_unavailable')
   if(command.kind==='start'){
    const present=this.db.prepare('SELECT value,seen FROM hub_presence WHERE account_id=? AND device_id=?').get(account,command.target_device_id)
    if(!present||Number(present.seen)<=now-90000||!announcement.parse(JSON.parse(String(present.value))).capabilities.includes(command.capability))throw Error('target_unavailable')
    if(command.capability==='ios_native'&&!['nova','calendar','reminders'].includes(command.target))throw Error('invalid_target')
    if(command.capability==='android_native'&&!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(command.target))throw Error('invalid_target')
    const projection:Projection={task_id:command.task_id,owner_device_id:command.target_device_id,sender_device_id:sender.device_id,goal:command.goal,acceptance:command.acceptance,phase:'offered',seq:0,summary:'等待执行设备接收'}
    if(this.db.prepare('SELECT 1 FROM hub_tasks WHERE account_id=? AND task_id=?').get(account,command.task_id))throw Error('task_id_conflict')
    this.db.prepare('INSERT INTO hub_tasks VALUES(?,?,?,?,?,?)').run(account,command.task_id,command.target_device_id,sender.device_id,command.command_id,JSON.stringify(projection))
   }else{
    const task=this.db.prepare('SELECT owner,sender FROM hub_tasks WHERE account_id=? AND task_id=?').get(account,command.task_id)
    if(!task||task.owner!==command.target_device_id||![task.owner,task.sender].includes(sender.device_id))throw Error('task_control_denied')
   }
   this.db.prepare('INSERT INTO hub_commands VALUES(?,?,?,?,?,?,NULL)').run(account,command.command_id,sender.device_id,command.target_device_id,command.expires_at,payload)
   return {command_id:command.command_id,task_id:command.task_id}
  })
 }
 inbox(token:string):Routed[]{
  const device=this.authenticate(token)
  return this.db.prepare('SELECT c.payload,c.sender FROM hub_commands c JOIN hub_devices d ON c.account_id=d.account_id AND c.sender=d.device_id WHERE c.account_id=? AND c.target=? AND c.decision IS NULL AND c.deadline>? AND d.revoked=0 ORDER BY c.rowid LIMIT 100').all(device.account_id,device.device_id,Date.now()).map(row=>({command:commandSchema.parse(JSON.parse(String(row.payload))),sender_device_id:String(row.sender)}))
 }
 ack(token:string,raw:unknown){
  const ack=ackSchema.parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),row=this.db.prepare('SELECT target,sender,payload,deadline,decision FROM hub_commands WHERE account_id=? AND command_id=?').get(device.account_id,ack.command_id)
   if(!row||row.target!==device.device_id)throw Error('recipient_required')
   if(row.decision!==null){if(row.decision!==ack.decision)throw Error('command_already_decided');return {command_id:ack.command_id,decision:ack.decision}}
   if(!this.live(device.account_id,String(row.sender)))throw Error('sender_revoked')
   if(Number(row.deadline)<=Date.now())throw Error('command_expired')
   this.db.prepare('UPDATE hub_commands SET decision=? WHERE account_id=? AND command_id=?').run(ack.decision,device.account_id,ack.command_id)
   // Acceptance is a delivery receipt, never an execution fact.
   return {command_id:ack.command_id,decision:ack.decision}
  })
 }
 publish(token:string,raw:unknown){
  const event=eventSchema.parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),account=device.account_id
   const row=this.db.prepare('SELECT owner,start_command,projection FROM hub_tasks WHERE account_id=? AND task_id=?').get(account,event.task_id)
   if(!row||row.owner!==device.device_id)throw Error('owner_required')
   const ack=this.db.prepare('SELECT decision FROM hub_commands WHERE account_id=? AND command_id=?').get(account,String(row.start_command))
   if(ack?.decision!=='accepted')throw Error('task_not_accepted')
   const encoded=canonicalJson(event),prior=this.db.prepare('SELECT payload FROM hub_task_events WHERE account_id=? AND task_id=? AND seq=?').get(account,event.task_id,event.seq)
   if(prior){if(prior.payload!==encoded)throw Error('event_id_conflict');return event}
   const previous=JSON.parse(String(row.projection)) as Projection
   if(event.seq!==previous.seq+1)throw Error('sequence_gap')
   if(['completed','cancelled','interrupted'].includes(previous.phase))throw Error('terminal_task')
   if(event.phase==='completed'&&previous.phase!=='verifying')throw Error('verification_required')
   this.db.prepare('INSERT INTO hub_task_events VALUES(?,?,?,?)').run(account,event.task_id,event.seq,encoded)
   this.db.prepare('UPDATE hub_tasks SET projection=? WHERE account_id=? AND task_id=?').run(JSON.stringify({...previous,...event}),account,event.task_id)
   return event
  })
 }
 tasks(token:string):(Projection&{delivery:string})[]{
  const device=this.authenticate(token)
  return this.db.prepare('SELECT t.projection,c.decision,c.deadline,c.sender FROM hub_tasks t JOIN hub_commands c ON t.account_id=c.account_id AND t.start_command=c.command_id WHERE t.account_id=? ORDER BY t.rowid DESC LIMIT 100').all(device.account_id).map(row=>({...JSON.parse(String(row.projection)) as Projection,
   delivery:row.decision!==null?String(row.decision):!this.live(device.account_id,String(row.sender))?'sender_revoked':Number(row.deadline)<=Date.now()?'expired':'pending'}))
 }
}
