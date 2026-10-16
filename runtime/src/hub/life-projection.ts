import {z} from 'zod'
import {lifeStateSchema,type LifeState} from '../personal-agent/life.js'

// The synchronization boundary never exports raw evidence, source grants,
// messages, connector credentials, or inferred profile sections.
const common={id:true,title:true,note:true,status:true,importance:true} as const
export const syncEntitySchema=z.discriminatedUnion('kind',[
 lifeStateSchema.shape.todos.element.pick({...common,due:true,goal_id:true}).extend({kind:z.literal('todo')}).strict(),
 lifeStateSchema.shape.ideas.element.pick({...common,goal_id:true}).extend({kind:z.literal('idea')}).strict(),
 lifeStateSchema.shape.goals.element.pick({...common,success_criteria:true}).extend({kind:z.literal('goal')}).strict(),
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
