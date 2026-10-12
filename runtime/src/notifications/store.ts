import { BoundedJsonStore } from '../storage/bounded-json.js';
import { notificationStateSchema, type NotificationState } from './contracts.js';
export const notificationStore = (path: string) => new BoundedJsonStore<NotificationState>(path, notificationStateSchema, 16 * 1024 * 1024);
