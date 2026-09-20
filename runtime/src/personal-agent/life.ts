import {z} from 'zod'
import {createHash} from 'node:crypto'
import {BoundedJsonStore} from '../storage/bounded-json.js'
const fields={id:z.string(),version:z.number().int().nonnegative(),title:z.string().trim().min(1).max(200),note:z.string().max(4000),created_at:z.string(),updated_at:z.string()}
const todoSchema=z.object({...fields,status:z.enum(['open','doing','waiting','done','cancelled']),due:z.string().date().nullable(),goal_id:z.string().nullable(),idea_id:z.string().nullable()})
const ideaSchema=z.object({...fields,status:z.enum(['active','archived']),goal_id:z.string().nullable()})
const goalSchema=z.object({...fields,status:z.enum(['active','paused','completed','archived']),success_criteria:z.string().max(2000),idea_id:z.string().nullable()})
const schema=z.object({todos:z.array(todoSchema).max(1000),ideas:z.array(ideaSchema).max(1000),goals:z.array(goalSchema).max(200),profile:z.object({about:z.string().max(4000),version:z.number().int().nonnegative()}),receipts:z.record(z.string(),z.object({hash:z.string(),result:z.object({id:z.string(),version:z.number()})}))})
type State=z.infer<typeof schema>
const kind=z.enum(['todo','idea','goal'])
const input=z.discriminatedUnion('op',[
 z.object({op:z.literal('create'),kind,title:z.string().trim().min(1).max(200),note:z.string().max(4000).default(''),goal_id:z.string().nullable().optional(),due:z.string().date().nullable().optional(),success_criteria:z.string().max(2000).optional()}).strict(),
 z.object({op:z.literal('update'),kind,id:z.string(),expected_version:z.number().int().nonnegative(),title:z.string().trim().min(1).max(200).optional(),note:z.string().max(4000).optional(),status:z.string().optional(),goal_id:z.string().nullable().optional(),due:z.string().date().nullable().optional(),success_criteria:z.string().max(2000).optional()}).strict(),
 z.object({op:z.literal('convert'),id:z.string(),target:z.enum(['todo','goal']),expected_version:z.number().int().nonnegative()}).strict(),
 z.object({op:z.literal('profile'),about:z.string().max(4000),expected_version:z.number().int().nonnegative()}).strict(),
])
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
// ponytail: bounded personal collections, linear link lookup; add indexes only beyond these small limits.
export class LifeService{
 #store:BoundedJsonStore<State>;#state:State={todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}};#tail:Promise<unknown>=Promise.resolve()
 constructor(readonly path:string,readonly changed:()=>void=()=>{/* optional observer */}){this.#store=new BoundedJsonStore(path,schema,8*1024*1024)}
 async open(){this.#state=await this.#store.read(this.#state)}
 async close(){await this.#tail}
 snapshot(){const state=structuredClone(this.#state);return {todos:state.todos.map(r=>({...r,kind:'todo' as const})),ideas:state.ideas.map(r=>({...r,kind:'idea' as const})),profile:state.profile,goals:state.goals.map(g=>{const todos=state.todos.filter(t=>t.goal_id===g.id&&t.status!=='cancelled');return {...g,kind:'goal' as const,progress:{done:todos.filter(t=>t.status==='done').length,total:todos.length}}})}}
 mutate(raw:unknown,requestId:string):Promise<{id:string;version:number}>{const p=input.parse(raw),payload=hash(JSON.stringify(p));const run=this.#tail.then(async()=>{
  const next=structuredClone(this.#state),prior=next.receipts[requestId];if(prior){if(prior.hash!==payload)throw Error('request_id_conflict');return prior.result}
  const now=new Date().toISOString();let result:{id:string;version:number}
  const base=(title:string,note:string,id=hash(requestId))=>({id,title,note,version:1,created_at:now,updated_at:now})
  if('kind'in p){
   if(p.kind!=='todo'&&'due'in p&&p.due)throw Error('due_only_for_todo')
   if(p.kind!=='goal'&&'success_criteria'in p&&p.success_criteria)throw Error('criteria_only_for_goal')
   if(p.kind==='goal'&&'goal_id'in p&&p.goal_id)throw Error('goal_cannot_parent')
  }
  if('goal_id'in p&&p.goal_id){const previous=p.op==='update'?(p.kind==='todo'?next.todos:next.ideas).find(r=>r.id===p.id)?.goal_id:null
   if(!next.goals.some(g=>g.id===p.goal_id&&(g.status!=='archived'||previous===p.goal_id)))throw Error('goal_not_found')
  }
  if(p.op==='profile'){if(next.profile.version!==p.expected_version)throw Error('version_conflict');next.profile={about:p.about,version:p.expected_version+1};result={id:'profile',version:next.profile.version}}
  else if(p.op==='create'){
   const b=base(p.title,p.note)
   if(p.kind==='todo')next.todos.push({...b,status:'open',due:p.due??null,goal_id:p.goal_id??null,idea_id:null})
   if(p.kind==='idea')next.ideas.push({...b,status:'active',goal_id:p.goal_id??null})
   if(p.kind==='goal')next.goals.push({...b,status:'active',success_criteria:p.success_criteria??'',idea_id:null})
   result=b
  }else if(p.op==='convert'){
   const idea=next.ideas.find(i=>i.id===p.id);if(!idea)throw Error('idea_not_found')
   const existing=p.target==='todo'?next.todos.find(t=>t.idea_id===p.id):next.goals.find(g=>g.idea_id===p.id)
   if(existing)result=existing
   else{if(idea.version!==p.expected_version)throw Error('version_conflict');if(idea.status==='archived')throw Error('idea_archived')
    const b=base(idea.title,idea.note)
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
  await this.#store.write(next)
  this.#state=next;this.changed();return receipt
 });this.#tail=run.catch(()=>{/* keep serial queue usable after rejected command */});return run}
}
