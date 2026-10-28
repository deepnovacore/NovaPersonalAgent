import {z} from 'zod';
import {mobileActionSchema} from './contracts.js';
import type {HostToolSpec} from '../core/work-tools.js';
import type {JsonValue} from '../core/events.js';
export const spaceMobileArguments=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('list')}).strict(),
 z.object({operation:z.literal('action'),device:z.string().min(1).max(128),action:mobileActionSchema}).strict(),
 z.object({operation:z.literal('result'),action_id:z.string().min(1).max(128)}).strict(),
]);
export interface SpaceMobilePort {invoke(args:unknown,context:{request_id:string;stillWanted:()=>boolean}):Promise<JsonValue>}
export const SPACE_MOBILE_TOOL_SPEC:HostToolSpec={name:'mobile__action',description:'Execute one explicit system action on a paired phone: read a specified calendar interval, create one reminder with title and due time, or ask the user to capture one photo. Host plans; phone only checks permissions and executes the exact action. Never send a goal, instruction to an agent, script or multi-step plan. list returns paired device IDs; action returns action_id with pending status. Only result=completed proves execution; denied/failed/unknown must not be retried automatically. Call result with the same action_id to inspect progress.',inject_origin_ref:true,params:{type:'object',properties:{operation:{type:'string',enum:['list','action','result']},device:{type:'string'},action:z.toJSONSchema(mobileActionSchema),action_id:{type:'string'}},oneOf:spaceMobileArguments.options.map(value=>z.toJSONSchema(value))} as HostToolSpec['params']};
