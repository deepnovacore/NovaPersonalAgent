import {z} from 'zod'

export const memorySlotSchema=z.enum(['preferred_name','reply_style'])
export const explicitMemoryArguments=z.object({
  action:z.enum(['set','forget']),
  kind:z.enum(['fact','preference']).optional(),
  text:z.string().trim().min(1).max(500).optional(),
  quote:z.string().trim().min(1).max(2000),
  slot:memorySlotSchema.optional(),
  id:z.string().min(1).max(512).optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.slot&&v.id||v.action==='set'&&(!v.kind||!v.text)||v.action==='forget'&&(!v.slot&&!v.id||v.text||v.kind)||v.slot&&v.action==='set'&&v.kind!=='preference')ctx.addIssue({code:'custom',message:'invalid memory operation'})
  if(v.slot==='preferred_name'&&v.text&&v.text.length>64)ctx.addIssue({code:'custom',message:'name too long'})
})
export const explicitMemoryLookup=z.object({id:z.string().min(1).max(512).optional(),slot:memorySlotSchema.optional(),cursor:z.string().min(1).max(512).optional()}).strict()
export const explicitMemoryTurn=z.object({sourceId:z.string().min(1).max(300),text:z.string().min(1).max(40000),occurredAt:z.iso.datetime({offset:true})}).strict()
export type ExplicitMemoryTurn=z.infer<typeof explicitMemoryTurn>
export type ExplicitMemoryArguments=z.infer<typeof explicitMemoryArguments>
export type ExplicitMemoryLookup=z.infer<typeof explicitMemoryLookup>
export interface ExplicitMemoryEntry {id:string;version:number;kind:string;text:string;slot:string|null;status:'active'}
export interface ExplicitMemoryReceipt {state:'committed';id:string;version:number;replayed:boolean;current:ExplicitMemoryEntry|null}
export interface ExplicitMemoryPage {entries:ExplicitMemoryEntry[];next_cursor:string|null}
