import {createHash, randomBytes, randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {applyLifeMutation, emptyLifeState, lifeInputSchema, lifeStateSchema} from '../personal-agent/life.js'
import type {LifeState} from '../personal-agent/life.js'
import {HubRouting} from './routing.js'

const id=z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/)
const commandSchema=z.object({op_id:id,input:lifeInputSchema}).strict()
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
function canonical(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
 return JSON.stringify(value)
}
export interface HubSnapshot {schema_version:1;hub_id:string;account_id:string;cursor:number;state:LifeState;tombstones:Record<string,number>}
interface Device {account_id:string;device_id:string;epoch:number}
export interface HubEvent {seq:number;device_id:string;op_id:string;result:{id:string;version:number};input:unknown}

/** All account state, durable receipts and log entries commit in one SQLite transaction.
 * No executor, scheduler, memory import, or connector is reachable from this store. */
export class HubStore {
 readonly #db:DatabaseSync
 readonly #identity:string
 readonly routing:HubRouting
 constructor(path:string){
  this.#db=new DatabaseSync(path,{allowExtension:false})
  this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS hub_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS hub_accounts(account_id TEXT PRIMARY KEY,state TEXT NOT NULL,cursor INTEGER NOT NULL,tombstones TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS hub_devices(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,device_id TEXT NOT NULL,epoch INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,device_id));
   CREATE TABLE IF NOT EXISTS hub_receipts(account_id TEXT NOT NULL,op_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(account_id,op_id));
   CREATE TABLE IF NOT EXISTS hub_log(account_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(account_id,seq));`)
  this.#db.prepare('INSERT OR IGNORE INTO hub_identity VALUES(1,?)').run(randomUUID())
  this.#identity=String(this.#db.prepare('SELECT id FROM hub_identity WHERE singleton=1').get()!.id)
  this.routing=new HubRouting(this.#db,token=>this.#device(token))
 }
 close(){this.#db.close()}
 enroll(accountId:string,label:string){
  id.parse(accountId);z.string().trim().min(1).max(100).parse(label)
  const token=randomBytes(32).toString('base64url'),device_id=randomUUID()
  this.#transaction(()=>{
   this.#db.prepare('INSERT OR IGNORE INTO hub_accounts VALUES(?,?,0,?)').run(accountId,JSON.stringify(emptyLifeState()),'{}')
   this.#db.prepare('INSERT INTO hub_devices(token_hash,account_id,device_id,epoch) VALUES(?,?,?,1)').run(digest(token),accountId,device_id)
  })
  return {account_id:accountId,device_id,device_name:label,device_epoch:1,token}
 }
 revoke(accountId:string,deviceId:string){this.#db.prepare('UPDATE hub_devices SET revoked=1 WHERE account_id=? AND device_id=?').run(accountId,deviceId)}
 #device(token:string):Device{
  const row=this.#db.prepare('SELECT account_id,device_id,epoch FROM hub_devices WHERE token_hash=? AND revoked=0').get(digest(token))
  if(!row)throw Error('unauthorized')
  return {account_id:String(row.account_id),device_id:String(row.device_id),epoch:Number(row.epoch)}
 }
 #snapshot(accountId:string):HubSnapshot{
  const row=this.#db.prepare('SELECT state,cursor,tombstones FROM hub_accounts WHERE account_id=?').get(accountId)
  if(!row)throw Error('unauthorized')
  const state=lifeStateSchema.parse(JSON.parse(String(row.state)))
  // Receipts are Hub-internal. Clients persist their own pending operation IDs.
  state.receipts={}
  return {schema_version:1,hub_id:this.#identity,account_id:accountId,cursor:Number(row.cursor),state,tombstones:JSON.parse(String(row.tombstones)) as Record<string,number>}
 }
 snapshot(token:string){return this.#snapshot(this.#device(token).account_id)}
 identity(token:string){return {hub_id:this.#identity,...this.#device(token)}}
 changes(token:string,after:number){
  const {account_id}=this.#device(token),snapshot=this.#snapshot(account_id)
  if(!Number.isSafeInteger(after)||after<0||after>snapshot.cursor)throw Error('cursor_invalid')
  const rows=this.#db.prepare('SELECT event FROM hub_log WHERE account_id=? AND seq>? ORDER BY seq LIMIT 256').all(account_id,after)
  const events=rows.map(row=>JSON.parse(String(row.event)) as HubEvent)
  return {schema_version:1 as const,account_id,events,cursor:events.at(-1)?.seq??after,has_more:(events.at(-1)?.seq??after)<snapshot.cursor}
 }
 mutate(token:string,raw:unknown){
  const command=commandSchema.parse(raw)
  return this.#transaction(()=>{
   const device=this.#device(token),accountId=device.account_id,payload=digest(canonical(command.input))
   const previous=this.#db.prepare('SELECT hash,result FROM hub_receipts WHERE account_id=? AND op_id=?').get(accountId,command.op_id)
   if(previous){
    if(previous.hash!==payload)throw Error('op_id_conflict')
    return {result:JSON.parse(String(previous.result)) as {id:string;version:number},snapshot:this.#snapshot(accountId)}
   }
   const snapshot=this.#snapshot(accountId)
   const next=(()=>{
    try{return applyLifeMutation(snapshot.state,command.input,command.op_id)}catch(error){
     if(error instanceof z.ZodError&&error.issues.some(issue=>issue.code==='too_big'&&issue.path.length===1&&['todos','ideas','goals'].includes(String(issue.path[0]))))throw Error('store_capacity')
     throw error
    }
   })()
   // An old create cannot restore a deleted ID, even if an external migration supplied it.
   if(command.input.op!=='undo_create'&&Object.hasOwn(snapshot.tombstones,next.result.id))throw Error('item_deleted')
   if(command.input.op==='undo_create')snapshot.tombstones[command.input.id]=command.input.expected_version
   const seq=snapshot.cursor+1
   const event:HubEvent={seq,device_id:device.device_id,op_id:command.op_id,result:next.result,input:command.input}
   this.#db.prepare('UPDATE hub_accounts SET state=?,cursor=?,tombstones=? WHERE account_id=?').run(JSON.stringify(next.state),seq,JSON.stringify(snapshot.tombstones),accountId)
   this.#db.prepare('INSERT INTO hub_receipts VALUES(?,?,?,?)').run(accountId,command.op_id,payload,JSON.stringify(next.result))
   this.#db.prepare('INSERT INTO hub_log VALUES(?,?,?)').run(accountId,seq,JSON.stringify(event))
   return {result:next.result,snapshot:this.#snapshot(accountId)}
  })
 }
 #transaction<T>(run:()=>T):T{
  this.#db.exec('BEGIN IMMEDIATE')
  try{const value=run();this.#db.exec('COMMIT');return value}catch(error){this.#db.exec('ROLLBACK');throw error}
 }
}
