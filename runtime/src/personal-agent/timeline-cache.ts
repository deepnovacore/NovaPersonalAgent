import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'

const HOUR=60*60*1000
/** Positive and negative screening indexes age out with the timeline's own two-week window. */
const INDEX_TTL=72*HOUR
/** Cached stage replies only describe one model/system/prompt triple; a day is long enough to absorb repeated runs. */
const STAGE_TTL=24*HOUR
const MAX_TOPICS=256
const MAX_SCREENED=4096
const MAX_STAGES=128
/** Leave headroom below BoundedJsonStore's 4MB limit; a write that cannot fit is skipped instead of failing the run. */
const MAX_WRITE_BYTES=3*1024*1024
const WRITE_DEBOUNCE_MS=1000

const memberSchema=z.object({id:z.string(),version:z.string()})
const topicSchema=z.object({scope:z.string(),title:z.string(),at:z.number(),members:z.array(memberSchema)})
const screenedSchema=z.object({scope:z.string(),id:z.string(),version:z.string(),at:z.number()})
export const timelineCacheStageKindSchema=z.enum(['select','reconcile','batch'])
const stageSchema=z.object({key:z.string(),kind:timelineCacheStageKindSchema,at:z.number(),payload:z.unknown()})
const documentSchema=z.object({version:z.literal(1),topics:z.array(topicSchema),screened:z.array(screenedSchema),stages:z.array(stageSchema)})
type Document=z.infer<typeof documentSchema>
type TopicEntry=z.infer<typeof topicSchema>
type StageEntry=z.infer<typeof stageSchema>
export type TimelineCacheStageKind=z.infer<typeof timelineCacheStageKindSchema>

const emptyDocument=():Document=>({version:1,topics:[],screened:[],stages:[]})
const topicKey=(topic:Pick<TopicEntry,'scope'|'title'|'members'>):string=>topic.scope+'\0'+topic.title+'\0'+topic.members.map(member=>member.id+'\u0001'+member.version).join('\u0002')
const clone=<T>(value:T):T|undefined=>{try{return structuredClone(value)}catch{return undefined}}

/** A reused topic is referenced by its surviving members, never by a stored prose or quote. */
export interface TimelineCacheTopic {
 readonly scope:string
 readonly title:string
 readonly at:number
 readonly members:readonly {readonly id:string;readonly version:string}[]
}
export interface TimelineCachedTopic {
 readonly title:string
 readonly members:readonly {readonly id:string;readonly version:string}[]
}
export interface TimelineCacheStage {
 readonly kind:TimelineCacheStageKind
 readonly payload:unknown
}
/**
 * One generation's view of the cache. A run created before `clear()` keeps writing into its
 * own epoch, so late model replies can never repopulate a cache the caller just discarded.
 */
export interface TimelineCacheRun {
 getTopics():TimelineCacheTopic[]
 getScreened():{id:string;version:string}[]
 appendBatchResult(result:{topics:readonly TimelineCachedTopic[];screened:readonly {id:string;version:string}[]}):void
 getStage(key:string):TimelineCacheStage|undefined
 putStage(key:string,kind:TimelineCacheStageKind,payload:unknown):void
 deleteStage(key:string):void
 commit():Promise<void>
}
export interface TimelineCachePort {
 open():Promise<void>
 beginRun(scope:string):TimelineCacheRun
 clear():Promise<void>
 flush():Promise<void>
}
/** Optional incremental cache wiring for one timeline generation. */
export interface TimelineRunOptions {
 readonly cache?:TimelineCachePort
 readonly scope:string
 readonly force:boolean
}
export interface TimelineCacheOptions {
 readonly now?:()=>number
}

/**
 * Durable incremental index for PC Timeline generation.
 *
 * Every operation is fail-open: a corrupt file, a schema change or a full disk only loses the
 * cache, never a briefing. Writes are serialized and debounced, and a write that cannot be
 * bounded to `MAX_WRITE_BYTES` is skipped rather than reported.
 */
export class TimelineCache implements TimelineCachePort {
 readonly #store:BoundedJsonStore<Document>
 readonly #now:()=>number
 #document:Document=emptyDocument()
 #epoch=0
 #tail:Promise<void>=Promise.resolve()
 #timer:ReturnType<typeof setTimeout>|undefined
 #dirty=false
 constructor(readonly path:string,options:TimelineCacheOptions={}){
  this.#store=new BoundedJsonStore(path,documentSchema)
  this.#now=options.now??Date.now
 }
 /** Opening never throws: an unreadable cache is treated as empty. */
 async open():Promise<void>{
  try{this.#document=this.#prune(await this.#store.read(emptyDocument()))}
  catch{this.#document=emptyDocument()}
 }
 beginRun(scope:string):TimelineCacheRun{
  const epoch=this.#epoch
  const current=():boolean=>epoch===this.#epoch
  return {
   getTopics:()=>current()?this.#topics(scope):[],
   getScreened:()=>current()?this.#screened(scope):[],
   appendBatchResult:result=>{if(current())this.#append(scope,result)},
   getStage:key=>current()?this.#stage(key):undefined,
   putStage:(key,kind,payload)=>{if(current())this.#put(key,kind,payload)},
   deleteStage:key=>{if(current())this.#delete(key)},
   commit:()=>current()?this.#flush():Promise.resolve(),
  }
 }
 /** Discards both indexes and every stage; an in-flight run's later writes are dropped by the epoch bump. */
 async clear():Promise<void>{
  this.#epoch++
  if(this.#timer!==undefined){clearTimeout(this.#timer);this.#timer=undefined}
  this.#document=emptyDocument()
  this.#dirty=true
  await this.#enqueue()
 }
 /** Settles the debounced write queue without discarding the cache. */
 async flush():Promise<void>{
  await this.#flush()
 }
 #topics(scope:string):TimelineCacheTopic[]{
  const now=this.#now()
  return this.#document.topics.filter(topic=>topic.scope===scope&&now-topic.at<=INDEX_TTL).map(topic=>({scope:topic.scope,title:topic.title,at:topic.at,members:topic.members.map(member=>({...member}))}))
 }
 #screened(scope:string):{id:string;version:string}[]{
  const now=this.#now(),seen=new Map<string,{id:string;version:string}>()
  for(const entry of this.#document.screened)if(entry.scope===scope&&now-entry.at<=INDEX_TTL)seen.set(entry.id,{id:entry.id,version:entry.version})
  return [...seen.values()]
 }
 #append(scope:string,result:{topics:readonly TimelineCachedTopic[];screened:readonly {id:string;version:string}[]}):void{
  const now=this.#now()
  const topics=new Map(this.#document.topics.map(topic=>[topicKey(topic),topic]))
  for(const topic of result.topics){
   const members=[...new Map(topic.members.map(member=>[member.id,{id:member.id,version:member.version}])).values()]
   if(!members.length)continue
   const entry:TopicEntry={scope,title:topic.title,at:now,members}
   topics.set(topicKey(entry),entry)
  }
  const screened=new Map(this.#document.screened.map(entry=>[entry.scope+'\0'+entry.id,entry]))
  for(const entry of result.screened)screened.set(scope+'\0'+entry.id,{scope,id:entry.id,version:entry.version,at:now})
  this.#document={...this.#document,
   topics:[...topics.values()].sort((a,b)=>a.at-b.at),
   screened:[...screened.values()].sort((a,b)=>a.at-b.at)}
  this.#document=this.#prune(this.#document)
  this.#touch()
 }
 #stage(key:string):TimelineCacheStage|undefined{
  const now=this.#now(),entry=this.#document.stages.find(stage=>stage.key===key)
  if(!entry||now-entry.at>STAGE_TTL)return undefined
  const payload=clone(entry.payload)
  return payload===undefined?undefined:{kind:entry.kind,payload}
 }
 #put(key:string,kind:TimelineCacheStageKind,payload:unknown):void{
  const stored=clone(payload)
  if(stored===undefined)return
  const entry:StageEntry={key,kind,at:this.#now(),payload:stored}
  this.#document={...this.#document,stages:[...this.#document.stages.filter(stage=>stage.key!==key),entry]}
  this.#document=this.#prune(this.#document)
  this.#touch()
 }
 #delete(key:string):void{
  const stages=this.#document.stages.filter(stage=>stage.key!==key)
  if(stages.length===this.#document.stages.length)return
  this.#document={...this.#document,stages}
  this.#touch()
 }
 #prune(document:Document):Document{
  const now=this.#now()
  const topics=document.topics.filter(topic=>now-topic.at<=INDEX_TTL).sort((a,b)=>a.at-b.at).slice(-MAX_TOPICS)
  const screened=document.screened.filter(entry=>now-entry.at<=INDEX_TTL).sort((a,b)=>a.at-b.at).slice(-MAX_SCREENED)
  const stages=document.stages.filter(stage=>now-stage.at<=STAGE_TTL).sort((a,b)=>a.at-b.at).slice(-MAX_STAGES)
  return {version:1,topics,screened,stages}
 }
 #touch():void{
  this.#dirty=true
  if(this.#timer!==undefined)return
  this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#enqueue()},WRITE_DEBOUNCE_MS)
  this.#timer.unref?.()
 }
 #flush():Promise<void>{
  if(this.#timer!==undefined){clearTimeout(this.#timer);this.#timer=undefined}
  if(!this.#dirty)return this.#tail
  return this.#enqueue()
 }
 #enqueue():Promise<void>{
  const run=this.#tail.then(()=>this.#write())
  this.#tail=run.catch(()=>undefined)
  return run.catch(()=>undefined)
 }
 async #write():Promise<void>{
  if(!this.#dirty)return
  this.#dirty=false
  try{
   const document=this.#prune(this.#document)
   const stages=[...document.stages]
   // Byte eviction is by oldest stage first: the index keeps every reusable topic, while a
   // day-old model reply is the cheapest thing to lose.
   let text=JSON.stringify({...document,stages})
   while(Buffer.byteLength(text)>MAX_WRITE_BYTES&&stages.length){stages.shift();text=JSON.stringify({...document,stages})}
   if(Buffer.byteLength(text)>MAX_WRITE_BYTES)return
   await this.#store.write({...document,stages})
  }catch{/* the cache is optional; generation must not fail because the index could not be persisted */}
 }
}
