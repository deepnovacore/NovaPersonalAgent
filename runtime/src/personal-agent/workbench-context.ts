import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {MemoryEntry} from '../memory/entry.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
import {selectContextCandidates,type ContextCandidate,type ContextInput} from './context-candidates.js'

const refSchema=z.object({entry_id:z.string().min(1),version:versionSchema}).strict()
export const contextCardSchema=z.object({candidate_id:z.string().min(1).max(128),tab:z.enum(['todos','ideas']),title:z.string().trim().min(1).max(160),body:z.string().trim().min(1).max(1200),refs:z.array(refSchema).min(1).max(8)}).strict()
export const contextCardsSchema=z.object({cards:z.array(contextCardSchema).max(20)}).strict()
export type ContextCards=z.infer<typeof contextCardsSchema>
export type ContextEntry=ContextInput | (Pick<MemoryEntry,'id'|'version'|'content'> & {origin?:'stated'|'inferred'})
export type ContextGenerator=(candidates:readonly ContextCandidate[],signal:AbortSignal)=>Promise<ContextCards>
const keyOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateSchema=contextCardsSchema.extend({version:z.literal(2),key:z.string(),dismissed:z.array(z.string()).max(1000),legacyDismissed:z.array(z.object({tab:z.string(),refs:z.array(refSchema)}).strict()).max(1000)})
type State=z.infer<typeof stateSchema>
const diskSchema=z.preprocess(value=>{
 if(!value||typeof value!=='object'||'version' in value)return value
 const old=value as {cards?:unknown;dismissed?:unknown}
 const legacy=z.object({cards:z.array(z.object({tab:z.string(),title:z.string(),body:z.string(),refs:z.array(refSchema)}).passthrough()),dismissed:z.array(z.string()),key:z.string()}).safeParse(old)
 if(!legacy.success)return emptyState()
 return {version:2,cards:[],key:'',dismissed:[],legacyDismissed:legacy.data.cards.filter(card=>legacy.data.dismissed.includes(keyOf(card))).map(card=>({tab:card.tab,refs:card.refs}))}
},stateSchema)
const emptyState=():State=>({version:2,cards:[],key:'',dismissed:[],legacyDismissed:[]})
const sameRef=(a:{entry_id:string;version:string|number},b:{entry_id:string;version:string|number})=>a.entry_id===b.entry_id&&a.version===b.version
const leaksRawField=(card:ContextCards['cards'][number])=>/\/(?:Users|home|Volumes)\/|~\/\.|\b(?:source|file):[\w-]+|\b(?:src|config|docs|runtime|clients)\/[\w./-]+|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=：]|\b[a-f\d]{40,}\b/iu.test(`${card.title} ${card.body}`)

/** Disposable, source-grounded suggestions. Saved Life records live elsewhere. */
export class WorkbenchContext{
 #store:BoundedJsonStore<State>;#state:State=emptyState();#inputs:ContextInput[]=[];#candidates:ContextCandidate[]=[];#abort=new AbortController();#run:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#status='idle';#failedKey:string|null=null;#opened=false;#tail:Promise<unknown>=Promise.resolve()
 constructor(path:string,readonly generate:ContextGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,diskSchema)}
 async open(){try{this.#state=await this.#store.read(emptyState())}catch(error){if(!(error instanceof z.ZodError))throw error;this.#state=emptyState()}this.#opened=true;this.#abort=new AbortController();this.#failedKey=null}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#tail}
 async clear(){const reopen=this.#opened;await this.close();this.#inputs=[];this.#candidates=[];await this.#write(next=>Object.assign(next,emptyState()));this.#abort=new AbortController();this.#opened=reopen;this.#status='idle';this.#failedKey=null}
 #candidate(card:ContextCards['cards'][number]){return this.#candidates.find(candidate=>candidate.candidate_id===card.candidate_id&&candidate.tab===card.tab&&card.refs.every(ref=>candidate.refs.some(allowed=>sameRef(ref,allowed))))}
 #key(){return keyOf(this.#candidates.map(candidate=>[candidate.candidate_id,candidate.version,candidate.priority,candidate.mtime_ms]))}
 snapshot(){const cards=this.#state.cards.filter(card=>this.#candidate(card)&&!this.#state.dismissed.includes(card.candidate_id)).map(card=>({...structuredClone(card),id:card.candidate_id,refs:card.refs.map(ref=>({...ref,label:this.#inputs.find(input=>input.id===ref.entry_id)?.content.slice(0,700)??ref.entry_id}))}));return {status:this.#status,candidate_count:this.#candidates.length,empty_reason:this.#candidates.length===0?'no_eligible_sources':cards.length===0&&this.#status==='ready'?'model_abstained':cards.length===0&&this.#status==='failed'?'generation_failed':null,cards}}
 #write(fn:(next:State)=>void){const run=this.#tail.then(async()=>{const next=structuredClone(this.#state);fn(next);await this.#store.write(next);this.#state=next;this.changed()});this.#tail=run.catch(()=>undefined);return run}
 dismiss(id:string){if(!this.#state.cards.some(card=>card.candidate_id===id))throw Error('card_not_found');return this.#write(next=>{next.dismissed=[...new Set([...next.dismissed,id])].slice(-1000)})}
 update(entries:readonly ContextEntry[]){
  this.#inputs=entries.flatMap<ContextInput>(entry=>{
   if('kind' in entry&&entry.kind==='file')return [entry]
   if('kind' in entry&&entry.kind==='memory')return entry.version===null?[]:[entry]
   if('origin' in entry&&entry.version!==null)return [{kind:'memory',id:entry.id,version:entry.version,content:entry.content,origin:entry.origin??'inferred'}]
   return []
  }).filter(entry=>entry.content.trim())
  this.#candidates=selectContextCandidates(this.#inputs)
  if(this.#state.legacyDismissed.length){const mapped:string[]=[],unmatched:State['legacyDismissed']=[];for(const old of this.#state.legacyDismissed){const matches=this.#candidates.filter(candidate=>candidate.tab===old.tab&&old.refs.length===candidate.refs.length&&old.refs.every(ref=>candidate.refs.some(allowed=>sameRef(ref,allowed))));if(matches.length===1)mapped.push(matches[0]!.candidate_id);else unmatched.push(old)}if(mapped.length)void this.#write(next=>{next.dismissed=[...new Set([...next.dismissed,...mapped])].slice(-1000);next.legacyDismissed=unmatched}).catch(()=>undefined)}
  this.changed();if(!this.#opened||!this.generate||this.#run||!this.#candidates.length||this.#failedKey===this.#key())return;clearTimeout(this.#timer);this.#timer=setTimeout(()=>{void this.refresh()},1000);this.#timer.unref()
 }
 async refresh():Promise<void>{
  if(!this.#opened||!this.generate||this.#run||!this.#candidates.length)return
  const candidates=structuredClone(this.#candidates),key=this.#key();if(key===this.#state.key){this.#status='ready';this.changed();return}
  const generation=this.#key();this.#status='working';this.changed()
  const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(120000)])
  const run=(async()=>{try{
   const result=contextCardsSchema.parse(await this.generate!(candidates,signal));signal.throwIfAborted()
   const seen=new Set<string>()
   const cards=result.cards.filter(card=>{if(seen.has(card.candidate_id)||leaksRawField(card)||!this.#candidate(card)||!card.refs.every(ref=>candidates.some(candidate=>candidate.candidate_id===card.candidate_id&&candidate.refs.some(allowed=>sameRef(ref,allowed)))))return false;seen.add(card.candidate_id);return true})
   await this.#write(next=>{next.cards=cards;next.key=key});this.#status='ready';this.#failedKey=null
  }catch(error){this.#status='failed';this.#failedKey=key;console.error('[workbench-context] generation_failed',error instanceof z.ZodError?JSON.stringify(error.issues.map(i=>({code:i.code,path:i.path}))):error instanceof Error?error.name:'unknown')}finally{this.#run=undefined;this.changed();if(this.#opened){if(generation!==this.#key())this.update(this.#inputs);else if(this.#status==='failed'){this.#timer=setTimeout(()=>{void this.refresh()},300000);this.#timer.unref()}}}})();this.#run=run;await run
 }
}
