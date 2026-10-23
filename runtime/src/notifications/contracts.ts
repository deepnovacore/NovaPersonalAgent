import { z } from 'zod';
const id = z.string().min(1).max(512);
export const bindingSchema = z.object({ id, provider: id, user_scope: id, generation: z.number().int().nonnegative(), identity: id, status: z.enum(['ready', 'unavailable', 'disconnected']) }).strict();
export type ChannelBinding = z.infer<typeof bindingSchema>;
export const notificationSchema = z.object({ event_key: id, revision: id, occurrence: id, kind: z.enum(['brief', 'suggestion', 'task_progress', 'task_result', 'alert', 'attention_required']), title: z.string().max(200), body: z.string().max(131072), guard: z.object({task_id:id.optional(),goal_revision:z.number().int().nonnegative().optional(),work_id:id.optional(),evidence_refs:z.array(id).max(256).optional(),goal_ids:z.array(id).max(5).optional(),requires_runtime:z.boolean().optional()}).strict().optional(), source: z.object({ type: id, id, version: z.string().optional() }).strict(), created_at: z.number().finite(), expires_at: z.number().finite().nullable(), not_before: z.number().finite(), priority: z.number().finite(), coalesce_key: id.nullable(), feedback: z.array(z.enum(['open', 'snooze', 'dismiss'])).max(3) }).strict();
export type NotificationInput = z.infer<typeof notificationSchema>;
/** One summary per local date: `source.id` is that date, `source.version` the feed id, `guard.goal_ids` the goals it asks about; the host re-checks every goal before each send. */
export const goalCheckinSource = 'goal_checkin';
export const partSchema = z.object({ title: z.string().max(200), body: z.string().max(131072), payload: z.string().max(262144).optional() }).strict();
export type PreparedPart = z.infer<typeof partSchema>;
export interface ChannelReceipt {
    message_id: string;
    chat_id?: string;
}
export type SendOutcome = {
    kind: 'accepted';
    receipt: ChannelReceipt;
} | {
    kind: 'retryable';
    definitelyNotAccepted: true;
    retryAfterMs?: number;
} | {
    kind: 'blocked';
    reason: string;
} | {
    kind: 'unknown';
    reason: string;
};
export interface SendContext {
    binding: ChannelBinding;
    idempotency_key: string;
    notification: NotificationInput;
    signal: AbortSignal;
}
export interface NotificationChannelAdapter {
    readonly providerId: string;
    inspect(binding: ChannelBinding, signal: AbortSignal): Promise<boolean>;
    prepare(notification: NotificationInput, binding: ChannelBinding): Promise<PreparedPart[]>;
    send(part: PreparedPart, context: SendContext): Promise<SendOutcome>;
}
/** Reserved only: receiving text is not registered by outbound adapters. */
export interface ChannelInboundEvent {
    provider_id: string;
    binding_id: string;
    binding_generation: number;
    provider_event_id: string;
    sender_ref: string;
    provider_conversation_ref: string;
    provider_thread_ref?: string;
    in_reply_to?: string;
    occurred_at: number;
    kind: 'text' | 'feedback' | 'receipt';
}
export const deliveryStatusSchema = z.enum(['pending', 'sending', 'accepted', 'retry_wait', 'blocked', 'unknown', 'cancelled', 'expired', 'superseded']);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export const deliverySchema = z.object({ id, notification: notificationSchema, route_revision: z.number().int(), binding: bindingSchema, status: deliveryStatusSchema, parts: z.array(z.object({ part: partSchema, key: id, receipt: z.object({ message_id: id, chat_id: id.optional() }).strict().nullable() }).strict()).max(256), attempts: z.number().int().nonnegative(), next_attempt_at: z.number(), updated_at: z.number(), error: z.string().max(128).nullable(), invalidated: z.boolean().default(false) }).strict();
export type Delivery = z.infer<typeof deliverySchema>;
export const notificationStateSchema = z.object({ schema_version: z.literal(1), user_scope: id, route_revision: z.number().int(), primary_binding_id: id, configured: z.boolean(), bindings: z.array(bindingSchema).max(32), deliveries: z.array(deliverySchema).max(10000), dedupe: z.record(id, z.number()), migrated: z.boolean(), cutoff: z.number() }).strict();
export type NotificationState = z.infer<typeof notificationStateSchema>;
