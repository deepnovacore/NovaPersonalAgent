import {z} from 'zod';
const id=z.string().min(1).max(128);
export const intentSchema=z.object({v:z.literal(1),type:z.literal('intent'),op_id:id,kind:z.enum(['life.mutate','snapshot.request','chat.send','chat.cancel','card.dismiss','mobile.result','push.register','push.unregister','source.input']),input:z.record(z.string(),z.unknown()),created_at:z.number().int().nonnegative(),expires_at:z.number().int().optional(),base_version:z.number().int().nonnegative().optional(),temp_id:id.optional(),depends_on:z.array(id).max(64).optional()});
export type SpaceIntent=z.infer<typeof intentSchema>;
export type BusinessMessage=Record<string,unknown>;
export interface DisplayCard {id:string;kind:string;title:string;body:string;version:string|number;created_at?:string;dismissed?:boolean}
export interface DisplaySnapshot {schema_version:1;revision:number;processing_provider:{id:string;label:string}|null;goals:Record<string,unknown>[];todos:Record<string,unknown>[];ideas:Record<string,unknown>[];profile:{about:string;version:number};timeline:DisplayCard[];feed:DisplayCard[];notifications:DisplayCard[];chat:Record<string,unknown>[]}
export const mobileActionSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('calendar.read'),args:z.object({start:z.string().datetime(),end:z.string().datetime()}).strict()}),
 z.object({tool:z.literal('reminder.create'),args:z.object({title:z.string().min(1).max(200),due:z.string().datetime()}).strict()}),
 z.object({tool:z.literal('camera.capture'),args:z.object({prompt:z.string().max(500)}).strict()}),
]);
