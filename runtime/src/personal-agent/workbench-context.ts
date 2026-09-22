import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {MemoryEntry} from '../memory/entry.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
export const contextCardsSchema=z.object({cards:z.array(z.object({tab:z.enum(['todos','ideas','goals','feeds','profile']),title:z.string().trim().min(1).max(160),body:z.string().trim().min(1).max(1200),refs:z.array(z.object({entry_id:z.string().min(1),version:versionSchema}).strict()).min(1).max(8)}).strict()).max(20)}).strict()
export type ContextCards=z.infer<typeof contextCardsSchema>
export type ContextEntry=Pick<MemoryEntry,'id'|'version'|'content'>
export type ContextGenerator=(entries:readonly ContextEntry[],signal:AbortSignal)=>Promise<ContextCards>
const diskSchema=contextCardsSchema.extend({key:z.string(),dismissed:z.array(z.string()).max(1000)})
const keyOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Disposable, grounded suggestions. They never become user commitments or execute work. */
export class WorkbenchContext{
 #store:BoundedJsonStore<z.infer<typeof diskSchema>>;#state:z.infer<typeof diskSchema>={cards:[],key:'',dismissed:[]};#entries:ContextEntry[]=[];#abort=new AbortController();#run:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#status='idle';#opened=false;#tail:Promise<unknown>=Promise.resolve()
 constructor(path:string,readonly generate:ContextGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,diskSchema)}
 async open(){this.#state=await this.#store.read(this.#state);this.#opened=true;this.#abort=new AbortController()}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#tail}
 #valid(card:ContextCards['cards'][number]){return card.refs.every(ref=>this.#entries.some(e=>e.id===ref.entry_id&&e.version===ref.version))}
 snapshot(){return {status:this.#status,cards:this.#state.cards.filter(c=>this.#valid(c)&&!this.#state.dismissed.includes(keyOf(c))).map(c=>({...structuredClone(c),id:keyOf(c),refs:c.refs.map(ref=>({...ref,label:this.#entries.find(e=>e.id===ref.entry_id)?.content.slice(0,700)??ref.entry_id}))}))}}
 #write(fn:(next:z.infer<typeof diskSchema>)=>void){const run=this.#tail.then(async()=>{const next=structuredClone(this.#state);fn(next);await this.#store.write(next);this.#state=next;this.changed()});this.#tail=run.catch(()=>undefined);return run}
 dismiss(id:string){if(!this.#state.cards.some(c=>keyOf(c)===id))throw Error('card_not_found');return this.#write(next=>{next.dismissed=[...new Set([...next.dismissed,id])].slice(-1000)})}
 update(entries:readonly ContextEntry[]){this.#entries=entries.filter(e=>e.version!==null&&e.content.trim());this.changed();if(!this.#opened||!this.generate||this.#run)return;clearTimeout(this.#timer);this.#timer=setTimeout(()=>{void this.refresh()},1000);this.#timer.unref()}
 async refresh():Promise<void>{
  if(!this.#opened||!this.generate||this.#run||!this.#entries.length)return
  // Keep earlier cited context alongside the newest documents; the index remains the full retrieval source.
  const cited=new Set(this.#state.cards.filter(c=>this.#valid(c)).flatMap(c=>c.refs.map(r=>r.entry_id)));const recent=this.#entries.slice(-40);const entries=structuredClone([...recent,...this.#entries.filter(e=>cited.has(e.id)&&!recent.some(r=>r.id===e.id)).slice(-24)]),key=keyOf(entries.map(e=>[e.id,e.version]));if(key===this.#state.key)return
  const generation=keyOf(this.#entries.map(e=>[e.id,e.version]));this.#status='working';this.changed()
  const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(120000)])
  const run=(async()=>{try{
   const result=contextCardsSchema.parse(await this.generate!(entries,signal));signal.throwIfAborted()
   if(result.cards.some(c=>!this.#valid(c)||c.refs.some(r=>!entries.some(e=>e.id===r.entry_id&&e.version===r.version))))throw Error('stale_context')
   await this.#write(next=>{next.cards=result.cards;next.key=key});this.#status='ready'
  }catch(error){this.#status='failed';console.error('[workbench-context] generation_failed',error instanceof z.ZodError?JSON.stringify(error.issues.map(i=>({code:i.code,path:i.path}))):error instanceof Error?error.name:'unknown')}finally{this.#run=undefined;this.changed();if(this.#opened){if(generation!==keyOf(this.#entries.map(e=>[e.id,e.version])))this.update(this.#entries);else if(this.#status==='failed'){this.#timer=setTimeout(()=>{void this.refresh()},300000);this.#timer.unref()}}}})();this.#run=run;await run
 }
}
