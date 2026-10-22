import {selectTimelineInputs} from './timeline-inputs.js'
import {temporalSchema,resolvedTimeSchema,resolveTimelineTime} from './timeline-time.js'
import {SensitiveContentPolicy} from '../memory/sensitivity.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {abortable} from '../core/camera-session.js'
import {sourceTagSchema,type SourceTag} from '../memory/provenance.js'

export interface TimelineAccess {scope:string;allowed:boolean;legacy_refs:readonly string[]}
export interface TimelineInput {account_scope?:string;history_only?:boolean;id:string;version:string;kind:string;text:string;observed_at:string;group?:string;evidence_refs?:string[];relation?:'self'|'addressed'|'participant'|'system';source?:SourceTag;author?:{key:string;name?:string;kind:'person'|'system'|'unknown';is_user:boolean}}
export const TIMELINE_MAX_REFS=16
const ref=z.string().min(1).max(600)
export const timelineReplySchema=z.object({cards:z.array(z.object({
 temporal:temporalSchema.default({kind:'unknown',dates:[]}),
 kind:z.enum(['attention','deadline','progress','insight']).default('insight'),status_label:z.string().trim().max(18).default(''),
 people:z.array(z.object({name:z.string().trim().min(1).max(60),quote:z.string().min(1).max(600),ref}).strict()).max(8).default([]),
 category:z.string().trim().min(1).max(40),title:z.string().trim().min(1).max(96),why_now:z.string().trim().min(1).max(160),
 facts:z.array(z.object({label:z.string().trim().max(32).default(''),tone:z.enum(['neutral','risk','warning','positive']).default('neutral'),text:z.string().trim().min(1).max(160),quote:z.string().min(1).max(600),ref}).strict()).min(1).max(3),
 next_steps:z.array(z.object({title:z.string().trim().min(1).max(40),detail:z.string().trim().min(1).max(100)}).strict()).max(3).default([]),
 uncertainty:z.string().max(160),actions:z.array(z.object({label:z.string().trim().min(1).max(40),kind:z.enum(['discuss','draft'])}).strict()).max(2),refs:z.array(ref).min(1).max(TIMELINE_MAX_REFS),
}).strict())}).strict()
/** Names are presentation hints, not inferred assignments or authority. */
export function groundedTimelinePeople(card:z.infer<typeof timelineReplySchema>['cards'][number],inputs:ReadonlyMap<string,TimelineInput>){
 const cited=new Set([...card.refs,...card.facts.map(fact=>fact.ref)]),seen=new Set<string>()
 const prose=[card.title,...card.facts.map(fact=>fact.text)].join('\n')
 return card.people.filter(person=>{
  const input=inputs.get(person.ref),namedAuthor=input?.author?.kind==='person'&&!input.author.is_user&&input.author.name===person.name
  if(!cited.has(person.ref)||!input?.text.includes(person.quote)||!person.quote.includes(person.name)&&!namedAuthor||!prose.includes(person.name)||seen.has(person.name))return false
  seen.add(person.name);return true
 })
}
const count=z.number().int().nonnegative()
export const timelineDiagnosticsSchema=z.object({
 input_count:count,selected_inputs:count,screened_topics:count,composition_batches:count,
 pending_batches:count.default(0),
 failed_batches:z.array(z.object({batch:count,reason:z.string()})).default([]),
 stages:z.array(z.object({batch:count,phase:z.enum(['compose','review']),received:count,accepted:count,dropped:z.record(z.string(),count)})),
 host_received:count.default(0),published:count.default(0),host_dropped:z.record(z.string(),count).default({}),
})
export type TimelineDiagnostics=z.infer<typeof timelineDiagnosticsSchema>
export type TimelineGenerated=z.input<typeof timelineReplySchema>&{diagnostics?:TimelineDiagnostics}
export interface TimelineContext {local_date:string;timezone:string;viewer_names?:string[]}
export type TimelineGenerator=(inputs:readonly TimelineInput[],context:TimelineContext,signal:AbortSignal,progress?:(result:TimelineGenerated)=>Promise<void>)=>Promise<TimelineGenerated>
const cardSchema=timelineReplySchema.shape.cards.element.extend({id:z.string(),version:z.string(),timezone:z.string().optional(),artifact_scope:z.string().optional(),evidence_basis:z.array(z.object({id:ref,version:z.string()})).optional(),policy_revision:z.number().int().optional(),sources:z.array(sourceTagSchema),time:resolvedTimeSchema})
const failureSchema=z.object({name:z.string(),code:z.string(),issues:z.array(z.object({code:z.string(),path:z.array(z.union([z.string(),z.number()])),maximum:z.number().optional()})).optional()})
const stateSchema=z.object({diagnostics:timelineDiagnosticsSchema.nullable().default(null),failure:failureSchema.nullable().default(null),version:z.literal(1),perspective_revision:z.number().int().default(0),key:z.string(),local_date:z.string(),timezone:z.string().nullable().default(null),basis:z.array(z.object({id:ref,version:z.string()})),cards:z.array(cardSchema),updated_at:z.string().nullable(),last_attempt:z.number(),dismissed:z.array(z.string()).max(256)})
type State=z.infer<typeof stateSchema>
const empty=():State=>({diagnostics:null,failure:null,version:1,perspective_revision:1,key:'',local_date:'',timezone:null,basis:[],cards:[],updated_at:null,last_attempt:0,dismissed:[]})
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scrubber=new SensitiveContentPolicy()
const sensitive=(text:string)=>scrubber.scrub('timeline',text).kind!=='clean'

/** Read-only derived attention cards. This owns no task execution or Life mutation authority. */
export class TimelineBrief {
 #persisted:State=empty()
 #loadFailed=false
 get loadFailed(){return this.#loadFailed}
 #access:TimelineAccess|undefined;#pendingValidation=false;#tail:Promise<void>=Promise.resolve();#defer=true;#store:BoundedJsonStore<State>;#state=empty();#inputs:TimelineInput[]=[];#date='';#timezone='UTC';#status='idle';#error:string|null=null;#opened=false;#timer:ReturnType<typeof setTimeout>|undefined;#abort=new AbortController();#run:Promise<void>|undefined
 constructor(path:string,readonly generate:TimelineGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,stateSchema)}
 async open(){this.#loadFailed=false;try{this.#state=await this.#store.read(empty());if(this.#state.timezone)for(const card of this.#state.cards)card.timezone??=this.#state.timezone}catch(error){if(!(error instanceof z.ZodError)&&!(error instanceof SyntaxError))throw error;this.#loadFailed=true;this.#state=empty()}this.#persisted=structuredClone(this.#state);this.#access=undefined;this.#inputs=[];this.#date='';this.#status='idle';this.#defer=true;this.#opened=true;this.#abort=new AbortController()}
 startGeneration(){this.#defer=false;this.#schedule()}
 #save(){const state=structuredClone(this.#state);const run=this.#tail.then(async()=>{await this.#store.write(state);this.#persisted=state});this.#tail=run.catch(()=>undefined);return run}
 /** IDs only: each cached citation must be re-read under current source permissions. */
 retainedEvidenceIds(){return [...new Set(this.#state.cards.filter(card=>!this.#dismissed(card)).flatMap(card=>card.refs))]}
 basis(id?:string){return structuredClone([...new Map(this.#visibleCards().filter(card=>(!id||card.id===id)&&this.#sourcesAvailable(card)).flatMap(card=>(card.evidence_basis??this.#state.basis).filter(input=>card.refs.includes(input.id))).map(input=>[input.id,input])).values()])}
 async clear(){this.#abort.abort();await this.#run;this.#abort=new AbortController();this.#state=empty();this.#inputs=[];await this.#save();this.#loadFailed=false;this.changed()}
 suspend(){this.#pendingValidation=true;this.changed()}
 invalidate(){this.update([],this.#date,this.#timezone,this.#access?{...this.#access,legacy_refs:[]}:{scope:'local',allowed:true,legacy_refs:[]})}
 unavailable(){this.invalidate();this.#status='failed';this.#error='timeline_sources_unavailable';this.changed()}
 #key(){return hash(['timeline-scope-v15',this.#date,this.#timezone,this.#inputs.map(({id,version})=>({id,version}))])}
 #compatible(basis:readonly {id:string;version:string}[],date:string,timezone:string|null){
  if(date!==this.#date||timezone!==this.#timezone)return false
  const versions=new Map(this.#inputs.map(input=>[input.id,input.version]))
  return basis.every(input=>versions.get(input.id)===input.version)
 }
 setAccess(access:TimelineAccess){
  if(this.#access?.scope!==access.scope||!access.allowed){this.#abort.abort();this.#abort=new AbortController();this.#inputs=[]}
  this.#access={...access,legacy_refs:[...access.legacy_refs]}
 }
 #dismissed(card:State['cards'][number],state=this.#state){return state.dismissed.includes(`${card.artifact_scope??''}:${card.id}`)||!card.artifact_scope&&state.dismissed.includes(card.id)}
 #sourcesAvailable(card:State['cards'][number],state=this.#state){
  if(this.#pendingValidation)return false
  const versions=new Map(this.#inputs.map(input=>[input.id,input.version])),basis=new Map((card.evidence_basis??state.basis).map(input=>[input.id,input.version]))
  return card.refs.every(ref=>versions.has(ref)&&versions.get(ref)===basis.get(ref))
 }
 #visibleCards(state=this.#state){
  if(!this.#access?.allowed)return []
  return state.cards.filter(card=>card.artifact_scope===this.#access!.scope&&!this.#dismissed(card,state))
 }
 #current(state=this.#state){return this.#visibleCards(state).length>0||state.perspective_revision===1&&!this.#pendingValidation&&state.key===this.#key()}
 snapshot(persisted=false){const state=persisted?this.#persisted:this.#state;const counts={messages:0,files:0,memories:0},dates:string[]=[];for(const input of this.#inputs){if(input.kind==='file')counts.files++;else if(input.kind==='memory')counts.memories++;else{counts.messages++;if(Number.isFinite(Date.parse(input.observed_at)))dates.push(new Date(input.observed_at).toLocaleDateString('en-CA',{timeZone:this.#timezone}))}}dates.sort();return {generation_id:this.#current(state)?state.key:null,diagnostics:this.#current(state)?structuredClone(state.diagnostics):null,available:!!this.generate,status:this.#status,error:this.#error,updated_at:this.#current(state)?state.updated_at:null,input_count:this.#inputs.length,coverage:`本轮资料：${counts.messages} 条消息 · ${counts.files} 份文档 · ${counts.memories} 条个人记录${dates.length?'；消息记录 '+dates[0]+'—'+dates.at(-1):''}`,cards:structuredClone(this.#visibleCards(state).map(card=>({...card,sources_available:this.#sourcesAvailable(card,state),sources_checking:this.#pendingValidation,historical:card.policy_revision!==1||!this.#sourcesAvailable(card,state)})))}}
 update(inputs:readonly TimelineInput[],date:string,timezone:string,access:TimelineAccess={scope:'local',allowed:true,legacy_refs:inputs.map(input=>input.id)}){
  this.setAccess(access)
  const old=this.#key(),previous=this.#inputs,previousDate=this.#date,previousZone=this.#timezone,pending=this.#pendingValidation;this.#pendingValidation=false;const eligible=inputs.filter(input=>input.text.trim()&&!sensitive(input.text)),selected=selectTimelineInputs(eligible.filter(input=>!input.history_only)),selectedIds=new Set(selected.map(input=>input.id)),retained=new Set(this.retainedEvidenceIds());this.#inputs=[...selected,...eligible.filter(input=>retained.has(input.id)&&!selectedIds.has(input.id))];this.#date=date;this.#timezone=timezone
  if(old!==this.#key()){const additionsOnly=previous.length>0&&this.#compatible(previous,previousDate,previousZone);if(!additionsOnly){this.#abort.abort();this.#abort=new AbortController()}this.#error=null;this.#status=this.#run&&additionsOnly?'working':this.#current()?'ready':this.#inputs.length?'queued':'idle';this.changed()}
  else if(pending){if(this.#current())this.#status=this.#run?'working':'ready';this.changed()}
  // Bind legacy output only while every original reference can still prove its scope.
  const safe=new Set(access.legacy_refs);let migrated=false
  for(const card of this.#state.cards)if(!card.artifact_scope&&card.refs.every(id=>safe.has(id))&&this.#sourcesAvailable(card)){
   if(this.#state.dismissed.includes(card.id))this.#state.dismissed=this.#state.dismissed.map(id=>id===card.id?`${access.scope}:${id}`:id)
   card.artifact_scope=access.scope;card.evidence_basis=this.#state.basis.filter(input=>card.refs.includes(input.id));card.policy_revision=this.#state.perspective_revision;migrated=true
  }
  if(migrated){if(this.#visibleCards().length&&!this.#run)this.#status='ready';void this.#save().catch(()=>undefined);this.changed()}
  this.#schedule()
 }
 #schedule(){
  clearTimeout(this.#timer);this.#timer=undefined
  if(!this.#access?.allowed||this.#pendingValidation||this.#defer||!this.#opened||!this.generate||this.#run||!this.#inputs.some(input=>!input.history_only)||this.#key()===this.#state.key&&this.#state.perspective_revision===1)return
  this.#timer=setTimeout(()=>{this.#timer=undefined;void this.refresh()},Math.max(1000,this.#state.last_attempt+300000-Date.now()));this.#timer.unref()
 }
 async refresh(){
  if(this.#run)return this.#run
  if(!this.#access?.allowed||this.#pendingValidation||!this.#opened||!this.generate||!this.#inputs.some(input=>!input.history_only))return
  clearTimeout(this.#timer);this.#timer=undefined
  const key=this.#key(),inputs=structuredClone(selectTimelineInputs(this.#inputs.filter(input=>!input.history_only)).map(source=>{const input={...source};delete input.account_scope;return input})),context={local_date:this.#date,timezone:this.#timezone},cancel=this.#abort.signal,timeout=AbortSignal.timeout(600000),signal=AbortSignal.any([cancel,timeout])
  this.#status='working';this.#error=null;this.changed()
  const publish=async(generated:TimelineGenerated,done:boolean)=>{
   if(signal.aborted||!this.#compatible(inputs,context.local_date,context.timezone)||!this.#opened)return
   const result=timelineReplySchema.parse({cards:generated.cards});
   const diagnostics=timelineDiagnosticsSchema.parse(generated.diagnostics??{input_count:inputs.length,selected_inputs:inputs.length,screened_topics:0,composition_batches:1,stages:[]})
   diagnostics.host_received=result.cards.length;diagnostics.host_dropped={}
   const drop=(reason:string)=>{diagnostics.host_dropped[reason]=(diagnostics.host_dropped[reason]??0)+1;return []}
   const byId=new Map(inputs.map(input=>[input.id,input])),seen=new Set<string>()
   const cards=result.cards.flatMap(raw=>{
    const card={...raw,people:groundedTimelinePeople(raw,byId)}
    const refs=[...new Set([...card.refs,...card.facts.map(fact=>fact.ref),...card.temporal.dates.map(date=>date.ref)])]
    if(refs.length>TIMELINE_MAX_REFS)return drop('reference_limit')
    if(refs.some(id=>!byId.has(id)))return drop('unknown_reference')
    if(card.facts.some(fact=>!byId.get(fact.ref)!.text.includes(fact.quote)))return drop('unsupported_quote')
    if(sensitive(JSON.stringify(card)))return drop('sensitive_content')
    const time=resolveTimelineTime(card.temporal,refs.map(id=>byId.get(id)!),context);if(!time)return drop('invalid_time_or_background')
    const recentSince=new Date(Date.parse(context.local_date+'T00:00:00Z')-14*86400000).toISOString().slice(0,10)
    if(time.anchor_date&&time.anchor_date<recentSince&&(!time.last_reported_on||time.last_reported_on<recentSince)&&(!time.due_on||time.due_on<recentSince)&&(!time.scheduled_on||time.scheduled_on<recentSince))return drop('outside_window')
    const id=hash([card.title,refs.sort()]);if(seen.has(id))return drop('duplicate');seen.add(id)
    const sources=refs.flatMap(id=>{const source=byId.get(id)!.source;return source?[{...source,summary:card.facts.filter(fact=>fact.ref===id).map(fact=>fact.quote).join('\n').slice(0,700)||source.summary}]:[]})
    return [{...card,time,timezone:context.timezone,artifact_scope:this.#access!.scope,evidence_basis:refs.map(id=>({id,version:byId.get(id)!.version})),policy_revision:1,refs,id,version:hash([card,refs.map(id=>byId.get(id)!.version)]),sources}]
   })
   // A new synthesis updates matching cards; omission is not a withdrawal.
   const merged=new Map(this.#state.cards.map(card=>[`${card.artifact_scope??''}:${card.id}`,card]))
   for(const card of cards)merged.set(`${card.artifact_scope}:${card.id}`,card)
   const retainedCards=[...merged.values()]
   diagnostics.published=cards.length
   this.#state={...this.#state,perspective_revision:1,diagnostics,failure:null,key,local_date:context.local_date,timezone:context.timezone,basis:this.#inputs.map(({id,version})=>({id,version})),cards:retainedCards,updated_at:new Date().toISOString()};await this.#save();this.#loadFailed=false;if(done)this.#status='ready';this.changed()
  }
  const work=(async()=>{try{
   this.#state.last_attempt=Date.now();this.#state.failure=null;await this.#save();signal.throwIfAborted()
   const generated=await abortable(this.generate!(inputs,context,signal,result=>publish(result,false)),signal)
   signal.throwIfAborted();await publish(generated,true)
  }catch(error){if(!cancel.aborted){if(error instanceof Error&&'diagnostics' in error){const parsed=timelineDiagnosticsSchema.safeParse(error.diagnostics);if(parsed.success)this.#state.diagnostics=parsed.data}this.#state.failure={name:error instanceof Error?error.name:'unknown',code:error instanceof Error&&['invalid_timeline_evidence','invalid_timeline_selection','timeline_batches_failed','processing_consent_required'].includes(error.message)?error.message:error instanceof Error&&'classification' in error&&typeof error.classification==='string'?error.classification:'unavailable',...(error instanceof z.ZodError?{issues:error.issues.map(issue=>({code:issue.code,path:issue.path.map(part=>typeof part==='number'?part:String(part)),...('maximum' in issue&&typeof issue.maximum==='number'?{maximum:issue.maximum}:{})}))}:{})};await this.#save().catch(()=>undefined)}if(cancel.aborted){this.#status=this.#inputs.length?'queued':'idle';this.#error=null;this.#state.last_attempt=0}else{this.#status='failed';this.#error=timeout.aborted?'timeline_generation_timeout':'timeline_generation_failed'}}finally{this.#run=undefined;this.changed();this.#schedule()}})()
  this.#run=work;await work
 }
 async dismiss(id:string){if(!this.snapshot().cards.some(card=>card.id===id))throw Error('stale_reference');this.#state.dismissed=[...new Set([...this.#state.dismissed,`${this.#access!.scope}:${id}`])].slice(-256);await this.#save();this.#loadFailed=false;this.changed()}
 discussion(id:string,version:string){const card=this.snapshot().cards.find(card=>card.id===id&&card.version===version);if(!card||!this.#sourcesAvailable(card)||card.policy_revision!==1)throw Error('stale_reference');return {card,evidence_refs:[...new Set(card.refs.flatMap(ref=>{const input=this.#inputs.find(input=>input.id===ref)!;return input.kind==='file'?[]:input.evidence_refs??[ref]}))],originals:card.refs.map(ref=>{const input=this.#inputs.find(input=>input.id===ref)!;return {text:input.text,observed_at:input.observed_at,relation:input.relation,author:input.author}})}}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#timer=undefined;this.#abort.abort();await this.#run;await this.#tail}
}
