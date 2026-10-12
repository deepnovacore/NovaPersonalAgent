import { createHash } from 'node:crypto';
import type { FeedItem } from '../personal-agent/contracts.js';
import type { NotificationInput } from './contracts.js';
export function feedNotification(item: FeedItem): NotificationInput {
    const body = item.prepared?.text ?? (item.kind === 'task_result' ? item.title : item.why_now);
    const revision = createHash('sha256').update(JSON.stringify([item.kind, item.title, body])).digest('hex');
    return { event_key: 'feed:' + item.id, revision, occurrence: item.snooze_until ? 'snooze:' + item.snooze_until : 'initial', kind: item.kind === 'task_result' ? 'task_result' : item.subject_key.startsWith('brief:') ? 'brief' : 'suggestion', title: item.title, body, source: { type: 'feed', id: item.id }, created_at: Date.parse(item.updated_at), expires_at: item.expires_at ? Date.parse(item.expires_at) : null, not_before: item.snooze_until ? Date.parse(item.snooze_until) : 0, priority: item.priority, coalesce_key: 'feed:' + item.id, feedback: item.lifecycle === 'active' ? ['open', 'snooze', 'dismiss'] : ['open'] };
}
export const feedNotificationKey = (n: NotificationInput) => n.event_key + ':' + n.revision + ':' + n.occurrence;
