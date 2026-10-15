import {z} from 'zod'

/** Constraints on originals, not inferred memories or current conversation history. */
export const sourceFilterSchema=z.object({
 kind:z.enum(['im','mail','calendar','file']).optional(),
 provider:z.string().trim().min(1).max(80).optional(),
 since:z.iso.datetime({offset:true}).optional(),
 before:z.iso.datetime({offset:true}).optional(),
 last_days:z.number().int().min(1).max(365).optional(),
}).strict().refine(value=>value.last_days===undefined||(!value.since&&!value.before),'last_days cannot be combined with explicit dates')
 .refine(value=>!value.since||!value.before||Date.parse(value.since)<Date.parse(value.before),'invalid source time range')
export type SourceFilter=z.infer<typeof sourceFilterSchema>
export interface SourceRecallResult {hits:{evidence_id:string;score:number}[];truncated:boolean}
