import {z} from 'zod'
import {TEMPORAL_RECIPE,temporalReplySchema,resolveWorkbenchGroups} from './workbench-temporal.js'
import {readFile} from 'node:fs/promises'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import type {TimelineInput} from './timeline-brief.js'
import type {ContextEntry} from './workbench-context.js'
import type {ProjectDigest} from './project-digests.js'
import type {LifeService} from './life.js'
import {sourceTagSchema} from '../memory/provenance.js'
import {automaticWorkbenchMatter,validWorkbenchMatter,workbenchBatches,workbenchCompositionSchema,workbenchExistingCandidates,workbenchHash,workbenchMatterSchema,workbenchRefSchema,workbenchSensitive,type WorkbenchExisting,type WorkbenchGenerator,type WorkbenchMatter} from './workbench-evidence.js'

const matterSchema=workbenchMatterSchema.extend({id:z.string(),group:z.string(),observed_at:z.string().default('')})
const cardSchema=z.object({id:z.string(),candidate_id:z.string(),tab:z.enum(['ideas','goals']),title:z.string(),body:z.string(),why:z.string().nullable(),next:z.string().nullable(),refs:z.array(workbenchRefSchema),sources:z.array(sourceTagSchema),update:z.object({id:z.string(),kind:z.literal('goal'),version:z.number(),status:z.string()}).optional()})
const cacheSchema=z.object({key:z.string(),group:z.string(),basis:z.array(z.object({id:z.string(),version:z.string()})),matters:z.array(matterSchema)})
const recordedSchema=z.object({matter: matterSchema.pick({id:true,kind:true,title:true,summary:true}),id:z.string(),version:z.number(),undone:z.boolean().default(false)})
const legacyDismissedSchema=z.object({tab:z.string(),refs:z.array(z.object({entry_id:z.string(),version:z.union([z.string(),z.number()])}))})
/** Todo generation is gone: a cache that still holds todo matters, todo cards or recorded todos is cleared, and the day is reopened for a fresh run. */
const dropTodoState=(raw:unknown):unknown=>{
 if(!raw||typeof raw!=='object')return raw
 const state=raw as {cards?:{tab?:unknown;update?:{kind?:unknown}}[];cache?:{matters?:{kind?:unknown}[]}[];recorded?:{matter?:{kind?:unknown}}[]},todo=(row?:{kind?:unknown})=>row?.kind==='todo'
 const stale=(state.cards??[]).some(card=>card.tab==='todos'||todo(card.update))||(state.cache??[]).some(entry=>(entry.matters??[]).some(todo))||(state.recorded??[]).some(row=>todo(row.matter))
 return stale?{...state,temporal:null,compositions:[],cache:[],cards:[],key:'',updated_at:null,automatic_day:'',recorded:(state.recorded??[]).filter(row=>!todo(row.matter))}:raw
}
const stateSchema=z.preprocess(dropTodoState,z.object({version:z.literal(1),failure:z.string().nullable().default(null),temporal:z.object({key:z.string(),source_key:z.string().default(''),result:temporalReplySchema}).nullable().default(null),legacy_imported:z.boolean().default(false),legacy_dismissed:z.array(legacyDismissedSchema).default([]),automatic_day:z.string(),key:z.string(),updated_at:z.string().nullable(),cache:z.array(cacheSchema),compositions:z.array(z.object({key:z.string(),result:workbenchCompositionSchema})).default([]),cards:z.array(cardSchema),dismissed:z.array(z.string()),recorded:z.array(recordedSchema),
 diagnostics:z.object({inputs:z.number(),cache_hits:z.number(),extraction_calls:z.number(),composition_calls:z.number(),received:z.number(),rejected:z.number(),recorded:z.number()})}))
type State=z.infer<typeof stateSchema>
const diagnostics=()=>({inputs:0,cache_hits:0,extraction_calls:0,composition_calls:0,received:0,rejected:0,recorded:0})
const empty=():State=>({version:1,failure:null,temporal:null,legacy_imported:false,legacy_dismissed:[],automatic_day:'',key:'',updated_at:null,cache:[],compositions:[],cards:[],dismissed:[],recorded:[],diagnostics:diagnostics()})
const RECIPE='workbench-daily-v1'
function invalidMatches(reason:'count'|'unknown_matter'|'duplicate_matter'|'invalid_target'|'invalid_same_as'):never{
 throw Object.assign(Error('invalid_workbench_matches'),{classification:'invalid_workbench_matches_'+reason})
}
function unresolvedWorkbenchReference(card:{title:string;body:string;why:string|null;next:string|null;refs:readonly {quote:string}[]}):boolean{
 const references=(text:string)=>text.match(/\b[me]\d+\b/gu)??[];const quoted=new Set(card.refs.flatMap(ref=>references(ref.quote)));
 return references([card.title,card.body,card.why,card.next].join(' ')).some(id=>!quoted.has(id));
}
interface DailyWorkbenchOptions {
 path:string;legacyPath?:string;generate:WorkbenchGenerator;life:()=>LifeService;changed:()=>void;
 inputs:()=>Promise<TimelineInput[]>;inputsReady?:()=>boolean;timezone:()=>string;now?:()=>Date;ready:()=>boolean;
}
/** One daily interpretation shared by three tabs; this service never dispatches agent tasks. */
export class DailyWorkbench {
 readonly #store:BoundedJsonStore<State>;#state:State=empty();#inputs:TimelineInput[]=[];#opened=false;#defer=true;#status='idle';#error:string|null=null
 #abort=new AbortController();#run:Promise<void>|undefined;#sync:Promise<void>|undefined;#tail:Promise<void>=Promise.resolve();#timer:ReturnType<typeof setTimeout>|undefined;#pendingValidation=false;#inputRevision=0
 constructor(readonly options:DailyWorkbenchOptions){this.#store=new BoundedJsonStore(options.path,stateSchema,16*1024*1024)}
 #now(){return this.options.now?.()??new Date()}
 #day(){return this.#now().toLocaleDateString('en-CA',{timeZone:this.options.timezone()})}
 #key(inputs=this.#inputs){return workbenchHash([RECIPE,TEMPORAL_RECIPE,this.options.timezone(),inputs.map(({id,version})=>[id,version]),this.#state.cache.flatMap(c=>c.matters).filter(m=>m.due).map(m=>[m.id,m.due!<this.#day()])])}
 async #save(){const state=structuredClone(this.#state);const run=this.#tail.then(()=>this.#store.write(state));this.#tail=run.catch(()=>undefined);await run}
 async open({deferGeneration=false}:{deferGeneration?:boolean}={}){this.#error=null;try{this.#state=await this.#store.read(empty())}catch(error){if(!(error instanceof z.ZodError||error instanceof SyntaxError))throw error;this.#state=empty();this.#state.automatic_day=this.#day();this.#error='cache_invalid'}
  if(!this.#error&&!this.#state.legacy_imported){
   if(this.options.legacyPath)try{const old=z.object({cards:z.array(legacyDismissedSchema.extend({candidate_id:z.string().optional()}).passthrough()),dismissed:z.array(z.string())}).parse(JSON.parse(await readFile(this.options.legacyPath,'utf8')));this.#state.legacy_dismissed=old.cards.filter(card=>old.dismissed.includes(card.candidate_id??workbenchHash(card))).map(({tab,refs})=>({tab,refs}))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.#error='cache_invalid'}
   if(!this.#error){this.#state.legacy_imported=true;await this.#save()}
  }
  this.#opened=true;this.#defer=deferGeneration;this.#abort=new AbortController();if(this.#error)this.#status='failed'
 }
 startGeneration(){this.#defer=false;void this.sync().catch(()=>undefined)}
 suspend(){this.#pendingValidation=true;this.#inputRevision++;this.options.changed()}
 // Host document updates only wake the shared source read; there is no second file-only model path.
 update(entries:readonly ContextEntry[],digests?:{items:readonly ProjectDigest[];pending:number}){void entries;void digests;void this.sync().catch(()=>undefined)}
 sync():Promise<void>{
  // An incomplete startup projection is not a source withdrawal. Keep durable caches
  // until the host can supply its full first snapshot; current cards still have no inputs.
  if(this.#error==='cache_invalid'||this.options.inputsReady?.()===false)return Promise.resolve()
  if(this.#sync)return this.#sync
  const run=(async()=>{try{let revision:number,inputs:TimelineInput[]
   do{revision=this.#inputRevision;inputs=await this.options.inputs()}while(revision!==this.#inputRevision&&this.#opened)
   if(!this.#opened)return
   const next=inputs.filter(input=>input.text.trim()&&!workbenchSensitive(input.text)).sort((a,b)=>a.id.localeCompare(b.id))
   if(this.#inputs.some(old=>!next.some(input=>input.id===old.id&&input.version===old.version))||this.#run&&workbenchHash(this.#inputs.map(i=>[i.id,i.version]))!==workbenchHash(next.map(i=>[i.id,i.version]))){this.#abort.abort();this.#abort=new AbortController()}
   this.#inputs=next;this.#pendingValidation=false;if(this.#error==='sources_unavailable')this.#error=null;
   const kept=this.#state.cache.filter(c=>c.basis.every(ref=>next.some(input=>input.id===ref.id&&input.version===ref.version)))
   if(kept.length!==this.#state.cache.length){this.#state.cache=kept;this.#state.compositions=[];this.#state.cards=this.#state.cards.filter(card=>this.#grounded(card.refs));await this.#save()}
   this.options.changed();this.#schedule()
  }catch{this.#inputs=[];this.#abort.abort();this.#abort=new AbortController();this.#status='failed';this.#error='sources_unavailable';this.options.changed()}})();this.#sync=run;void run.finally(()=>{if(this.#sync===run)this.#sync=undefined});return run
 }
 #schedule(){clearTimeout(this.#timer);if(!this.#opened||this.#defer||this.#run||!this.#inputs.length||!this.options.ready()||this.#state.automatic_day>=this.#day()||this.#state.key===this.#key())return
  this.#timer=setTimeout(()=>{void this.refresh(true)},3000);this.#timer.unref()
 }
 #grounded(refs:readonly {entry_id:string;version:string|number}[]){return refs.every(ref=>this.#inputs.some(input=>input.id===ref.entry_id&&input.version===String(ref.version)))}
 sourcesForRefs(refs:readonly {entry_id:string;version:string|number}[]){return refs.flatMap(ref=>{const input=this.#inputs.find(input=>input.id===ref.entry_id&&input.version===String(ref.version));return input?.source?[input.source]:[]})}
 #temporalCurrent(){return this.#state.temporal?.source_key===workbenchHash(this.#inputs.map(i=>[i.id,i.version]))}
 snapshot(){
  const life=this.options.life().snapshot()
  const cards=this.#state.cards.filter(card=>(card.tab==='ideas'||this.#temporalCurrent())&&(!card.update||life.goals.some(row=>row.id===card.update!.id&&row.version===card.update!.version&&row.status!==card.update!.status))&&!this.#pendingValidation&&!this.#state.dismissed.includes(card.id)&&this.#grounded(card.refs)&&!unresolvedWorkbenchReference(card)).map(card=>({...card,refs:card.refs.map(ref=>({...ref,label:ref.quote}))}))
  const count=this.#state.cache.flatMap(c=>c.matters).filter(m=>this.#grounded(m.refs)).length
  const reason=this.#error?'generation_failed':!this.#inputs.length?'no_eligible_sources':this.#state.updated_at?this.#state.diagnostics.rejected&&!count?'validation_filtered':'model_abstained':null
  return {status:this.#status,candidate_count:count,recap:{text:null,projects:[] as {name:string;line:string}[]},cards,empty_reason:cards.length?null:reason,
   empty_reasons:Object.fromEntries(['ideas','goals'].map(tab=>[tab,cards.some(c=>c.tab===tab)?null:reason])) as Record<'ideas'|'goals',string|null>,
   daily:true,automatic_available:this.#state.automatic_day<this.#day(),updated_at:this.#state.updated_at,error:this.#error,diagnostics:structuredClone(this.#state.diagnostics)}
 }
 async dismiss(id:string){if(!this.snapshot().cards.some(card=>card.id===id))throw Error('card_not_found');await this.#hide(id)}
 async #hide(id:string){this.#state.dismissed=[...new Set([...this.#state.dismissed,id])];await this.#save();this.options.changed()}
 #existing():WorkbenchExisting[]{const life=this.options.life().snapshot(),saved=[...life.ideas,...life.goals].map(row=>({id:row.id,kind:row.kind,title:row.title,note:row.note,status:row.status,version:row.version}));return [...saved,...this.#state.recorded.filter(r=>r.undone&&!saved.some(row=>row.id===r.id)).map(r=>({id:r.id,kind:'goal' as const,title:r.matter.title,note:r.matter.summary,status:'cancelled',version:r.version}))]}
 #matterCurrent(matter:WorkbenchMatter){return !this.#pendingValidation&&this.#grounded(matter.refs)&&validWorkbenchMatter(matter,this.#inputs)}
 #composition(value:unknown){const raw=workbenchCompositionSchema.extend({suggestions:z.array(z.unknown()).max(9)}).parse(value);return {...raw,suggestions:raw.suggestions.flatMap(item=>{const parsed=workbenchCompositionSchema.shape.suggestions.element.safeParse(item);if(parsed.success)return [parsed.data];this.#state.diagnostics.rejected++;return []})}}
 async refresh(automatic=false):Promise<void>{
  if(this.#run)return this.#run
  const work=this.#refresh(automatic);this.#run=work
  try{await work}finally{this.#run=undefined;this.options.changed()}
 }
 async #refresh(automatic:boolean){
  await this.sync();if(!this.#opened||this.#defer||!this.#inputs.length||!this.options.ready()||this.#error==='sources_unavailable'||this.#error==='cache_invalid')return
  if(automatic&&this.#state.automatic_day>=this.#day())return
  const key=this.#key();if(key===this.#state.key){this.#status='ready';return}
  clearTimeout(this.#timer);this.#status='working';this.#error=null;this.#state.failure=null
  // A full run includes bounded extraction, global review and multiple sequential composition batches.
  const cancel=this.#abort.signal,signal=AbortSignal.any([cancel,AbortSignal.timeout(1800000)]),inputs=structuredClone(this.#inputs),day=this.#day(),timezone=this.options.timezone()
  const guard=()=>{signal.throwIfAborted();if(!this.#opened)throw Error('workbench_closed')}
  this.#state.diagnostics={...diagnostics(),inputs:inputs.length}
  try{
   if(automatic){this.#state.automatic_day=day;await this.#save()}
   const caches:State['cache']=[],batches=workbenchBatches(inputs),initialKeys=new Set(this.#state.cache.map(c=>c.key))
   for(const [index,batch] of batches.entries()){
    guard();const cacheKey=workbenchHash([RECIPE,timezone,batch.inputs]),cached=this.#state.cache.find(c=>c.key===cacheKey)
    if(cached){caches.push(cached);if(initialKeys.has(cacheKey))this.#state.diagnostics.cache_hits++;continue}
    await this.sync();guard()
    const combined:typeof batches=[],batchInputs:TimelineInput[]=[];let chars=0
    for(const next of batches.slice(index)){
     if(this.#state.cache.some(c=>c.key===workbenchHash([RECIPE,timezone,next.inputs])))continue
     const length=next.inputs.reduce((sum,input)=>sum+input.text.length,0)
     if(combined.length&&(batchInputs.length+next.inputs.length>60||chars+length>24000))break
     combined.push(next);batchInputs.push(...next.inputs);chars+=length
    }
    const previous=this.#state.cache.filter(c=>combined.some(b=>b.group===c.group)).flatMap(c=>c.matters).filter(m=>this.#grounded(m.refs)).slice(-8)
    this.#state.diagnostics.extraction_calls++
    const result=z.object({matters:z.array(z.unknown()).max(100)}).strict().parse(await this.options.generate({phase:'extract',inputs:batchInputs,previous,date:day,timezone},signal));guard()
    this.#state.diagnostics.received+=result.matters.length
    const matters=result.matters.flatMap(value=>{const parsed=workbenchMatterSchema.safeParse(value);if(!parsed.success){this.#state.diagnostics.rejected++;return []}const raw=parsed.data;if(!validWorkbenchMatter(raw,batchInputs)){this.#state.diagnostics.rejected++;return []}
     const m=raw.kind==='goal'&&raw.due?{...raw,summary:raw.summary.slice(0,370)+'；目标日期：'+raw.due,due:null,due_quote:null}:raw
     return [{...m,id:workbenchHash([m.kind,m.refs[0]!.entry_id,m.refs[0]!.quote,m.title.normalize('NFKC').trim().toLowerCase()]),group:combined.find(b=>b.inputs.some(input=>input.id===m.refs[0]!.entry_id))!.group,observed_at:inputs.filter(input=>m.refs.some(ref=>ref.entry_id===input.id)).map(input=>input.observed_at).sort().at(-1)??''}]
    })
    for(const part of combined){
     const partMatters=matters.filter(m=>part.inputs.some(input=>input.id===m.refs[0]!.entry_id))
     const basis=batchInputs.filter(input=>part.inputs.some(row=>row.id===input.id)||partMatters.some(m=>m.refs.some(ref=>ref.entry_id===input.id))).map(({id,version})=>({id,version}))
     const entry={key:workbenchHash([RECIPE,timezone,part.inputs]),group:part.group,basis,matters:partMatters}
     this.#state.cache=[...this.#state.cache.filter(c=>c.key!==entry.key),entry];if(part===batch)caches.push(entry)
    }
    await this.#save()
   }
   this.#state.cache=caches;await this.#save()
   const extracted=[...new Map(caches.flatMap(c=>c.matters).map(m=>[m.id,m])).values()]
   const temporalKey=workbenchHash([TEMPORAL_RECIPE,timezone,day,extracted])
   let temporal=this.#state.temporal?.key===temporalKey?this.#state.temporal.result:undefined
   if(!temporal){
    this.#state.diagnostics.composition_calls++
    temporal=temporalReplySchema.parse(await this.options.generate({phase:'reconcile',matters:extracted,inputs,date:day,timezone},signal));guard()
   }
   const resolved=resolveWorkbenchGroups(extracted,temporal)
   this.#state.temporal={key:temporalKey,source_key:workbenchHash(inputs.map(i=>[i.id,i.version])),result:temporal};await this.#save()
   const groupFor=new Map(resolved.flatMap(g=>g.members.map(m=>[m.id,g] as const))),capturedGroups=new Set<string>()
   const matters=extracted.map(m=>({...m,state:groupFor.get(m.id)!.state}))
   const cards:State['cards']=[],existing=this.#existing()
   const groups=new Map(resolved.map(g=>[g.id,matters.filter(m=>groupFor.get(m.id)!.id===g.id)]))
   const incomplete=new Set([...groups.values()].filter(group=>group.length>60||JSON.stringify(group).length>24000).flatMap(group=>group.map(m=>m.id)))
   const packs:WorkbenchMatter[][]=[];let pack:WorkbenchMatter[]=[],size=0
   for(const group of groups.values()){if(pack.length&&(pack.length+group.length>60||size+JSON.stringify(group).length>24000)){packs.push(pack);pack=[];size=0}for(const matter of group){const length=JSON.stringify(matter).length;if(pack.length&&(pack.length===60||size+length>24000)){packs.push(pack);pack=[];size=0}pack.push(matter);size+=length}}if(pack.length)packs.push(pack)
   let batchFailure:unknown
   for(const batch of packs){
    try{
    await this.sync();guard();const candidates=workbenchExistingCandidates(batch,existing),compositionKey=workbenchHash([RECIPE,TEMPORAL_RECIPE,temporalKey,timezone,batch,candidates,batch.filter(m=>m.due).map(m=>[m.id,m.due!<day])])
    const cachedComposition=this.#state.compositions.find(c=>c.key===compositionKey)?.result
    let result:z.infer<typeof workbenchCompositionSchema>
    if(cachedComposition)result=structuredClone(cachedComposition)
    else{this.#state.diagnostics.composition_calls++;result=this.#composition(await this.options.generate({phase:'compose',matters:batch,existing:candidates,date:day,timezone},signal));guard()}
    const pending=batch.filter(m=>m.kind!=='topic'),ids=new Set<string>()
    // Topic rows cannot authorize writes; tolerate models returning these extra matches.
    result.matches=result.matches.filter(match=>!batch.some(m=>m.kind==='topic'&&m.id===match.matter_id))
    if(result.matches.length!==pending.length)invalidMatches('count')
    for(const match of result.matches){
     const matter=pending.find(m=>m.id===match.matter_id)
     if(!matter)invalidMatches('unknown_matter')
     if(ids.has(match.matter_id))invalidMatches('duplicate_matter')
     ids.add(match.matter_id)
     if(match.target_id!==null&&!candidates.some(c=>c.id===match.target_id&&c.kind===matter.kind))invalidMatches('invalid_target')
     if(match.same_as!==null&&(!pending.some(m=>m.id===match.same_as&&m.kind===matter.kind)||match.same_as===matter.id||result.matches.some(other=>other.matter_id===match.same_as&&other.same_as!==null)))invalidMatches('invalid_same_as')
    }
    this.#state.compositions=[...this.#state.compositions.filter(c=>c.key!==compositionKey),{key:compositionKey,result}].slice(-256);await this.#save()
    result=structuredClone(result)
    // A lexical shortlist cannot prove absence. Check the remaining compact records before any automatic add.
    const unresolved=result.matches.filter(match=>match.capture==='record'&&match.target_id===null&&match.same_as===null&&!incomplete.has(match.matter_id)).map(match=>pending.find(m=>m.id===match.matter_id)!).filter(m=>automaticWorkbenchMatter(m,this.#inputs))
    const omitted=existing.filter(row=>!candidates.some(c=>c.id===row.id)&&unresolved.some(m=>m.kind===row.kind)).map(row=>({...row,note:row.note.slice(0,300)}))
    for(let offset=0;offset<omitted.length&&unresolved.length;offset+=40){
     await this.sync();guard();const shard=omitted.slice(offset,offset+40),identityKey=workbenchHash([RECIPE,'identity',unresolved,shard])
     let checked=this.#state.compositions.find(c=>c.key===identityKey)?.result
     if(!checked){this.#state.diagnostics.composition_calls++;checked=this.#composition(await this.options.generate({phase:'compose',identity_only:true,matters:unresolved,existing:shard,date:day,timezone},signal));guard()}
     if(checked.matches.length!==unresolved.length||new Set(checked.matches.map(m=>m.matter_id)).size!==unresolved.length||checked.matches.some(m=>!unresolved.some(item=>item.id===m.matter_id)||m.target_id!==null&&!shard.some(row=>row.id===m.target_id&&row.kind===unresolved.find(item=>item.id===m.matter_id)!.kind)))throw Error('invalid_workbench_matches')
     this.#state.compositions=[...this.#state.compositions.filter(c=>c.key!==identityKey),{key:identityKey,result:checked}].slice(-256);await this.#save()
     for(const match of checked.matches)if(match.target_id!==null){result.matches.find(m=>m.matter_id===match.matter_id)!.target_id=match.target_id;unresolved.splice(unresolved.findIndex(m=>m.id===match.matter_id),1)}
    }
    await this.sync();guard()
    for(const match of result.matches){
     guard()
     const matter=pending.find(m=>m.id===match.matter_id)!
     const temporalGroup=groupFor.get(matter.id)!
     const target=existing.find(row=>row.id===match.target_id&&row.kind===matter.kind)
     const targetIds=new Set(result.matches.filter(m=>m.target_id!==null&&groupFor.get(m.matter_id)?.id===temporalGroup.id).map(m=>m.target_id))
     if(target&&targetIds.size===1&&matter.kind!=='topic'&&(matter.state==='completed'||matter.state==='cancelled')&&!['done','completed','cancelled','archived'].includes(target.status)&&!this.#state.recorded.some(r=>r.id===target.id&&r.undone)){
      const refs=[...new Map(temporalGroup.basis.flatMap(m=>m.refs).map(ref=>[ref.entry_id,ref])).values()]
      if(refs.length<=8&&refs.length&&refs.every(ref=>this.#grounded([ref]))){
       const status=matter.state==='completed'?'completed':'archived'
       const id=workbenchHash(['status-update',target.id,target.version,status,refs])
       if(!cards.some(card=>card.id===id))cards.push({id,candidate_id:id,tab:'goals',title:target.title.slice(0,80),body: matter.state==='completed'?'后续资料显示这件事已完成，可以更新原记录。':'后续资料显示这件事已取消，可以更新原记录。',why:null,next:null,refs,sources:this.sourcesForRefs(refs),update:{id:target.id,kind:matter.kind,version:target.version,status}})
      }
     }
     if(match.capture!=='record'||match.target_id!==null||match.same_as!==null||incomplete.has(matter.id)||capturedGroups.has(temporalGroup.id)||!automaticWorkbenchMatter(matter,this.#inputs)||!this.#matterCurrent(matter)||this.#state.recorded.some(r=>r.matter.id===matter.id))continue
     await this.sync();guard();if(!this.#matterCurrent(matter))continue
     const life=this.options.life();await life.refresh();guard()
     // A concurrent edit invalidates the identity decision, rather than silently using stale context.
     if(workbenchHash(this.#existing())!==workbenchHash(existing))throw Error('workbench_records_changed')
     const check=()=>{guard();if(!this.#matterCurrent(matter))throw Error('candidate_stale_source')}
     const recovered=life.snapshot().goals.find(row=>row.workbench_source?.candidate_id===matter.id)
     const saved=recovered??await life.mutate({op:'from_workbench',kind:matter.kind,title:matter.title,note:matter.summary,due:null,success_criteria:'',automatic:true,source:{candidate_id:matter.id,refs:matter.refs},proof:workbenchMatterSchema.parse(Object.fromEntries(Object.entries(matter).filter(([key])=>!['id','group','observed_at'].includes(key)))),evidence:this.#inputs.filter(input=>matter.refs.some(ref=>ref.entry_id===input.id)),sources:this.sourcesForRefs(matter.refs)},'workbench:'+matter.id,check)
     this.#state.recorded.push({matter:{id:matter.id,kind:matter.kind,title:matter.title,summary:matter.summary},id:saved.id,version:saved.version,undone:false});await this.#save();this.#state.diagnostics.recorded++
     capturedGroups.add(temporalGroup.id)
     existing.splice(0,existing.length,...this.#existing())
     // Persisting an inferred Life object may notify the host of a source change.
     // Recheck it before judging subsequent records or suggestions from this batch.
     if(this.#pendingValidation){await this.sync();guard()}
    }
    for(const suggestion of result.suggestions){
     const basis=suggestion.matter_ids.map(id=>batch.find(m=>m.id===id))
     if(basis.some(m=>!m||!this.#matterCurrent(m))||workbenchSensitive(JSON.stringify(suggestion))){this.#state.diagnostics.rejected++;continue}
     if(suggestion.tab!=='ideas'&&basis.some(m=>m!.state!=='open'||capturedGroups.has(groupFor.get(m!.id)!.id)||this.#state.recorded.some(r=>r.matter.id===m!.id)||result.matches.some(match=>match.matter_id===m!.id&&(match.target_id!==null||match.same_as!==null||match.capture!=='suggest')))){this.#state.diagnostics.rejected++;continue}
     const refs=[...new Map(basis.flatMap(m=>m!.refs).map(ref=>[ref.entry_id,ref])).values()]
     if(refs.length>8||unresolvedWorkbenchReference({...suggestion,refs})){this.#state.diagnostics.rejected++;continue}
     if(this.#state.legacy_dismissed.some(old=>old.tab===suggestion.tab&&old.refs.every(ref=>refs.some(current=>current.entry_id===ref.entry_id))))continue
     const id=workbenchHash([TEMPORAL_RECIPE,suggestion.tab,[...new Set(suggestion.matter_ids.map(id=>groupFor.get(id)!.id))].sort()])
     if(cards.some(card=>card.id===id))continue
     cards.push({id,candidate_id:id,tab:suggestion.tab,title:suggestion.title,body:suggestion.body,why:suggestion.why,next:suggestion.next,refs,sources:this.sourcesForRefs(refs)})
    }
    // Keep validated batches visible if a later model call fails.
    this.#state.cards=cards.filter((card,index)=>Boolean(card.update)||cards.slice(0,index).filter(c=>c.tab===card.tab&&!c.update).length<3);await this.#save();this.options.changed()
    }catch(error){signal.throwIfAborted();if(error instanceof Error&&error.message==='workbench_records_changed')throw error;batchFailure=error}
   }
   if(batchFailure)throw batchFailure instanceof Error?batchFailure:Error('generation_failed')
   guard();this.#state.cards=cards.filter((card,index)=>Boolean(card.update)||cards.slice(0,index).filter(c=>c.tab===card.tab&&!c.update).length<3);this.#state.key=this.#key(inputs);this.#state.updated_at=this.#now().toISOString();await this.#save();this.#status='ready'
  }catch(error){this.#status='failed';this.#error=cancel.aborted?'sources_changed':error instanceof Error&&['invalid_workbench_matches','workbench_records_changed'].includes(error.message)?error.message:'generation_failed';this.#state.failure=error instanceof z.ZodError?error.issues.map(issue=>issue.path.join('.')+':'+issue.code).join(',').slice(0,1000):error instanceof Error&&'classification' in error&&typeof error.classification==='string'&&/^[a-zA-Z0-9_]{1,80}$/u.test(error.classification)?error.classification:error instanceof Error&&error.name==='TimeoutError'?'generation_timeout':error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]+$/u.test(error.code)?error.code:error instanceof Error&&/^[a-zA-Z0-9_.:-]{1,160}$/u.test(error.message)?error.message:this.#error;await this.#save().catch(()=>undefined)}
 }
 async adopt(id:string){const original=this.#state.cards.find(c=>c.id===id);if(!original)throw Error('card_not_found');await this.sync();await this.options.life().refresh();const card=this.snapshot().cards.find(c=>c.id===id);if(!card)throw Error(original.update?'version_conflict':'candidate_stale_source');if(workbenchHash(card)!==workbenchHash({...original,refs:original.refs.map(ref=>({...ref,label:ref.quote}))}))throw Error('candidate_stale_source');if(!this.#grounded(card.refs)||card.tab!=='ideas'&&!this.#temporalCurrent())throw Error('candidate_stale_source')
  if(card.update){
   const update=card.update,life=this.options.life();await life.refresh()
   const result=await life.mutate({op:'update',kind:update.kind,id:update.id,expected_version:update.version,status:update.status},'workbench-update:'+card.id,()=>{if(!this.#grounded(card.refs)||card.tab!=='ideas'&&!this.#temporalCurrent())throw Error('candidate_stale_source')})
   await this.#hide(id);return result
  }
  const result=await this.options.life().mutate({op:'from_workbench',kind:card.tab==='ideas'?'idea':'goal',title:card.title,note:[card.body,card.next].filter(Boolean).join('\n'),due:null,success_criteria:card.tab==='goals'?card.body:'',automatic:false,source:{candidate_id:card.id,refs:card.refs.map(({entry_id,version,quote})=>({entry_id,version:String(version),quote}))},sources:card.sources,evidence:this.#inputs.filter(input=>card.refs.some(ref=>ref.entry_id===input.id))},'workbench-adopt:'+card.id,()=>{if(!this.#grounded(card.refs)||card.tab!=='ideas'&&!this.#temporalCurrent())throw Error('candidate_stale_source')});await this.#hide(id);return result
 }
 async undo(id:string){const record=this.#state.recorded.find(r=>r.id===id);if(!record)throw Error('record_not_found')
  const life=this.options.life();await life.refresh();const item=life.snapshot().goals.find(r=>r.id===id);if(item?.version!==1)throw Error('version_conflict')
  // Persist suppression before removal so a crash cannot recreate an undone automatic record.
  record.undone=true;await this.#save();await life.mutate({op:'undo_create',id,kind:record.matter.kind,expected_version:1},'workbench-undo:'+id);this.options.changed()
 }
 sourceChanged(refs:readonly {entry_id:string;version:string|number}[]){return !this.#grounded(refs)}
 async clear(){await this.close();this.#state={...empty(),legacy_imported:true,legacy_dismissed:this.#state.legacy_dismissed,dismissed:this.#state.dismissed,automatic_day:this.#state.automatic_day,recorded:this.#state.recorded};this.#inputs=[];await this.#save();this.#opened=true;this.#abort=new AbortController()}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#sync;await this.#tail}
}
