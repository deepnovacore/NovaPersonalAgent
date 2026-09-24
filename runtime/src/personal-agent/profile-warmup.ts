import {createHash} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
import type {MemoryEntry} from '../memory/entry.js'
const refs=z.array(z.object({entry_id:z.string().min(1).max(256),version:versionSchema}).strict()).min(1).max(8)
export const profileDraftSchema=z.object({
 about:z.object({text:z.string().trim().min(1).max(800),refs}).strict().nullable(),
 work:z.array(z.object({title:z.string().trim().min(1).max(80),text:z.string().trim().min(1).max(500),refs}).strict()).max(6).default([]),
 interests:z.array(z.object({text:z.string().trim().min(1).max(100),refs}).strict()).max(8),
}).strict()
export type ProfileDraft=z.infer<typeof profileDraftSchema>
export type ProfileInput=Pick<MemoryEntry,'id'|'version'|'content'|'origin'> & {source?:{project:string;document:string}}
export type ProfileGenerator=(entries:readonly ProfileInput[],signal:AbortSignal)=>Promise<z.input<typeof profileDraftSchema>>
const diskSchema=z.object({key:z.string(),draft:profileDraftSchema.nullable()})
/** Disposable suggestions only: never writes profile facts, news preferences, or consent. */
export class ProfileWarmup{
 #store:BoundedJsonStore<z.infer<typeof diskSchema>>;#cache:z.infer<typeof diskSchema>={key:'',draft:null}
 #entries:ProfileInput[]=[];#key='';#attempted='';#status:'idle'|'working'|'ready'|'failed'='idle';#opened=false
 #abort=new AbortController();#run:Promise<void>|undefined;#writes:Promise<void>=Promise.resolve()
 #timer:ReturnType<typeof setTimeout>|undefined;#firstChangeAt=0
 constructor(path:string,readonly generate:ProfileGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,diskSchema)}
 async open(){this.#cache=await this.#store.read(this.#cache);this.#opened=true}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#writes}
 #persist(cache:z.infer<typeof diskSchema>){const write=this.#writes.then(()=>this.#store.write(cache));this.#writes=write.catch(()=>{/* The caller reports a failed persistence attempt. */});return write}
 async clear(){this.invalidate();this.#cache={key:'',draft:null};await this.#run;await this.#persist(this.#cache)}
 #valid(draft:ProfileDraft){return [...(draft.about?[draft.about]:[]),...draft.work,...draft.interests].every(f=>f.refs.every(r=>this.#entries.some(e=>e.id===r.entry_id&&e.version===r.version&&(e.origin==='stated'||!!e.source))))}
 invalidate(){clearTimeout(this.#timer);this.#firstChangeAt=0;this.#abort.abort();this.#entries=[];this.#key='';this.#status='idle'}
 snapshot(){return {status:this.#status,draft:this.#key&&this.#cache.draft&&this.#valid(this.#cache.draft)?structuredClone(this.#cache.draft):null,sources:this.#entries.map(e=>({id:e.id,version:e.version,label:e.source?`${e.source.project}/${e.source.document}`:'你提供的信息'}))}}
 update(entries:readonly ProfileInput[]){
  const usable=entries.filter(e=>e.version!==null&&e.content.trim())
  const selected=[...usable.filter(e=>!e.source).slice(-16),...usable.filter(e=>e.source).slice(0,24)]
   .map(e=>({id:e.id,version:e.version,content:e.content.slice(0,1500),origin:e.origin,...(e.source?{source:e.source}:{})})).sort((a,b)=>a.id.localeCompare(b.id))
  const key=selected.length?createHash('sha256').update(JSON.stringify(selected)).digest('hex'):''
  if(key!==this.#key){this.#abort.abort();this.#key=key;this.#entries=selected;this.#status=key&&this.#cache.key===key?'ready':key&&key===this.#attempted&&!this.#run?'failed':'idle'}
  if(this.#cache.draft&&!this.#valid(this.#cache.draft)){this.#cache={key:'',draft:null};void this.#persist(this.#cache).catch(()=>{this.#status='failed';this.changed()})}
  if(selected.some(entry=>entry.source)){
   if(!this.#firstChangeAt)this.#firstChangeAt=Date.now()
   clearTimeout(this.#timer)
   const due=Math.min(this.#firstChangeAt+20_000,Date.now()+5_000)
   this.#timer=setTimeout(()=>{this.#timer=undefined;this.#firstChangeAt=0;void this.refresh()},Math.max(0,due-Date.now()))
   this.#timer.unref()
  }else{clearTimeout(this.#timer);this.#firstChangeAt=0;void this.refresh()}
 }
 refresh(retry=false):Promise<void>{
  clearTimeout(this.#timer);this.#timer=undefined;this.#firstChangeAt=0
  if(this.#run)return this.#run
  if(!this.#opened||!this.#key||!this.generate)return Promise.resolve()
  if(!retry&&(this.#cache.key===this.#key||this.#attempted===this.#key))return Promise.resolve()
  const key=this.#key,entries=structuredClone(this.#entries),controller=new AbortController();this.#abort=controller;this.#attempted=key;this.#status='working'
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])
  const run=(async()=>{
   let cancel:()=>void=()=>{/* Assigned when the abort listener is installed. */}
   try{
    const result=await Promise.race([this.generate!(entries,signal),new Promise<never>((_,reject)=>{cancel=()=>reject(Error('warmup_aborted'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()})])
    signal.throwIfAborted();const draft=profileDraftSchema.parse(result)
    const facts=[...(draft.about?[draft.about]:[]),...draft.work,...draft.interests]
    if(facts.some(f=>f.refs.some(r=>!entries.some(e=>e.id===r.entry_id&&e.version===r.version&&(e.origin==='stated'||!!e.source)))))throw Error('invalid_profile_evidence')
    if(!this.#opened||key!==this.#key)return
    const cache={key,draft};await this.#persist(cache)
    if(!this.#opened||key!==this.#key||signal.aborted)return
    this.#cache=cache;this.#status='ready'
   }catch{if(this.#opened&&key===this.#key&&!controller.signal.aborted)this.#status='failed'}
   finally{signal.removeEventListener('abort',cancel)}
  })()
  this.#run=run;this.changed()
  void run.finally(()=>{this.#run=undefined;if(controller.signal.aborted)this.#attempted='';if(this.#opened){this.changed();if(key!==this.#key||controller.signal.aborted)this.update(this.#entries)}})
  return run
 }
}
