import {z} from 'zod'
import {processingRefSchema,processingTopicSchema} from '../memory-substrate/source-processing.js'
import type {HostToolSpec} from './work-tools.js'
export const sourceAgentArguments=z.discriminatedUnion('action',[
 z.object({action:z.literal('read')}).strict(),
 z.object({action:z.literal('topics'),query:z.string().max(200).default(''),after:z.number().int().nonnegative().default(0)}).strict(),
 z.object({action:z.literal('profile')}).strict(),
 z.object({action:z.literal('evidence'),refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('compose'),refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('finish'),topics:z.array(processingTopicSchema).max(8)}).strict(),
])
export const SOURCE_PROCESSING_TOOL_SPEC:HostToolSpec={name:'source__process',description:'Process this authorized bounded batch only. read returns originals and exact refs. topics searches the prior low-trust index. evidence retrieves originals. compose takes selected refs and verifies a profile draft (once per run). finish persists only current-batch topic summaries: copy exact refs from read, never historical topic/evidence refs. Never invent refs. Maximum 24 tool calls. No external writes are authorized.',inject_origin_ref:false,params:{type:'object',properties:{action:{type:'string',enum:['read','topics','profile','evidence','compose','finish']},query:{type:'string'},after:{type:'integer'},refs:{type:'array',items:z.toJSONSchema(processingRefSchema)},topics:{type:'array',items:z.toJSONSchema(processingTopicSchema)}},required:['action'],oneOf:sourceAgentArguments.options.map(option=>z.toJSONSchema(option))} as HostToolSpec['params']}

