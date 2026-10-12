import type { FeishuConnector } from '../../connectors/feishu/index.js';
import type { NotificationChannelAdapter } from '../contracts.js';
/** Plain text cards avoid markdown downloads and keep the prepared body intact. */
export function feishuNotificationAdapter(connector: FeishuConnector): NotificationChannelAdapter {
    return { providerId: 'feishu', inspect: (binding, signal) => connector.inspectNotificationBinding(binding, signal), prepare: async (message) => {
            const points = Array.from(message.body), parts = [];
            for (let start = 0; start < points.length; start += 1800)
                parts.push({ title: message.title.slice(0, 150), body: points.slice(start, start + 1800).join('') });
            return Promise.resolve(parts.length ? parts : [{ title: message.title, body: message.title }]);
        }, send: (part, context) => connector.sendNotificationPart(part, context) };
}
