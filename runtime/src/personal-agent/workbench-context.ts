import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {MemoryEntry} from '../memory/entry.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
import {selectContextCandidates,type ContextCandidate,type ContextInput} from './context-candidates.js'

const refSchema=z.object({entry_id:z.string().min(1),version:versionSchema}).strict()
export const contextCardSchema=z.object({candidate_id:z.string().min(1).max(128),tab:z.enum(['todos','ideas']),title:z.string().trim().min(1).max(80),body:z.string().trim().min(1).max(120),refs:z.array(refSchema).min(1).max(8)}).strict()
export const contextCardsSchema=z.object({cards:z.array(contextCardSchema).max(20)}).strict()
export type ContextCards=z.infer<typeof contextCardsSchema>
export type ContextEntry=ContextInput | (Pick<MemoryEntry,'id'|'version'|'content'> & {origin?:'stated'|'inferred'})
export type ContextGenerator=(candidates:readonly ContextCandidate[],signal:AbortSignal)=>Promise<ContextCards>
const keyOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateSchema=contextCardsSchema.extend({version:z.literal(2),key:z.string(),automatic_call_times:z.array(z.number().int().nonnegative()).max(6).default([]),dismissed:z.array(z.string()).max(1000),legacyDismissed:z.array(z.object({tab:z.string(),refs:z.array(refSchema)}).strict()).max(1000)})
type State=z.infer<typeof stateSchema>
const diskSchema=z.preprocess(value=>{
 if(!value||typeof value!=='object'||'version' in value)return value
 const old=value as {cards?:unknown;dismissed?:unknown}
 const legacy=z.object({cards:z.array(z.object({tab:z.string(),title:z.string(),body:z.string(),refs:z.array(refSchema)}).passthrough()),dismissed:z.array(z.string()),key:z.string()}).safeParse(old)
 if(!legacy.success)return emptyState()
 return {version:2,cards:[],key:'',dismissed:[],legacyDismissed:legacy.data.cards.filter(card=>legacy.data.dismissed.includes(keyOf(card))).map(card=>({tab:card.tab,refs:card.refs}))}
},stateSchema)
const emptyState=():State=>({version:2,cards:[],key:'',automatic_call_times:[],dismissed:[],legacyDismissed:[]})
const sameRef=(a:{entry_id:string;version:string|number},b:{entry_id:string;version:string|number})=>a.entry_id===b.entry_id&&a.version===b.version
const leaksRawField=(card:ContextCards['cards'][number])=>/\/(?:Users|home|Volumes)\/|~\/\.|\b(?:source|file):[\w-]+|\b(?:src|config|docs|runtime|clients)\/[\w./-]+|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=：]|\b[a-f\d]{40,}\b/iu.test(`${card.title} ${card.body}`)

/** Disposable, source-grounded suggestions. Saved Life records live elsewhere. */
export class WorkbenchContext{
 #store:BoundedJsonStore<State>;#state:State=emptyState();#inputs:ContextInput[]=[];#candidates:ContextCandidate[]=[];#abort=new AbortController();#run:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#status='idle';#failedKey:string|null=null;#opened=false;#tail:Promise<unknown>=Promise.resolve();#firstChangeAt:number|null=null;#lastChangeAt=0;#pendingKey='';#manualPending=false
 constructor(path:string,readonly generate:ContextGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,diskSchema)}
 async open(){try{this.#state=await this.#store.read(emptyState())}catch(error){if(!(error instanceof z.ZodError))throw error;this.#state=emptyState()}this.#opened=true;this.#abort=new AbortController();this.#failedKey=null;this.#firstChangeAt=null;this.#pendingKey='';this.#manualPending=false}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#timer=undefined;this.#manualPending=false;this.#abort.abort();await this.#run;await this.#tail}
 async clear(){const reopen=this.#opened;await this.close();this.#inputs=[];this.#candidates=[];await this.#write(next=>Object.assign(next,emptyState()));this.#abort=new AbortController();this.#opened=reopen;this.#status='idle';this.#failedKey=null}
 #candidate(card:ContextCards['cards'][number]){return this.#candidates.find(candidate=>candidate.candidate_id===card.candidate_id&&candidate.tab===card.tab&&card.refs.every(ref=>candidate.refs.some(allowed=>sameRef(ref,allowed))))}
 #key(){return keyOf(this.#candidates.map(candidate=>[candidate.candidate_id,candidate.version]))}
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
  this.changed();if(!this.#opened||!this.generate)return
  const key=this.#key();if(!this.#candidates.length||key===this.#state.key||key===this.#failedKey){clearTimeout(this.#timer);this.#timer=undefined;this.#firstChangeAt=null;this.#pendingKey='';return}
  if(key!==this.#pendingKey){const now=Date.now();if(this.#firstChangeAt===null)this.#firstChangeAt=now;this.#lastChangeAt=now;this.#pendingKey=key}
  this.#schedule()
 }
 #schedule(){
  clearTimeout(this.#timer);this.#timer=undefined
  if(!this.#opened||!this.generate||this.#run||!this.#candidates.length||this.#key()===this.#state.key||this.#firstChangeAt===null)return
  const now=Date.now(),recent=this.#state.automatic_call_times.filter(at=>at>now-3_600_000),first=this.#state.automatic_call_times.length===0&&this.#state.key===''
  const due=Math.min(this.#firstChangeAt+(first?10_000:120_000),this.#lastChangeAt+(first?3_000:30_000))
  const eligible=Math.max(due,(recent.at(-1)??-Infinity)+120_000,recent.length>=6?recent[0]!+3_600_000:-Infinity)
  this.#timer=setTimeout(()=>{this.#timer=undefined;if(this.#key()!==this.#state.key)void this.#generate(true)},Math.max(0,eligible-now));this.#timer.unref()
 }
 async refresh():Promise<void>{if(this.#run){this.#manualPending=true;return this.#run}await this.#generate(false)}
 async #generate(automatic:boolean):Promise<void>{
  if(!this.#opened||!this.generate||this.#run||!this.#candidates.length)return
  clearTimeout(this.#timer);this.#timer=undefined
  const candidates=structuredClone(this.#candidates),key=this.#key();if(key===this.#state.key){this.#status='ready';this.changed();return}
  this.#firstChangeAt=null;this.#pendingKey='';this.#status='working';this.changed()
  const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(120000)])
  const run=(async()=>{try{
   if(automatic)await this.#write(next=>{next.automatic_call_times=[...next.automatic_call_times.filter(at=>at>Date.now()-3_600_000),Date.now()].slice(-6)})
   const result=contextCardsSchema.parse(await this.generate!(candidates,signal));signal.throwIfAborted()
   const seen=new Set<string>()
   const cards=result.cards.filter(card=>{if(seen.has(card.candidate_id)||leaksRawField(card)||!this.#candidate(card)||!card.refs.every(ref=>candidates.some(candidate=>candidate.candidate_id===card.candidate_id&&candidate.refs.some(allowed=>sameRef(ref,allowed)))))return false;seen.add(card.candidate_id);return true})
   await this.#write(next=>{next.cards=cards;next.key=key});this.#status='ready';this.#failedKey=null
  }catch(error){this.#status='failed';this.#failedKey=key;console.error('[workbench-context] generation_failed',error instanceof z.ZodError?JSON.stringify(error.issues.map(i=>({code:i.code,path:i.path}))):error instanceof Error?error.name:'unknown')}finally{this.#run=undefined;this.changed();if(this.#opened){if(this.#manualPending){this.#manualPending=false;void this.refresh()}else if(key!==this.#key())this.update(this.#inputs);else if(this.#status==='failed'){this.#timer=setTimeout(()=>{void this.refresh()},300000);this.#timer.unref()}}}})();this.#run=run;await run
 }
}
