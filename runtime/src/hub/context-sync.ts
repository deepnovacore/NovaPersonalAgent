import {createHash} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {spaceId} from '../device/space-authority.js'
import type {HubSpaceAuthority} from './space-authority.js'

const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const sourceFact=z.object({kind:z.literal('source_fact'),source_id:spaceId,grant_revision:revision,evidence_id:spaceId,resource_id:z.string().min(1).max(200),source_version:z.string().min(1).max(100),text:z.string().max(16000),relation:z.enum(['self','participant','unknown']).optional(),occurred_at:z.string().datetime()}).strict()
const payloadSchema=z.discriminatedUnion('kind',[
 sourceFact,
 z.object({kind:z.literal('grant'),source_id:spaceId,revision:revision,provider:z.string().min(1).max(2048),purpose:z.literal('profile'),allow_upload:z.boolean(),allow_processing:z.boolean()}).strict(),
 z.object({kind:z.literal('delete_source'),source_id:spaceId,revision:revision}).strict(),
 z.object({kind:z.literal('correction'),key:spaceId,value:z.string().max(4000),provider:z.string().min(1).max(2048).optional(),updated_at:z.string().datetime().optional()}).strict(),
])
export const contextEventSchema=z.object({protocol_version:z.literal(1),space_id:spaceId,producer_device_id:spaceId,producer_seq:revision.refine(n=>n>0),event_id:spaceId,payload:payloadSchema}).strict()
type Event=z.infer<typeof contextEventSchema>
type Fact=z.infer<typeof sourceFact>
const entrySchema=z.object({key:spaceId,text:z.string().max(4000),evidence_ids:z.array(spaceId).min(1).max(100)}).strict()
const projectionSchema=z.object({authority_epoch:revision,expected_revision:revision,input_cursor:revision,provider:z.string().min(1).max(2048),entries:z.array(entrySchema).max(200)}).strict()
type Projection={revision:number;authority_epoch:number;publisher_device_id:string;input_cursor:number;entries:{key:string;text:string;evidence_ids:string[];explicit?:boolean}[]}
interface ContextState {
 cursor:number;revision:number;facts:Record<string,Fact>;grants:Record<string,{owner:string;value:Extract<Event['payload'],{kind:'grant'}>}>;
 corrections:Record<string,{value:string;event_id:string;provider?:string;updated_at?:string}>;tombstones:Record<string,number>;derived:Projection|null;
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
 if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
 return JSON.stringify(value)
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')

/** Typed data plane only. Receiving facts or projections never runs an Agent. */
export class HubContextSync {
 private inTransaction=false
 constructor(private db:DatabaseSync,private authenticate:(token:string)=>{account_id:string;device_id:string},private authority:HubSpaceAuthority){
  db.exec(`CREATE TABLE IF NOT EXISTS hub_context(account_id TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS hub_context_receipts(account_id TEXT NOT NULL,event_id TEXT NOT NULL,producer TEXT NOT NULL,producer_seq INTEGER NOT NULL,hash TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(account_id,event_id),UNIQUE(account_id,producer,producer_seq));
   CREATE TABLE IF NOT EXISTS hub_context_log(account_id TEXT NOT NULL,cursor INTEGER NOT NULL,source_id TEXT,value TEXT NOT NULL,PRIMARY KEY(account_id,cursor));
   CREATE TABLE IF NOT EXISTS hub_context_acks(account_id TEXT NOT NULL,device_id TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(account_id,device_id));
   CREATE TABLE IF NOT EXISTS hub_context_controls(account_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(account_id,request_id));`)
 }
 private read(account:string):ContextState {
  const row=this.db.prepare('SELECT value FROM hub_context WHERE account_id=?').get(account)
  const state:ContextState=row?JSON.parse(String(row.value)) as ContextState:{cursor:0,revision:0,facts:{},grants:{},corrections:{},tombstones:{},derived:null}
  const expired=Object.values(state.facts).filter(f=>Date.parse(f.occurred_at)<=Date.now()-30*86400000)
  if(expired.length){
   const prune=()=>{
    for(const fact of expired){delete state.facts[fact.evidence_id];this.db.prepare("UPDATE hub_context_log SET value='null' WHERE account_id=? AND json_extract(value,'$.payload.evidence_id')=?").run(account,fact.evidence_id)}
    state.derived=null
    this.db.prepare('INSERT INTO hub_context_log VALUES(?,?,?,?)').run(account,++state.cursor,null,'null')
    this.save(account,state)
   }
   if(this.inTransaction)prune();else this.transaction(prune)
  }
  return state
 }
 private save(account:string,state:ContextState){this.db.prepare('INSERT INTO hub_context VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET value=excluded.value').run(account,JSON.stringify(state))}
 private transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try{const value=action();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}finally{this.inTransaction=false}}
 snapshot(token:string){const state=this.read(this.authenticate(token).account_id);return {...state,facts:Object.values(state.facts)}}
 append(token:string,raw:unknown){
  const events=z.array(contextEventSchema).min(1).max(100).parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),account=device.account_id,state=this.read(account),receipts:{event_id:string;cursor:number}[]=[]
   for(const event of events){
    if(event.space_id!==account)throw Error('space_mismatch')
    if(event.producer_device_id!==device.device_id)throw Error('producer_mismatch')
    const prior=this.db.prepare('SELECT hash,cursor FROM hub_context_receipts WHERE account_id=? AND event_id=?').get(account,event.event_id),digest=hash(event)
    if(prior){if(prior.hash!==digest)throw Error('event_id_conflict');receipts.push({event_id:event.event_id,cursor:Number(prior.cursor)});continue}
    const seq=Number(this.db.prepare('SELECT COALESCE(MAX(producer_seq),0) AS seq FROM hub_context_receipts WHERE account_id=? AND producer=?').get(account,device.device_id)!.seq)
    if(event.producer_seq!==seq+1)throw Error('producer_sequence_gap')
    const payload=event.payload
    if('source_id' in payload&&Object.hasOwn(state.tombstones,payload.source_id)&&payload.kind!=='delete_source')throw Error('source_deleted')
    if(payload.kind==='grant'){
     const previous=state.grants[payload.source_id]
     if(previous&&previous.owner!==device.device_id)throw Error('source_owner_required')
     if(previous&&payload.revision<=previous.value.revision)throw Error('stale_consent')
     if(payload.revision===0)throw Error('stale_consent')
     state.grants[payload.source_id]={owner:device.device_id,value:payload}
     state.derived=null
     // Revocation removes already-uploaded originals and log content too.
     if(!payload.allow_upload)this.eraseSource(account,state,payload.source_id)
    }else if(payload.kind==='source_fact'){
     const grant=state.grants[payload.source_id]?.value
     if(!grant?.allow_upload||grant.revision!==payload.grant_revision)throw Error('upload_consent_required')
     const old=state.facts[payload.evidence_id]
     if(old&&hash({...old,grant_revision:payload.grant_revision})!==hash(payload))throw Error('evidence_conflict')
     const duplicate=Object.values(state.facts).find(f=>f.source_id===payload.source_id&&f.resource_id===payload.resource_id&&f.source_version===payload.source_version)
     if(duplicate&&hash({...duplicate,evidence_id:payload.evidence_id,grant_revision:payload.grant_revision})!==hash(payload))throw Error('evidence_conflict')
     if(Date.parse(payload.occurred_at)>Date.now()+300000)throw Error('source_time_invalid')
     if(Date.parse(payload.occurred_at)>Date.now()-30*86400000&&(!duplicate||old))state.facts[payload.evidence_id]=payload
    }else if(payload.kind==='delete_source'){
     const minimum=Math.max(state.tombstones[payload.source_id]??0,state.grants[payload.source_id]?.value.revision??0)
     if(payload.revision<=minimum)throw Error('stale_consent')
     state.tombstones[payload.source_id]=payload.revision;delete state.grants[payload.source_id]
     this.eraseSource(account,state,payload.source_id);state.derived=null
    }else{state.corrections[payload.key]={value:payload.value,event_id:event.event_id,updated_at:payload.updated_at??new Date().toISOString(),...(payload.provider?{provider:payload.provider}:{})};state.derived=null}
    const cursor=++state.cursor
    this.db.prepare('INSERT INTO hub_context_receipts VALUES(?,?,?,?,?,?)').run(account,event.event_id,device.device_id,event.producer_seq,digest,cursor)
    const expired=payload.kind==='source_fact'&&Date.parse(payload.occurred_at)<=Date.now()-30*86400000
    this.db.prepare('INSERT INTO hub_context_log VALUES(?,?,?,?)').run(account,cursor,'source_id' in payload?payload.source_id:null,expired?'null':JSON.stringify(event))
    receipts.push({event_id:event.event_id,cursor})
   }
   if(Object.keys(state.facts).length>10000||Buffer.byteLength(JSON.stringify(state))>16*1024*1024)throw Error('context_capacity')
   this.save(account,state);return {cursor:state.cursor,receipts}
  })
 }
 private eraseSource(account:string,state:ContextState,source:string){
  for(const [id,fact]of Object.entries(state.facts))if(fact.source_id===source)delete state.facts[id]
  this.db.prepare("UPDATE hub_context_log SET value='null' WHERE account_id=? AND source_id=?").run(account,source)
 }
 deleteSource(token:string,raw:unknown){
  const input=z.object({source_id:spaceId,request_id:spaceId}).strict().parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),account=device.account_id,digest=hash({device:device.device_id,...input})
   const prior=this.db.prepare('SELECT hash,result FROM hub_context_controls WHERE account_id=? AND request_id=?').get(account,input.request_id)
   if(prior){if(prior.hash!==digest)throw Error('event_id_conflict');return JSON.parse(String(prior.result)) as {source_id:string;deleted:true;revision:number}}
   const state=this.read(account),revision=Math.max(state.grants[input.source_id]?.value.revision??0,state.tombstones[input.source_id]??0)+1
   state.tombstones[input.source_id]=revision;delete state.grants[input.source_id];state.derived=null
   this.eraseSource(account,state,input.source_id)
   this.db.prepare('INSERT INTO hub_context_log VALUES(?,?,?,?)').run(account,++state.cursor,input.source_id,'null')
   this.save(account,state)
   const result={source_id:input.source_id,deleted:true as const,revision}
   this.db.prepare('INSERT INTO hub_context_controls VALUES(?,?,?,?)').run(account,input.request_id,digest,JSON.stringify(result));return result
  })
 }
 discard(token:string,raw:unknown){
  const input=z.object({event_id:spaceId,producer_seq:revision.refine(n=>n>0),payload_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),account=device.account_id
   const prior=this.db.prepare('SELECT producer,producer_seq,hash,cursor FROM hub_context_receipts WHERE account_id=? AND event_id=?').get(account,input.event_id)
   if(prior){if(prior.producer!==device.device_id||Number(prior.producer_seq)!==input.producer_seq||prior.hash!==input.payload_hash)throw Error('event_id_conflict');return {receipts:[{event_id:input.event_id,cursor:Number(prior.cursor)}]}}
   const seq=Number(this.db.prepare('SELECT COALESCE(MAX(producer_seq),0) AS seq FROM hub_context_receipts WHERE account_id=? AND producer=?').get(account,device.device_id)!.seq)
   if(input.producer_seq!==seq+1)throw Error('producer_sequence_gap')
   const state=this.read(account),cursor=++state.cursor
   this.db.prepare('INSERT INTO hub_context_receipts VALUES(?,?,?,?,?,?)').run(account,input.event_id,device.device_id,input.producer_seq,input.payload_hash,cursor)
   this.db.prepare('INSERT INTO hub_context_log VALUES(?,?,?,?)').run(account,cursor,null,'null')
   this.save(account,state);return {receipts:[{event_id:input.event_id,cursor}]}
  })
 }
 pull(token:string,after:number){
  const account=this.authenticate(token).account_id,state=this.read(account)
  if(!Number.isSafeInteger(after)||after<0||after>state.cursor)throw Error('cursor_invalid')
  const changes=this.db.prepare('SELECT cursor,value FROM hub_context_log WHERE account_id=? AND cursor>? ORDER BY cursor LIMIT 100').all(account,after).map(row=>({cursor:Number(row.cursor),event:JSON.parse(String(row.value)) as Event|null}))
  return {changes,cursor:changes.at(-1)?.cursor??after,has_more:(changes.at(-1)?.cursor??after)<state.cursor,tombstones:state.tombstones}
 }
 acknowledge(token:string,cursor:number){
  const device=this.authenticate(token),state=this.read(device.account_id);revision.parse(cursor)
  if(cursor>state.cursor)throw Error('cursor_invalid')
  this.db.prepare('INSERT INTO hub_context_acks VALUES(?,?,?) ON CONFLICT(account_id,device_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)').run(device.account_id,device.device_id,cursor)
  return {cursor}
 }
 deletionStatus(token:string){
  const device=this.authenticate(token),state=this.read(device.account_id)
  return {tombstones:state.tombstones,pending_devices:this.db.prepare('SELECT d.device_id FROM hub_devices d LEFT JOIN hub_context_acks a ON d.account_id=a.account_id AND d.device_id=a.device_id WHERE d.account_id=? AND d.revoked=0 AND COALESCE(a.cursor,0)<?').all(device.account_id,state.cursor).map(r=>String(r.device_id))}
 }
 publish(token:string,raw:unknown):Projection {
  const input=projectionSchema.parse(raw)
  return this.transaction(()=>{
   const device=this.authenticate(token),authority=this.authority.validatePublisher(token,input.authority_epoch),state=this.read(device.account_id)
   if(state.revision!==input.expected_revision)throw Error('derived_revision_conflict')
   if(state.cursor!==input.input_cursor)throw Error('stale_inputs')
   if(new Set(input.entries.map(e=>e.key)).size!==input.entries.length)throw Error('duplicate_projection_key')
   for(const entry of input.entries)for(const id of entry.evidence_ids){
    const fact=state.facts[id],grant=fact&&state.grants[fact.source_id]?.value
    if(!fact||!grant?.allow_processing||!grant.allow_upload||grant.provider!==input.provider||grant.revision!==fact.grant_revision)throw Error('processing_consent_required')
   }
   const entries:Projection['entries']=input.entries.filter(e=>!Object.hasOwn(state.corrections,e.key))
   for(const [key,correction]of Object.entries(state.corrections))entries.push({key,text:correction.value,evidence_ids:[correction.event_id],explicit:true})
   const projection={revision:++state.revision,authority_epoch:authority.authority_epoch,publisher_device_id:device.device_id,input_cursor:state.cursor,entries}
   state.derived=projection;this.save(device.account_id,state);return projection
  })
 }
}
