import type {LifeSyncClient} from '../hub/life-sync.js'
import {sourceTagSchema} from '../memory/provenance.js'
import type {TaskRecord} from './tasks.js'
import {z} from 'zod'
import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {open} from 'node:fs/promises'
import type {LifeResolution} from '../memory-substrate/resolution.js'
import type {EvaluatedCandidate} from '../understanding/candidates.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {automaticWorkbenchMatter,workbenchMatterSchema,workbenchEvidenceSchema,workbenchRefSchema} from './workbench-evidence.js'
export const newsArticleSchema=z.object({article_id:z.string().min(1).max(512),source_id:z.string().min(1).max(256),url:z.string().url().max(4096).refine(value=>['https:','http:'].includes(new URL(value).protocol),'news_web_url_required'),content_hash:z.string().min(1).max(256),title:z.string().max(300),summary:z.string().max(1500),published_at:z.string().nullable()}).strict()
const newsSourceSchema=newsArticleSchema.extend({action:z.literal('user_conversion'),converted_at:z.string().datetime()})
const importanceSchema=z.enum(['normal','high'])
const contextSourceSchema=z.object({candidate_id:z.string().min(1).max(128),refs:z.array(z.object({entry_id:z.string().min(1).max(600),version:z.union([z.string(),z.number()])}).strict()).min(1).max(8)}).strict()
const workbenchSourceSchema=z.object({candidate_id:z.string().min(1).max(128),refs:z.array(workbenchRefSchema).min(1).max(8)}).strict()
const fields={source_suggestion_id:z.string().max(128).optional(),suggestion_source:workbenchSourceSchema.optional(),workbench_source:contextSourceSchema.extend({refs:z.array(workbenchRefSchema.extend({quote:z.string().min(1).max(600).optional()})).min(1).max(8)}).optional(),context_source:contextSourceSchema.optional(),importance:importanceSchema.optional(),sources:z.array(sourceTagSchema).max(256).optional(),provenance_refs:z.array(z.string().max(600)).max(256).optional(),auto_recorded:z.boolean().optional(),source_changed:z.boolean().optional(),news_source:newsSourceSchema.optional(),id:z.string(),version:z.number().int().nonnegative(),title:z.string().trim().min(1).max(200),note:z.string().max(4000),created_at:z.string(),updated_at:z.string()}
const todoSchema=z.object({...fields,status:z.enum(['open','doing','waiting','done','cancelled']),due:z.string().date().nullable(),goal_id:z.string().nullable(),idea_id:z.string().nullable()})
const ideaSchema=z.object({...fields,status:z.enum(['active','archived']),goal_id:z.string().nullable()})
const goalSchema=z.object({...fields,status:z.enum(['active','paused','completed','archived']),success_criteria:z.string().max(2000),idea_id:z.string().nullable()})
export const lifeStateSchema=z.object({todos:z.array(todoSchema).max(1000),ideas:z.array(ideaSchema).max(1000),goals:z.array(goalSchema).max(200),profile:z.object({about:z.string().max(5000),version:z.number().int().nonnegative()}),receipts:z.record(z.string(),z.object({hash:z.string(),result:z.object({id:z.string(),version:z.number()})}))})
export type LifeState=z.infer<typeof lifeStateSchema>
export interface LifeProvenance {type:'accepted_candidate'|'explicit_candidate';row:EvaluatedCandidate;resolution?:LifeResolution}
export interface LifeSnapshot {state:LifeState;revision:number}
export interface LifeBackend {
 applySyncProjection?(value:{projection:unknown;requestId:string;expectedRevision:number}):Promise<LifeSnapshot>
 peek?():Promise<LifeSnapshot|null>
 load(legacy:LifeState,options?:{legacyPath?:string}):Promise<LifeSnapshot>
 mutate(value:{input:unknown;requestId:string;expectedRevision:number;provenance?:LifeProvenance}):Promise<LifeSnapshot&{result:{id:string;version:number}}>
}
export type LifeBackendSource=LifeBackend|(()=>LifeBackend|undefined)
export const emptyLifeState=():LifeState=>({todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}})
const kind=z.enum(['todo','idea','goal'])
export const lifeInputSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('from_workbench'),kind,title:z.string().trim().min(1).max(200),note:z.string().max(4000),due:z.string().date().nullable(),success_criteria:z.string().max(2000),automatic:z.boolean(),source:workbenchSourceSchema,sources:z.array(sourceTagSchema).max(8),proof:workbenchMatterSchema.optional(),evidence:z.array(workbenchEvidenceSchema).min(1).max(8)}).strict(),
 z.object({op:z.literal('from_context'),title:z.string().trim().min(1).max(200),note:z.string().max(4000),source:contextSourceSchema}).strict(),
 z.object({op:z.literal('from_suggestion'),source:workbenchSourceSchema.optional(),kind:kind.default('todo'),suggestion_id:z.string().min(1).max(128),title:z.string().min(1).max(200),note:z.string().max(4000),due:z.string().date().nullable(),todo_id:z.string().nullable(),sources:z.array(sourceTagSchema).max(64),provenance_refs:z.array(z.string()).min(1).max(64)}).strict(),
 z.object({op:z.literal('from_news'),kind,title:z.string().trim().min(1).max(200),note:z.string().max(4000).default(''),article:newsArticleSchema}).strict(),
 z.object({op:z.literal('create'),kind,importance:importanceSchema.optional(),title:z.string().trim().min(1).max(200),note:z.string().max(4000).default(''),goal_id:z.string().nullable().optional(),due:z.string().date().nullable().optional(),success_criteria:z.string().max(2000).optional()}).strict(),
 z.object({op:z.literal('update'),kind,id:z.string(),expected_version:z.number().int().nonnegative(),importance:importanceSchema.optional(),title:z.string().trim().min(1).max(200).optional(),note:z.string().max(4000).optional(),status:z.string().optional(),goal_id:z.string().nullable().optional(),due:z.string().date().nullable().optional(),success_criteria:z.string().max(2000).optional()}).strict(),
 z.object({op:z.literal('convert'),id:z.string(),target:z.enum(['todo','goal']),expected_version:z.number().int().nonnegative()}).strict(),
 z.object({op:z.literal('undo_create'),id:z.string(),kind:z.enum(['todo','goal']).optional(),expected_version:z.literal(1)}).strict(),
 z.object({op:z.literal('profile'),about:z.string().max(5000),expected_version:z.number().int().nonnegative()}).strict(),
])
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
/** Shared source ID alone is insufficient: separate claims can occur in one message. */
export function lifeEvidenceMatches(left:readonly {entry_id:string;version:string|number;quote?:string}[],right:readonly {entry_id:string;version:string|number;quote?:string}[]):boolean{
 return left.some(a=>!!a.quote?.trim()&&right.some(b=>a.entry_id===b.entry_id&&String(a.version)===String(b.version)&&a.quote!.trim()===b.quote?.trim()))
}
/** Shared domain transition; persistence and evidence admission belong to the backend. */
export function applyLifeMutation(state:LifeState,raw:unknown,requestId:string,now=new Date().toISOString()):{state:LifeState;result:{id:string;version:number}}{
 const p=lifeInputSchema.parse(raw),payload=hash(JSON.stringify(p)),next=structuredClone(state),prior=next.receipts[requestId]
 if(prior){if(prior.hash!==payload)throw Error('request_id_conflict');return {state:next,result:prior.result}}
  let result:{id:string;version:number}
  const base=(title:string,note:string)=>({...('importance' in p&&p.importance?{importance:p.importance}:{}),id:hash(requestId),title,note,version:1,created_at:now,updated_at:now})
  if('kind'in p){
   if(p.kind!=='todo'&&'due'in p&&p.due)throw Error('due_only_for_todo')
   if(p.kind!=='goal'&&'success_criteria'in p&&p.success_criteria)throw Error('criteria_only_for_goal')
   if(p.kind==='goal'&&'goal_id'in p&&p.goal_id)throw Error('goal_cannot_parent')
  }
  if('goal_id'in p&&p.goal_id){const previous=p.op==='update'?(p.kind==='todo'?next.todos:next.ideas).find(r=>r.id===p.id)?.goal_id:null
   if(!next.goals.some(g=>g.id===p.goal_id&&(g.status!=='archived'||previous===p.goal_id)))throw Error('goal_not_found')
  }
  if(p.op==='from_suggestion'){
   const rows=p.kind==='todo'?next.todos:p.kind==='idea'?next.ideas:next.goals
   const existing=rows.find(row=>row.source_suggestion_id===p.suggestion_id||(!p.todo_id&&p.source&&lifeEvidenceMatches(p.source.refs,[...(row.workbench_source?.refs??[]),...(row.suggestion_source?.refs??[])])))
   if(existing)result=existing
   else if(p.kind==='idea'){const row={...base(p.title,p.note),status:'active' as const,goal_id:null,source_suggestion_id:p.suggestion_id,...(p.source?{suggestion_source:p.source}:{}),sources:p.sources,provenance_refs:p.provenance_refs};next.ideas.push(row);result=row}
   else if(p.kind==='goal'){const row={...base(p.title,p.note),status:'active' as const,success_criteria:p.note,idea_id:null,source_suggestion_id:p.suggestion_id,...(p.source?{suggestion_source:p.source}:{}),sources:p.sources,provenance_refs:p.provenance_refs};next.goals.push(row);result=row}
   else if(p.todo_id){const todo=next.todos.find(todo=>todo.id===p.todo_id);if(!todo)throw Error('item_not_found');todo.note=[todo.note,p.note].filter(Boolean).join('\n').slice(0,4000);todo.version++;todo.updated_at=now;todo.source_suggestion_id=p.suggestion_id;if(p.source)todo.suggestion_source=p.source;todo.provenance_refs=[...new Set([...(todo.provenance_refs??[]),...p.provenance_refs])];todo.sources=[...(todo.sources??[]),...p.sources];result=todo}
   else{const todo={...base(p.title,p.note),status:'open' as const,due:p.due,goal_id:null,idea_id:null,source_suggestion_id:p.suggestion_id,...(p.source?{suggestion_source:p.source}:{}),sources:p.sources,provenance_refs:p.provenance_refs};next.todos.push(todo);result=todo}
  }else if(p.op==='undo_create'){const rows=p.kind==='goal'?next.goals:next.todos,old=rows.find(r=>r.id===p.id);if(!old)throw Error('item_not_found');if(old.version!==p.expected_version)throw Error('version_conflict');if(p.kind==='goal'){if(next.todos.some(r=>r.goal_id===p.id)||next.ideas.some(r=>r.goal_id===p.id))throw Error('goal_has_links');next.goals=next.goals.filter(r=>r.id!==p.id)}else next.todos=next.todos.filter(r=>r.id!==p.id);result={id:p.id,version:old.version}}
  else if(p.op==='profile'){if(next.profile.version!==p.expected_version)throw Error('version_conflict');next.profile={about:p.about,version:p.expected_version+1};result={id:'profile',version:next.profile.version}}
  else if(p.op==='from_context'){
   // The object retains its adoption identity after bounded request receipts are evicted.
   const existing=next.todos.find(todo=>todo.context_source?.candidate_id===p.source.candidate_id)
   if(existing)result=existing
   else{const b={...base(p.title,p.note),context_source:p.source};next.todos.push({...b,status:'open',due:null,goal_id:null,idea_id:null});result=b}
  }
  else if(p.op==='from_workbench'){
   if(!p.source.refs.every(ref=>p.evidence.some(input=>input.id===ref.entry_id&&input.version===ref.version&&input.text.includes(ref.quote))))throw Error('workbench_invalid_evidence')
   if(p.automatic&&(!p.proof||!p.evidence||p.proof.kind!==p.kind||p.proof.title!==p.title||p.proof.summary!==p.note||p.proof.due!==p.due||JSON.stringify(p.proof.refs)!==JSON.stringify(p.source.refs)||!automaticWorkbenchMatter({...p.proof,id:p.source.candidate_id,group:''},p.evidence)))throw Error('workbench_capture_not_explicit')
   const rows=p.kind==='todo'?next.todos:p.kind==='idea'?next.ideas:next.goals
   const existing=rows.find(row=>row.workbench_source?.candidate_id===p.source.candidate_id||lifeEvidenceMatches(p.source.refs,row.suggestion_source?.refs??[]))
   if(existing)result=existing
   else{const b={...base(p.title,p.note),workbench_source:{candidate_id:p.source.candidate_id,refs:p.source.refs},sources:p.sources,provenance_refs:p.source.refs.map(ref=>ref.entry_id),auto_recorded:p.automatic}
    if(p.kind==='todo')next.todos.push({...b,status:'open',due:p.due,goal_id:null,idea_id:null})
    if(p.kind==='idea')next.ideas.push({...b,status:'active',goal_id:null})
    if(p.kind==='goal')next.goals.push({...b,status:'active',success_criteria:p.success_criteria,idea_id:null})
    result=b
   }
  }
  else if(p.op==='from_news'){
   const rows=p.kind==='todo'?next.todos:p.kind==='idea'?next.ideas:next.goals
   const existing=rows.find(row=>row.news_source?.article_id===p.article.article_id)
   if(existing)result=existing
   else{const b={...base(p.title,p.note),news_source:{...p.article,action:'user_conversion' as const,converted_at:now}}
    if(p.kind==='todo')next.todos.push({...b,status:'open',due:null,goal_id:null,idea_id:null})
    if(p.kind==='idea')next.ideas.push({...b,status:'active',goal_id:null})
    if(p.kind==='goal')next.goals.push({...b,status:'active',success_criteria:'',idea_id:null})
    result=b
   }
  }else if(p.op==='create'){
   const b=base(p.title,p.note)
   if(p.kind==='todo')next.todos.push({...b,status:'open',due:p.due??null,goal_id:p.goal_id??null,idea_id:null})
   if(p.kind==='idea')next.ideas.push({...b,status:'active',goal_id:p.goal_id??null})
   if(p.kind==='goal')next.goals.push({...b,status:'active',success_criteria:p.success_criteria??'',idea_id:null})
   result=b
  }else if(p.op==='convert'){
   const idea=next.ideas.find(i=>i.id===p.id);if(!idea)throw Error('idea_not_found')
   const existing=p.target==='todo'?next.todos.find(t=>t.idea_id===p.id||(idea.news_source&&t.news_source?.article_id===idea.news_source.article_id)):next.goals.find(g=>g.idea_id===p.id||(idea.news_source&&g.news_source?.article_id===idea.news_source.article_id))
   if(existing)result=existing
   else{if(idea.version!==p.expected_version)throw Error('version_conflict');if(idea.status==='archived')throw Error('idea_archived')
    const b={...base(idea.title,idea.note),...(idea.provenance_refs?{provenance_refs:idea.provenance_refs}:{}),...(idea.sources?{sources:idea.sources}:{}),...(idea.news_source?{news_source:idea.news_source}:{})}
    if(p.target==='todo')next.todos.push({...b,status:'open',due:null,goal_id:idea.goal_id,idea_id:idea.id})
    else next.goals.push({...b,status:'active',success_criteria:'',idea_id:idea.id})
    result=b
   }
  }else{
   const rows=p.kind==='todo'?next.todos:p.kind==='idea'?next.ideas:next.goals
   const old=rows.find(r=>r.id===p.id);if(!old)throw Error('item_not_found');if(old.version!==p.expected_version)throw Error('version_conflict')
   const patch=Object.fromEntries(Object.entries(p).filter(([key])=>!['op','kind','id','expected_version'].includes(key)))
   const candidate={...old,...patch,version:old.version+1,updated_at:now}
   const parsed=p.kind==='todo'?todoSchema.strict().parse(candidate):p.kind==='idea'?ideaSchema.strict().parse(candidate):goalSchema.strict().parse(candidate)
   Object.assign(old,parsed);result=parsed
  }
  const receipt={id:result.id,version:result.version};next.receipts[requestId]={hash:payload,result:receipt};for(const key of Object.keys(next.receipts).slice(0,-256))delete next.receipts[key]
 return {state:lifeStateSchema.parse(next),result:receipt}
}

// ponytail: bounded personal collections, linear link lookup; add indexes only beyond these small limits.
export class LifeService{
 #store:BoundedJsonStore<LifeState>;#state:LifeState=emptyLifeState();#revision=0;#tail:Promise<unknown>=Promise.resolve();#backend:LifeBackend|undefined;#selectedAuthority=false;#hubSync:LifeSyncClient|undefined
 constructor(readonly path:string,readonly changed:()=>void=()=>{/* optional observer */},readonly backend?:LifeBackendSource){this.#store=new BoundedJsonStore(path,lifeStateSchema,8*1024*1024)}
 async open(){
  this.#backend=typeof this.backend==='function'?this.backend():this.backend
  if(this.#backend)this.#selectedAuthority=true
  else if(this.#selectedAuthority)throw Error('life_backend_unavailable')
  if(!this.#backend){this.#state=await this.#store.read(this.#state);return}
  const current=await this.#backend.peek?.()
  if(current){this.#state=lifeStateSchema.parse(current.state);this.#revision=current.revision;return}
  // Migration input is read-only: do not create, chmod or rewrite the old file.
  let legacy=emptyLifeState(),legacyRead=false
  try{const file=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if((await file.stat()).size>8*1024*1024)throw Error('store_capacity');const text=await file.readFile('utf8');legacyRead=true;if(text)legacy=lifeStateSchema.parse(JSON.parse(text))}finally{await file.close()}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const loaded=await this.#backend.load(legacy,legacyRead?{legacyPath:this.path}:undefined);this.#state=lifeStateSchema.parse(loaded.state);this.#revision=loaded.revision
 }
 async configureHubSync(options:{statePath:string;credentialsPath:string}):Promise<void>{
  const previous=this.#hubSync;this.#hubSync=undefined;await previous?.close()
  const {LifeSyncClient}=await import('../hub/life-sync.js')
  const client=new LifeSyncClient(this,options.statePath,options.credentialsPath);await client.open();this.#hubSync=client
  await client.sync()
 }
 syncHub(){return this.#hubSync?.sync()??Promise.resolve()}
 hubSyncStatus(){return this.#hubSync?.status()??{enabled:false}}
 #syncChanged(){void this.#hubSync?.sync().catch(()=>this.changed())}
 syncState(){return structuredClone(this.#state)}
 assertSyncSupported(){if(this.#backend&&!this.#backend.applySyncProjection)throw Error('unsupported_backend')}
 async applySyncProjection(projection:unknown,options:{requestId:string;expectedStateHash:string}):Promise<void>{
  const run=this.#tail.then(async()=>{
   this.assertSyncSupported()
   const {applyLifeSyncProjection}=await import('../hub/life-projection.js')
   const next=applyLifeSyncProjection(this.#state,projection,options.requestId)
   if(!Object.hasOwn(this.#state.receipts,options.requestId)&&hash(JSON.stringify(this.#state))!==options.expectedStateHash)throw Error('local_state_changed')
   if(this.#backend){
    const value=await this.#backend.applySyncProjection!({projection,requestId:options.requestId,expectedRevision:this.#revision})
    this.#state=lifeStateSchema.parse(value.state);this.#revision=value.revision
   }else{await this.#store.write(next.state);this.#state=next.state}
   this.changed()
  });this.#tail=run.catch(()=>{/* keep serial queue usable after rejected sync */});return run
 }
 async close(){await this.#hubSync?.close();await this.#tail}
 async refresh():Promise<void>{const run=this.#tail.then(async()=>{
  if(!this.#backend?.peek)return
  const fresh=await this.#backend.peek();if(!fresh)throw Error('life_backend_unavailable')
  if(fresh.revision===this.#revision&&JSON.stringify(fresh.state)===JSON.stringify(this.#state))return
  this.#state=lifeStateSchema.parse(fresh.state);this.#revision=fresh.revision;this.changed()
 });this.#tail=run.catch(()=>{/* preserve the mutation queue after a failed refresh */});return run}
 receipt(requestId:string){return structuredClone(this.#state.receipts[requestId]?.result)}
 snapshot(){const state=structuredClone(this.#state);return {todos:state.todos.map(r=>({...r,kind:'todo' as const})),ideas:state.ideas.map(r=>({...r,kind:'idea' as const})),profile:state.profile,goals:state.goals.map(g=>{const todos=state.todos.filter(t=>t.goal_id===g.id&&t.status!=='cancelled');return {...g,kind:'goal' as const,progress:{done:todos.filter(t=>t.status==='done').length,total:todos.length}}})}}
 async completeTaskTodo(task:TaskRecord):Promise<'synced'|'conflict'>{
  if(!task.todo_ref)return 'synced'
  // The Todo was delegated at revision zero; a changed scope needs explicit reconciliation.
  if(task.goal_revision!==0)return 'conflict'
  const receipt='task-complete:'+task.id+':'+task.goal_revision
  await this.refresh()
  // Receipt is checked before the captured-version/state guard, including a lost acknowledgement.
  if(this.#state.receipts[receipt])return 'synced'
  const todo=this.#state.todos.find(item=>item.id===task.todo_ref!.id)
  if(todo?.version!==task.todo_ref.version||todo.status==='cancelled'||todo.status==='done')return 'conflict'
  try{await this.mutate({op:'update',kind:'todo',id:task.todo_ref.id,expected_version:task.todo_ref.version,status:'done'},receipt);return 'synced'}
  catch(error){if(error instanceof Error&&['version_conflict','item_not_found'].includes(error.message))return 'conflict';throw error}
 }
 mutate(raw:unknown,requestId:string,guard?:()=>void,provenance?:LifeProvenance):Promise<{id:string;version:number}>{const p=lifeInputSchema.parse(raw);const run=this.#tail.then(async()=>{
  guard?.()
  if(this.#backend){
   try{
    const value=await this.#backend.mutate({input:p,requestId,expectedRevision:this.#revision,...(provenance?{provenance}: {})})
    this.#state=lifeStateSchema.parse(value.state);this.#revision=value.revision;this.changed();this.#syncChanged();return value.result
   }catch(error){
    if(error instanceof Error&&error.message==='version_conflict'){const fresh=await this.#backend.load(emptyLifeState());this.#state=lifeStateSchema.parse(fresh.state);this.#revision=fresh.revision;this.changed()}
    throw error
   }
  }
  const next=applyLifeMutation(this.#state,p,requestId)
  await this.#store.write(next.state);this.#state=next.state;this.changed();this.#syncChanged();return next.result
 });this.#tail=run.catch(()=>{/* keep serial queue usable after rejected command */});return run}
}
