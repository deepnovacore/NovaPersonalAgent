import { z } from 'zod';
export const versionSchema = z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]);
export const proposalSchema = z.object({ kind: z.enum(['notify', 'question']), summary: z.string().trim().min(1).max(200), why_now: z.string().max(200), evidence_refs: z.array(z.string().min(1).max(512)).max(16), memory_refs: z.array(z.object({ entry_id: z.string().min(1).max(256), version: versionSchema }).strict()).max(16) }).strict().refine(p => p.evidence_refs.length + p.memory_refs.length > 0);
export type Proposal = z.infer<typeof proposalSchema>;
export const personalCommandSchema = z.object({ type: z.literal('personal.command'), request_id: z.string().min(1).max(128), method: z.enum(['state', 'feed.action', 'memory.list', 'memory.correct', 'memory.forget', 'discovery.configure', 'sources.add', 'sources.pause', 'sources.resume', 'sources.disconnect', 'sources.delete', 'sources.sync']), params: z.record(z.string(), z.unknown()).default({}) }).strict();
export type PersonalCommand = z.infer<typeof personalCommandSchema>;
export interface FeedItem {
    id: string;
    kind: 'notify' | 'question' | 'task_result' | 'schedule' | 'change';
    title: string;
    why_now: string;
    evidence_refs: string[];
    memory_refs: Proposal['memory_refs'];
    source: {
        type: 'conversation' | 'task' | 'memory' | 'file' | 'mail' | 'calendar';
        ref: string;
    };
    suggestion_id: string | null;
    task_ref: {
        work_id: string;
    } | null;
    subject_key: string;
    priority: number;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
    user_state: 'new' | 'seen' | 'snoozed' | 'dismissed';
    snooze_until: string | null;
    lifecycle: 'active' | 'resolved' | 'invalidated';
    delivery: {
        presented_at: string | null;
        notified_at: string | null;
        spoken_at: string | null;
    };
}
export interface PersonalSettings {
    discovery_enabled: boolean;
    discovery_interval_minutes: number;
}
export const feedItemSchema: z.ZodType<FeedItem> = z.object({
    id: z.string().min(1).max(128), kind: z.enum(['notify', 'question', 'task_result', 'schedule', 'change']), title: z.string().max(120), why_now: z.string().max(200), evidence_refs: z.array(z.string().max(512)).max(16), memory_refs: z.array(z.object({ entry_id: z.string().max(256), version: versionSchema }).strict()).max(16), source: z.object({ type: z.enum(['conversation', 'task', 'memory', 'file', 'mail', 'calendar']), ref: z.string().max(512) }).strict(), suggestion_id: z.string().nullable(), task_ref: z.object({ work_id: z.string() }).strict().nullable(), subject_key: z.string(), priority: z.number().finite(), created_at: z.string().datetime(), updated_at: z.string().datetime(), expires_at: z.string().datetime().nullable(), user_state: z.enum(['new', 'seen', 'snoozed', 'dismissed']), snooze_until: z.string().datetime().nullable(), lifecycle: z.enum(['active', 'resolved', 'invalidated']), delivery: z.object({ presented_at: z.string().datetime().nullable(), notified_at: z.string().datetime().nullable(), spoken_at: z.string().datetime().nullable() }).strict(),
}).strict();
export const personalSettingsSchema = z.object({ discovery_enabled: z.boolean(), discovery_interval_minutes: z.number().int().min(5).max(1440) }).strict();
