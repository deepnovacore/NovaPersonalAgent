import {z} from 'zod'
import {processingRefSchema,processingTopicSchema} from '../memory-substrate/source-processing.js'
import type {HostToolSpec} from './work-tools.js'
export const sourceAgentArguments=z.discriminatedUnion('action',[
 z.object({action:z.literal('read')}).strict(),
 z.object({action:z.literal('projects'),refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('project_diff'),refs:z.array(processingRefSchema).min(1).max(8),project_id:z.string().max(128),commit:z.string().regex(/^[a-f0-9]{40}$/u)}).strict(),
 z.object({action:z.literal('topics'),query:z.string().max(200).default(''),after:z.number().int().nonnegative().default(0)}).strict(),
 z.object({action:z.literal('profile')}).strict(),
 z.object({action:z.literal('evidence'),refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('compose'),refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('finish'),topics:z.array(processingTopicSchema).max(8)}).strict(),
])
export const SOURCE_PROCESSING_TOOL_SPEC:HostToolSpec={name:'source__process',description:'The function name is source__process for every call. read, topics, profile, evidence, compose, finish, projects and project_diff are values of the action argument, never function names. Process this authorized bounded batch only. Call source__process with arguments exactly {"action":"read"} to read originals and exact refs. The host binds the batch; do not supply batch_id, run_id, task_id or recipe. topics searches the prior low-trust index. evidence retrieves originals. projects reads bounded Git authors, dated history and unmerged work for authorized file refs; project_diff reads a selected reachable commit. compose accumulates grounded observations from current batch refs, updates projects and suggestions, and lets the host synthesize Profile across durable observations (once per run). finish persists only current-batch topic summaries: copy exact refs from read, never historical topic/evidence refs. Never invent refs. Maximum 24 tool calls. No external writes are authorized.',inject_origin_ref:false,params:{type:'object',properties:{action:{type:'string',enum:['read','topics','profile','evidence','compose','finish','projects','project_diff']},project_id:{type:'string'},commit:{type:'string'},query:{type:'string'},after:{type:'integer'},refs:{type:'array',items:z.toJSONSchema(processingRefSchema)},topics:{type:'array',items:z.toJSONSchema(processingTopicSchema)}},required:['action'],oneOf:sourceAgentArguments.options.map(option=>z.toJSONSchema(option))} as HostToolSpec['params']}

