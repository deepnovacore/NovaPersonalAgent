import type { NotificationChannelAdapter, NotificationInput } from '../contracts.js';
export function novaNotificationAdapter(present: (message: NotificationInput) => Promise<void>): NotificationChannelAdapter {
    return { providerId: 'nova', inspect: () => Promise.resolve(true), prepare: (message) => Promise.resolve([{ title: message.title, body: message.body }]), send: async (_part, context) => { context.signal.throwIfAborted(); try {
            await present(context.notification);
        }
        catch (error) {
            if (error instanceof Error && error.message === 'notification_route_changed')
                return { kind: 'retryable', definitelyNotAccepted: true };
            throw error;
        } return { kind: 'accepted', receipt: { message_id: context.idempotency_key } }; } };
}
