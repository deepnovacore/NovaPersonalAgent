import {z} from 'zod'
import {createHash} from 'node:crypto'
import {lifeStateSchema,type LifeState} from '../personal-agent/life.js'

// The synchronization boundary never exports raw evidence, source grants,
// messages, connector credentials, or inferred profile sections.
const entityId=z.string().min(1).max(512).refine(id=>!['__proto__','constructor','prototype'].includes(id),'reserved_entity_id')
const common={id:true,title:true,note:true,status:true,importance:true} as const
export const syncEntitySchema=z.discriminatedUnion('kind',[
 lifeStateSchema.shape.todos.element.pick({...common,due:true,goal_id:true}).extend({kind:z.literal('todo'),id:entityId}).strict(),
 lifeStateSchema.shape.ideas.element.pick({...common,goal_id:true}).extend({kind:z.literal('idea'),id:entityId}).strict(),
 lifeStateSchema.shape.goals.element.pick({...common,success_criteria:true}).extend({kind:z.literal('goal'),id:entityId}).strict(),
 z.object({kind:z.literal('profile'),id:z.literal('profile'),about:z.string().max(5000)}).strict(),
])
export type SyncEntity=z.infer<typeof syncEntitySchema>
export const hubImportSchema=z.object({op:z.literal('import'),entity:syncEntitySchema.refine(entity=>entity.kind!=='profile','profile_uses_versioned_mutation'),created_at:z.string().datetime().optional(),updated_at:z.string().datetime().optional()}).strict()
export function lifeProjection(state:LifeState):Record<string,SyncEntity>{
 const result:Record<string,SyncEntity>={}
 for(const [kind,rows] of [['goal',state.goals],['todo',state.todos],['idea',state.ideas]] as const){
  for(const row of rows){
   const data:Record<string,unknown>={id:row.id,kind,title:row.title,note:row.note,status:row.status,importance:row.importance??'normal'}
   if('due'in row)data.due=row.due
   if('goal_id'in row)data.goal_id=row.goal_id
   if('success_criteria'in row)data.success_criteria=row.success_criteria
   result[row.id]=syncEntitySchema.parse(data)
  }
 }
 result.profile={kind:'profile',id:'profile',about:state.profile.about}
 return result
}
export function importLifeEntity(state:LifeState,raw:unknown):{state:LifeState;result:{id:string;version:number}}{
 const {entity,created_at,updated_at}=hubImportSchema.parse(raw)
 if(entity.id==='profile'||!entity.id||entity.id.length>512)throw Error('invalid_import')
 if([...state.todos,...state.ideas,...state.goals].some(row=>row.id===entity.id))throw Error('entity_id_conflict')
 if('goal_id'in entity&&entity.goal_id&&!state.goals.some(goal=>goal.id===entity.goal_id))throw Error('goal_not_found')
 const next=structuredClone(state),now=new Date().toISOString(),{kind,...fields}=entity
 const row={...fields,created_at:created_at??now,updated_at:updated_at??now,version:1}
 if(kind==='todo')next.todos.push(lifeStateSchema.shape.todos.element.parse({...row,idea_id:null}))
 if(kind==='idea')next.ideas.push(lifeStateSchema.shape.ideas.element.parse(row))
 if(kind==='goal')next.goals.push(lifeStateSchema.shape.goals.element.parse({...row,idea_id:null}))
 return {state:lifeStateSchema.parse(next),result:{id:entity.id,version:1}}
}

export const lifeSyncProjectionSchema=z.object({
 entities:z.array(syncEntitySchema).max(2201),tombstones:z.array(z.string().min(1)).max(10000).default([]),
}).strict()
/** Internal reconciliation only; never exposed as a Life command or tool. */
export function applyLifeSyncProjection(state:LifeState,raw:unknown,requestId:string):{state:LifeState;result:{id:string;version:number}}{
 const projection=lifeSyncProjectionSchema.parse(raw),payload=createHash('sha256').update(JSON.stringify(projection)).digest('hex')
 const previous=state.receipts[requestId]
 if(previous){if(previous.hash!==payload)throw Error('request_id_conflict');return {state,result:previous.result}}
 const next=structuredClone(state),seen=new Set<string>(),now=new Date().toISOString(),before=lifeProjection(state)
 for(const entity of projection.entities){
  if(seen.has(entity.id)||projection.tombstones.includes(entity.id))throw Error('invalid_projection')
  seen.add(entity.id)
  if(entity.kind==='profile'){
   if(next.profile.about!==entity.about)next.profile={about:entity.about,version:next.profile.version+1}
   continue
  }
  if(entity.id==='profile'||!entity.id||entity.id.length>512)throw Error('invalid_projection')
  const {kind,...fields}=entity,collection=kind==='todo'?'todos':kind==='idea'?'ideas':'goals'
  const old=next[collection].find(row=>row.id===entity.id)
  if(['todos','ideas','goals'].some(key=>key!==collection&&next[key as 'todos'|'ideas'|'goals'].some(row=>row.id===entity.id)))throw Error('entity_id_conflict')
  const projected=before[entity.id]
  if(projected&&JSON.stringify(projected)===JSON.stringify(entity))continue
  const row={...old,...fields,created_at:old?.created_at??now,updated_at:now,version:(old?.version??0)+1}
  if(kind==='todo'){const parsed=lifeStateSchema.shape.todos.element.parse({...row,idea_id:old&&'idea_id'in old?old.idea_id:null});next.todos=next.todos.filter(item=>item.id!==entity.id);next.todos.push(parsed)}
  if(kind==='idea'){const parsed=lifeStateSchema.shape.ideas.element.parse(row);next.ideas=next.ideas.filter(item=>item.id!==entity.id);next.ideas.push(parsed)}
  if(kind==='goal'){const parsed=lifeStateSchema.shape.goals.element.parse({...row,idea_id:old&&'idea_id'in old?old.idea_id:null});next.goals=next.goals.filter(item=>item.id!==entity.id);next.goals.push(parsed)}
 }
 // Hub only tombstones Todos; reject a malicious deletion of another entity kind.
 for(const id of projection.tombstones){
  if(next.goals.some(row=>row.id===id)||next.ideas.some(row=>row.id===id)||id==='profile')throw Error('invalid_tombstone')
  next.todos=next.todos.filter(row=>row.id!==id)
 }
 for(const row of [...next.todos,...next.ideas])if(row.goal_id&&!next.goals.some(goal=>goal.id===row.goal_id))throw Error('goal_not_found')
 for(const row of [...next.todos,...next.goals])if(row.idea_id&&!next.ideas.some(idea=>idea.id===row.idea_id))throw Error('idea_not_found')
 const result={id:'sync-projection',version:0}
 // Projection payloads contain no private fields, but store only a hash in receipts.
 next.receipts[requestId]={hash:payload,result}
 for(const key of Object.keys(next.receipts).slice(0,-256))delete next.receipts[key]
 return {state:lifeStateSchema.parse(next),result}
}
