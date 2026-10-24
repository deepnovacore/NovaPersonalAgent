import {z} from 'zod';
import { BoundedJsonStore } from '../storage/bounded-json.js';
import { notificationStateSchema, type NotificationState } from './contracts.js';
const storedNotificationSchema=notificationStateSchema.extend({legacy_binding_id:z.string().min(1).max(512).nullable().optional()}).transform(value=>{delete value.legacy_binding_id;return notificationStateSchema.parse(value)});
export const notificationStore = (path: string) => new BoundedJsonStore<NotificationState>(path, storedNotificationSchema, 16 * 1024 * 1024);
