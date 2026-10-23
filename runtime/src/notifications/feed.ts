import { createHash } from 'node:crypto';
import type { FeedItem } from '../personal-agent/contracts.js';
import { goalCheckinSource, type NotificationInput } from './contracts.js';
export function feedNotification(item: FeedItem): NotificationInput {
    const checkin = item.goal_checkin;
    const body = checkin ? checkin.items.map(line => '· ' + line.text).join('\n') : item.prepared?.text ?? (item.kind === 'task_result' ? item.title : item.why_now);
    const revision = createHash('sha256').update(JSON.stringify([item.kind, item.title, body])).digest('hex');
    return { event_key: 'feed:' + item.id, revision, occurrence: item.snooze_until ? 'snooze:' + item.snooze_until : 'initial', kind: item.kind === 'task_result' ? 'task_result' : item.subject_key.startsWith('brief:') ? 'brief' : 'suggestion', title: item.title, body, ...(checkin ? { guard: { goal_ids: checkin.items.map(line => line.goal_id) } } : {}), source: checkin ? { type: goalCheckinSource, id: checkin.local_date, version: item.id } : { type: 'feed', id: item.id }, created_at: Date.parse(item.updated_at), expires_at: item.expires_at ? Date.parse(item.expires_at) : null, not_before: item.snooze_until ? Date.parse(item.snooze_until) : 0, priority: item.priority, coalesce_key: 'feed:' + item.id, feedback: item.lifecycle === 'active' ? ['open', 'snooze', 'dismiss'] : ['open'] };
}
/** The feed item a notification mirrors: `feed` sources name it directly, a goal check-in carries it as the source version. */
export const feedSourceId = (n: NotificationInput): string | undefined => n.source.type === 'feed' ? n.source.id : n.source.type === goalCheckinSource ? n.source.version : undefined;
export const feedNotificationKey = (n: NotificationInput) => n.event_key + ':' + n.revision + ':' + n.occurrence;
