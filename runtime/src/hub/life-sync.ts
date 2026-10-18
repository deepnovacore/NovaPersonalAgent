import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {type LifeService,type LifeState,lifeInputSchema} from '../personal-agent/life.js'
import {hubImportSchema,lifeProjection,lifeSyncProjectionSchema,syncEntitySchema} from './life-projection.js'
import {HubResponseError,LifeSyncTransport,loadHubCredentials,type hubSnapshotSchema} from './life-sync-transport.js'

type Snapshot=z.infer<typeof hubSnapshotSchema>
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const entities=z.record(z.string(),syncEntitySchema),versions=z.record(z.string(),z.number().int().nonnegative())
const commandSchema=z.object({op_id:z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),input:z.union([lifeInputSchema,hubImportSchema]),local:syncEntitySchema})
const planSchema=z.object({requestId:z.string(),expectedStateHash:z.string(),projection:lifeSyncProjectionSchema,baseline:entities,versions,cursor:z.number().int().nonnegative()})
const stateSchema=z.object({
 schema_version:z.literal(1),hub_id:z.string().nullable(),account_id:z.string().nullable(),cursor:z.number().int().nonnegative(),
 highest_cursor:z.number().int().nonnegative(),seeded:z.boolean(),hub_versions:versions,baseline:entities,
 pending:z.array(commandSchema),conflicts:z.array(z.object({id:z.string(),error:z.string(),local:syncEntitySchema.nullable(),remote:syncEntitySchema.nullable()})),
 lost_fields:z.array(z.object({id:z.string(),fields:z.array(z.string())})),unpropagated_local_deletions:z.array(z.string()),
 applying:planSchema.nullable(),last_error:z.string().nullable(),
}).strict()
type State=z.infer<typeof stateSchema>
const empty=():State=>({schema_version:1,hub_id:null,account_id:null,cursor:0,highest_cursor:0,seeded:false,hub_versions:{},baseline:{},pending:[],conflicts:[],lost_fields:[],unpropagated_local_deletions:[],applying:null,last_error:null})
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const own=<T>(record:Record<string,T>,id:string):T|undefined=>Object.hasOwn(record,id)?record[id]:undefined
function hubVersions(snapshot:Snapshot){
 const result:Record<string,number>={profile:snapshot.state.profile.version}
 for(const row of [...snapshot.state.goals,...snapshot.state.ideas,...snapshot.state.todos])result[row.id]=row.version
 return result
}
/** Explicitly opt-in and single-owner, like LifeService. Credentials live in a separate private file.
 * Call sync on local changes/reconnect; no background/network activity merely from constructing it. */
export class LifeSyncClient{
 readonly #store:BoundedJsonStore<State>
 #state=empty()
 #transport:LifeSyncTransport|null=null
 #tail:Promise<unknown>=Promise.resolve()
 constructor(readonly life:LifeService,readonly path:string,readonly credentialsPath:string){
  if(path===credentialsPath||path===life.path||credentialsPath===life.path)throw Error('sync_paths_must_differ')
  this.#store=new BoundedJsonStore(path,stateSchema,16*1024*1024)
 }
 async open(){
  this.#state=await this.#store.read(empty())
  const credentials=await loadHubCredentials(this.credentialsPath)
  this.#transport=credentials?new LifeSyncTransport(credentials):null
 }
 status(){return {...structuredClone(this.#state),enabled:this.#transport!==null}}
 async close(){await this.#tail}
 sync():Promise<void>{
  const run=this.#tail.then(async()=>{
   if(!this.#transport)return
   try{await this.#sync(this.#transport);this.#state.last_error=null;await this.#save()}
   catch(error){
    const code=error instanceof Error?error.message:'sync_failed'
    const allowed=['account_mismatch','hub_identity_changed','hub_history_reset','unsupported_backend','local_state_changed','version_conflict','hub_transport_failed','hub_response_invalid','unauthorized','hub_request_failed','invalid_changes','store_capacity','goal_not_found','idea_not_found']
    this.#state.last_error=allowed.includes(code)?code:'sync_failed'
    await this.#save();throw Error(this.#state.last_error)
   }
  })
  this.#tail=run.catch(()=>{/* next explicit sync may retry the durable outbox */})
  return run
 }
 #save(){return this.#store.write(this.#state)}
 #accept(snapshot:Snapshot){
  if(this.#state.account_id!==null&&this.#state.account_id!==snapshot.account_id)throw Error('account_mismatch')
  if(this.#state.hub_id!==null&&this.#state.hub_id!==snapshot.hub_id)throw Error('hub_identity_changed')
  if(snapshot.cursor<this.#state.highest_cursor)throw Error('hub_history_reset')
  this.#state.hub_id=snapshot.hub_id;this.#state.account_id=snapshot.account_id
  this.#state.highest_cursor=snapshot.cursor
 }
 async #apply(){
  const plan=this.#state.applying
  if(!plan)return
  try{await this.life.applySyncProjection(plan.projection,{requestId:plan.requestId,expectedStateHash:plan.expectedStateHash})}
  catch(error){
   if(error instanceof Error&&error.message==='local_state_changed'){this.#state.applying=null;await this.#save()}
   throw error
  }
  this.#state.baseline=plan.baseline;this.#state.hub_versions=plan.versions;this.#state.cursor=plan.cursor
  this.#state.applying=null
  await this.#save()
 }
 #enqueue(local:LifeState){
  const projected=lifeProjection(local)
  for(const row of [...local.goals,...local.todos]){
   if(row.idea_id&&!this.#state.lost_fields.some(item=>item.id===row.id))this.#state.lost_fields.push({id:row.id,fields:['idea_id']})
  }
  const ordered=[...local.goals,...local.ideas,...local.todos].map(row=>own(projected,row.id)!)
  ordered.push(own(projected,'profile')!)
  for(const entity of ordered){
   if(this.#state.pending.some(command=>command.local.id===entity.id))continue
   const before=own(this.#state.baseline,entity.id)
   if(!before&&this.#state.conflicts.some(conflict=>conflict.id===entity.id&&same(conflict.local,entity)))continue
   if(same(before,entity))continue
   if(entity.kind==='profile'){
    if(!before&&entity.about==='')continue
    this.#state.pending.push({op_id:'profile-'+randomUUID(),input:{op:'profile',about:entity.about,expected_version:own(this.#state.hub_versions,'profile')??0},local:entity})
    continue
   }
   if(before){
    const {id,kind,...patch}=entity
    this.#state.pending.push({op_id:'update-'+randomUUID(),input:{op:'update',kind,id,expected_version:own(this.#state.hub_versions,id)??0,...patch},local:entity})
    continue
   }
   const row=[...local.goals,...local.ideas,...local.todos].find(item=>item.id===entity.id)!
   const requestId=Object.keys(local.receipts).find(key=>hash(key)===entity.id&&/^[a-zA-Z0-9_-]{1,200}$/.test(key))
   if(this.#state.seeded&&requestId){
    const {kind,title,note,importance}=entity
    const ideaId='idea_id'in row?row.idea_id:null
    const ideaVersion=ideaId?own(this.#state.hub_versions,ideaId):undefined
    const input=ideaId&&ideaVersion!==undefined&&kind!=='idea'?
     {op:'convert' as const,id:ideaId,target:kind,expected_version:ideaVersion}:
     {op:'create' as const,kind,title,note,importance,...('goal_id'in entity?{goal_id:entity.goal_id}:{}),...('due'in entity?{due:entity.due}:{}),...('success_criteria'in entity?{success_criteria:entity.success_criteria}:{})}
    this.#state.pending.push({op_id:requestId,input,local:entity})
    // A user may have edited an offline new entity before the next sync.
    const {id:entityId,kind:entityKind,...patch}=entity
    this.#state.pending.push({op_id:'after-create-'+hash(requestId),input:{op:'update',id:entityId,kind:entityKind,expected_version:1,...patch},local:entity})
   }else{
    this.#state.pending.push({op_id:'import-'+hash(entity.id),input:{op:'import',entity,...(Number.isFinite(Date.parse(row.created_at))?{created_at:new Date(row.created_at).toISOString()}:{}),...(Number.isFinite(Date.parse(row.updated_at))?{updated_at:new Date(row.updated_at).toISOString()}:{})},local:entity})
   }
  }
  for(const id of new Set([...Object.keys(this.#state.baseline),...this.#state.pending.map(command=>command.local.id)])){
   if(id!=='profile'&&!Object.hasOwn(projected,id)&&!this.#state.unpropagated_local_deletions.includes(id))this.#state.unpropagated_local_deletions.push(id)
  }
  this.#state.seeded=true
 }
 async #sync(transport:LifeSyncTransport){
  await this.life.refresh()
  this.life.assertSyncSupported()
  let snapshot=await transport.snapshot()
  this.#accept(snapshot)
  await this.#save()
  await this.#apply()
  const local=this.life.syncState()
  this.#enqueue(local)
  await this.#save() // Fixed operation IDs and payloads must survive an uncertain response.
  const uploaded=new Map<string,unknown>()
  while(this.#state.pending.length){
   const command=this.#state.pending[0]!
   uploaded.set(command.local.id,command.local)
   try{
    const response=await transport.mutate({op_id:command.op_id,input:command.input})
    this.#accept(response.snapshot);snapshot=response.snapshot
    if(response.result.id!==command.local.id){
     this.#state.conflicts.push({id:command.local.id,error:'conversion_alias',local:command.local,remote:own(lifeProjection(snapshot.state),response.result.id)??null})
     this.#state.pending=this.#state.pending.filter(item=>item.local.id!==command.local.id)
    }else{
     this.#state.hub_versions[response.result.id]=response.result.version
     this.#state.pending.shift()
     if(command.input.op==='update'&&command.input.kind==='idea'){
      // FIFO guarantees these dependent conversions have not been attempted yet.
      for(const pending of this.#state.pending){
       if(pending.input.op==='convert'&&pending.input.id===command.input.id&&pending.input.expected_version===command.input.expected_version)pending.input.expected_version=response.result.version
      }
     }
    }
   }catch(error){
    if(!(error instanceof HubResponseError)||!error.snapshot)throw error
    this.#accept(error.snapshot);snapshot=error.snapshot
    this.#state.conflicts.push({id:command.local.id,error:error.code,local:command.local,remote:own(lifeProjection(snapshot.state),command.local.id)??null})
    this.#state.pending=this.#state.pending.filter(item=>item.local.id!==command.local.id)
   }
   await this.#save()
  }
  // Validate every page; do not advance the durable cursor until projection commits.
  let cursor=this.#state.cursor
  for(;;){
   const page=await transport.changes(cursor)
   if(page.account_id!==this.#state.account_id)throw Error('account_mismatch')
   if(page.cursor<cursor||page.events.some((event,index)=>event.seq!==cursor+index+1)||page.cursor!==cursor+page.events.length||(page.has_more&&page.events.length===0))throw Error('invalid_changes')
   cursor=page.cursor
   if(!page.has_more)break
  }
  snapshot=await transport.snapshot();this.#accept(snapshot)
  if(snapshot.cursor<cursor)throw Error('hub_history_reset')
  const remote=lifeProjection(snapshot.state),current=this.life.syncState()
  // Preserve edits made while requests were in flight; retry instead of overwriting them.
  if(!same(current,local))throw Error('local_state_changed')
  for(const [id,sent] of uploaded){
   const now=own(lifeProjection(current),id)
   if(now&&!same(sent,now))this.#state.conflicts.push({id,error:'local_changed_while_pending',local:now,remote:own(remote,id)??null})
  }
  const target=Object.values(remote).filter(entity=>!this.#state.unpropagated_local_deletions.includes(entity.id))
  for(const entity of [...target]){
   if('goal_id'in entity&&entity.goal_id&&!target.some(item=>item.id===entity.goal_id)){
    const goal=own(remote,entity.goal_id)
    if(goal?.kind==='goal'){
     target.push(goal)
     if(!this.#state.conflicts.some(conflict=>conflict.id===goal.id&&conflict.error==='local_deletion_has_remote_dependents'))this.#state.conflicts.push({id:goal.id,error:'local_deletion_has_remote_dependents',local:null,remote:goal})
    }
   }
  }
  this.#state.applying={requestId:'hub-projection-'+randomUUID(),expectedStateHash:hash(JSON.stringify(local)),projection:{entities:target,tombstones:Object.keys(snapshot.tombstones)},baseline:remote,versions:hubVersions(snapshot),cursor:snapshot.cursor}
  await this.#save()
  await this.#apply()
 }
}
