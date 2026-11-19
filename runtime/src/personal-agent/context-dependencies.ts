import {z} from 'zod'

const id=z.string().min(1).max(128)
export const contextDependencySchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('scheduled'),run_id:id}).strict(),
 z.object({kind:z.literal('feed'),id,updated_at:z.string().datetime()}).strict(),
 z.object({kind:z.literal('app_record'),section:z.enum(['todos','goals']),id:z.string().min(1).max(512),version:z.number().int().nonnegative()}).strict(),
])
/** Empty tracked dependencies distinguish unrelated new chat from legacy unknown provenance. */
export const contextDependenciesSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('tracked'),items:z.array(contextDependencySchema).max(64)}).strict(),
 z.object({state:z.literal('unavailable')}).strict(),
])
export type ContextDependency=z.infer<typeof contextDependencySchema>
export type ContextDependencies=z.infer<typeof contextDependenciesSchema>
export const emptyContextDependencies=():ContextDependencies=>({state:'tracked',items:[]})
/** Overflow never drops a dependency and leaves apparently authorized text behind. */
export function mergeContextDependencies(...values:(ContextDependencies|undefined)[]):ContextDependencies{
 const items=new Map<string,ContextDependency>()
 for(const value of values){
  if(value?.state==='unavailable')return {state:'unavailable'}
  for(const item of value?.items??[]){items.set(JSON.stringify(item),item);if(items.size>64)return {state:'unavailable'}}
 }
 return {state:'tracked',items:[...items.values()]}
}
