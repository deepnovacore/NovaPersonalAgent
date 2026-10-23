import {notificationSchema,type NotificationInput} from '../notifications/contracts.js';
import {conversationsStateSchema,initialConversations,type ConversationsState} from './conversations.js';
import {Worker} from 'node:worker_threads';
import { z } from 'zod';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparePrivateDatabasePath } from '../storage/private-database.js';
import { feedItemSchema, personalSettingsSchema, type FeedItem, type PersonalSettings } from './contracts.js';
export interface PersonalState {
    notification_intents: Record<string,NotificationInput>;
    notification_fingerprints: Record<string,string>;
    notifications_initialized: boolean;
    notification_task_baseline: string[];
    conversations:ConversationsState;
    user_scope: string | null;
    revision: number;
    feed: FeedItem[];
    dedupe: string[];
    brief_runs: Record<string,{status:'processing'|'success'|'failed'|'empty';attempts:number;last_attempt_at:string}>;
    settings: PersonalSettings;
    receipts: Record<string, {
        payload: string;
        result: unknown;
    }>;
}
export const initialState = (): PersonalState => ({ notification_task_baseline:[],notification_intents:{},notification_fingerprints:{},notifications_initialized:false,conversations:initialConversations(), user_scope: null, revision: 0, feed: [], dedupe: [], brief_runs: {}, settings: { discovery_enabled: true, discovery_interval_minutes: 30 }, receipts: {} });
// ponytail: bounded JSON ledger; move to the existing Worker if 10000 retained matters are needed.
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 75, 100, 125, 150, 175, 200] as const;
/** Windows can briefly deny replacing a file while another process closes its handle. */
export async function renamePersonalStoreFile(
    source: string,
    destination: string,
    renameFn: (source: string, destination: string) => Promise<void> = rename,
    platform: NodeJS.Platform = process.platform,
): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await renameFn(source, destination);
            return;
        }
        catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
            if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || delay === undefined)
                throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
const stateSchema = z.object({ notification_task_baseline:z.array(z.string()).default([]),notification_intents:z.record(z.string(),notificationSchema).default({}),notification_fingerprints:z.record(z.string(),z.string()).default({}),notifications_initialized:z.boolean().default(false),conversations:conversationsStateSchema.default(initialConversations), user_scope: z.string().max(512).nullable(), revision: z.number().int().nonnegative(), feed: z.array(feedItemSchema).max(10000), dedupe: z.array(z.string().max(128)).max(20000), brief_runs:z.record(z.string().max(128),z.object({status:z.enum(['processing','success','failed','empty']),attempts:z.number().int().min(1).max(3),last_attempt_at:z.iso.datetime()})).default({}), settings: personalSettingsSchema, receipts: z.record(z.string().max(128), z.object({ payload: z.string().max(16384), result: z.unknown() })).refine(r => Object.keys(r).length <= 256) }).strict();
export class PersonalStore {
    constructor(readonly path: string) { }
    async ensureScheduleBackup():Promise<void>{
        const path=this.path+'.before-schedules.json'
        // An empty backup (a truncating reset) is treated as missing and recreated below; any other invalid backup still fails.
        let empty=false
        try{const saved=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await saved.stat();if(info.size>MAX_STORE_BYTES||(process.platform!=='win32'&&(info.mode&0o777)!==0o600))throw Error('invalid_schedule_backup');if(info.size===0&&info.isFile())empty=true;else{stateSchema.parse(JSON.parse(await saved.readFile('utf8')));return}}finally{await saved.close()}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        if(empty)await unlink(path)
        const original=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW)
        let text:string
        try{if((await original.stat()).size>MAX_STORE_BYTES)throw Error('personal_store_capacity');text=await original.readFile('utf8')}finally{await original.close()}
        if(!text)text=JSON.stringify(initialState())
        stateSchema.parse(JSON.parse(text))
        const backup=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
        try{await backup.writeFile(text);await backup.sync()}finally{await backup.close()}
        const check=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
        try{if(await check.readFile('utf8')!==text)throw Error('schedule_backup_mismatch')}finally{await check.close()}
    }
    async read(): Promise<PersonalState> {
        preparePrivateDatabasePath(this.path);
        const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await file.stat()).size > MAX_STORE_BYTES)
                throw Error('personal_store_capacity');
            const text = await file.readFile('utf8');
            return text === '' ? initialState() : stateSchema.parse(JSON.parse(text));
        }
        finally {
            await file.close();
        }
    }
    async write(state: PersonalState): Promise<void> {
        const text = JSON.stringify(stateSchema.parse(state));
        if (Buffer.byteLength(text) > MAX_STORE_BYTES)
            throw Error('personal_store_capacity');
        preparePrivateDatabasePath(this.path);
        const tmp = this.path + '.' + randomUUID() + '.tmp';
        const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(text);
            await file.sync();
        }
        catch (e) {
            await unlink(tmp).catch(() => { /* cleanup retains original failure */ });
            throw e;
        }
        finally {
            await file.close();
        }
        try {
            await renamePersonalStoreFile(tmp, this.path);
            // Node cannot fsync directories on Windows; the file was synced before rename.
            if (process.platform !== 'win32') {
                const directory = await open(dirname(this.path), constants.O_RDONLY);
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
        }
        catch (e) {
            await unlink(tmp).catch(() => { /* cleanup retains original failure */ });
            throw e;
        }
    }
}
/** SQLite's OS lock is released on process death; the Worker stores no user content. */
export async function acquirePersonalLock(path: string): Promise<() => Promise<void>> {
    const worker = new Worker(new URL('./store-lock-worker.js', import.meta.url), {workerData: {path: path + '.owner.sqlite'}});
    try {
        await new Promise<void>((resolve, reject) => {
            worker.once('message', (message: {ready:boolean}) => message.ready ? resolve() : reject(Error('personal_store_locked')));
            worker.once('error', reject);
            worker.once('exit', code => reject(Error(`personal_store_lock_exit:${code}`)));
        });
    } catch (error) { await worker.terminate(); throw error; }
    // Ownership must not keep an otherwise stopped host process alive.
    worker.unref();
    let released=false;
    return async () => {
        if(released)return;
        released=true;
        worker.ref();
        const exited=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
        worker.postMessage('release');
        await exited;
    };
}
