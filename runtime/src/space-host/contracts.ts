import {z} from 'zod';
const id=z.string().min(1).max(128);
export const intentSchema=z.object({v:z.literal(1),type:z.literal('intent'),op_id:id,kind:z.enum(['life.mutate','snapshot.request','chat.send','chat.cancel','card.dismiss','mobile.result','push.register','push.unregister','source.input','settings.patch','secret.put','secret.clear','connector.feishu','device.revoke','approval.resolve']),input:z.record(z.string(),z.unknown()),created_at:z.number().int().nonnegative(),expires_at:z.number().int().optional(),base_version:z.number().int().nonnegative().optional(),temp_id:id.optional(),depends_on:z.array(id).max(64).optional()});
export type SpaceIntent=z.infer<typeof intentSchema>;
export type BusinessMessage=Record<string,unknown>;
export interface DisplayCard {id:string;kind:string;title:string;body:string;version:string|number;created_at?:string;date?:string;dismissed?:boolean}
/** An executor approval the Host is waiting on. `expires_at` is wall-clock epoch ms, or null while the head is held. */
export interface DisplayApproval {id:string;conversation_id:string;summary:string;kind:string|null;allowed_decisions:string[];expires_at:number|null}
export const approvalResolveSchema=z.object({conversation_id:id,approval_id:id,approved:z.boolean(),scope:z.enum(['once','session']).optional()}).strict();
export interface DisplaySnapshot {schema_version:1;revision:number;processing_provider:{id:string;label:string}|null;source_processing:{status:'idle'|'working'|'ready'|'failed';needs_update:boolean};goals:Record<string,unknown>[];todos:Record<string,unknown>[];ideas:Record<string,unknown>[];profile:{about:string;version:number};profile_presentation?:{about:string;work:{title:string;text:string}[];interests:string[];source:'manual'|'current'|'last_success'|'empty'};timeline:DisplayCard[];timeline_entries?:Record<string,unknown>[];timeline_available_evidence_ids?:string[];conversations?:Record<string,unknown>[];feed:DisplayCard[];notifications:DisplayCard[];chat:Record<string,unknown>[];owner?:boolean;host_settings?:Record<string,unknown>;host_credentials?:{name:string;configured:boolean;source:'environment'|'space'|null;fingerprint?:string}[];host_feishu?:Record<string,unknown>;pending_approvals?:DisplayApproval[]}
export const mobileActionSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('calendar.read'),args:z.object({start:z.string().datetime(),end:z.string().datetime()}).strict()}),
 z.object({tool:z.literal('reminder.create'),args:z.object({title:z.string().min(1).max(200),due:z.string().datetime()}).strict()}),
 z.object({tool:z.literal('camera.capture'),args:z.object({prompt:z.string().max(500)}).strict()}),
]);
