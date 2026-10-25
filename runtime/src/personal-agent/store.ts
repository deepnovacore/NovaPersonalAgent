import {notificationSchema,type NotificationInput} from '../notifications/contracts.js';
import {conversationSchema,conversationsStateSchema,initialConversations,type ConversationsState} from './conversations.js';
import {Worker} from 'node:worker_threads';
import { z } from 'zod';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparePrivateDatabasePath } from '../storage/private-database.js';
import { feedItemSchema, goalProgressSchema, personalSettingsSchema, type FeedItem, type GoalProgress, type PersonalSettings } from './contracts.js';
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
    goal_progress: GoalProgress[];
    /** Declined goal topics stay suppressed until `until`; separate from preferences. */
    goal_proposal_rejections: {topic_key:string;title:string;rejected_at:string;until:string}[];
    /** `last_run_date` caps runs per local date; `consumed_through` advances only when a run succeeds. */
    goal_proposer: {last_run_date:string|null;consumed_through:string|null;last_outcome:'processing'|'success'|'empty'|'failed'|null};
    /** Goal check-ins per local date (`feed_id` only once a summary is admitted) and when each goal's check-in was last delivered. */
    goal_checkins: {runs:Record<string,{status:'processing'|'success'|'failed'|'empty'|'invalidated'|'delivered';attempts:number;last_attempt_at:string;feed_id:string|null}>;last_at:Record<string,string>};
    settings: PersonalSettings;
    receipts: Record<string, {
        payload: string;
        result: unknown;
    }>;
}
export const initialState = (): PersonalState => ({ notification_task_baseline:[],notification_intents:{},notification_fingerprints:{},notifications_initialized:false,conversations:initialConversations(), user_scope: null, revision: 0, feed: [], dedupe: [], brief_runs: {}, goal_progress: [], goal_proposal_rejections: [], goal_proposer: {last_run_date:null,consumed_through:null,last_outcome:null}, goal_checkins: {runs:{},last_at:{}}, settings: { discovery_enabled: true, discovery_interval_minutes: 30, proactive_daily_cap: 5, news_rank_fallback: true }, receipts: {} });
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
const stateSchema = z.object({ notification_task_baseline:z.array(z.string()).default([]),notification_intents:z.record(z.string(),notificationSchema).default({}),notification_fingerprints:z.record(z.string(),z.string()).default({}),notifications_initialized:z.boolean().default(false),conversations:conversationsStateSchema.default(initialConversations), user_scope: z.string().max(512).nullable(), revision: z.number().int().nonnegative(), feed: z.array(feedItemSchema).max(10000), dedupe: z.array(z.string().max(128)).max(20000), brief_runs:z.record(z.string().max(128),z.object({status:z.enum(['processing','success','failed','empty']),attempts:z.number().int().min(1).max(3),last_attempt_at:z.iso.datetime()})).default({}), goal_progress:z.array(goalProgressSchema).max(200).refine(rows=>new Set(rows.map(r=>r.goal_id)).size===rows.length).default([]), goal_proposal_rejections:z.array(z.object({topic_key:z.string().max(64),title:z.string().max(80),rejected_at:z.iso.datetime(),until:z.iso.datetime()}).strict()).max(200).default([]), goal_proposer:z.object({last_run_date:z.string().date().nullable(),consumed_through:z.iso.datetime().nullable(),last_outcome:z.enum(['processing','success','empty','failed']).nullable()}).strict().default({last_run_date:null,consumed_through:null,last_outcome:null}), goal_checkins:z.object({runs:z.record(z.string().date(),z.object({status:z.enum(['processing','success','failed','empty','invalidated','delivered']),attempts:z.number().int().min(0).max(3),last_attempt_at:z.iso.datetime(),feed_id:z.string().max(128).nullable()}).strict()).refine(r=>Object.keys(r).length<=31),last_at:z.record(z.string().max(512),z.iso.datetime()).refine(r=>Object.keys(r).length<=200)}).strict().default({runs:{},last_at:{}}), settings: personalSettingsSchema, receipts: z.record(z.string().max(128), z.object({ payload: z.string().max(16384), result: z.unknown() })).refine(r => Object.keys(r).length <= 256) }).strict();
const storedStateSchema=stateSchema.extend({conversations:z.object({...conversationsStateSchema.shape,items:z.array(z.union([conversationSchema,conversationSchema.extend({kind:z.literal('proactive')})])).min(1).max(192)}).strict().default(initialConversations)});
function parseStoredState(value:unknown):PersonalState {
    const state=storedStateSchema.parse(value), conversations=state.conversations;
    const legacy=conversations.items.filter(item=>item.kind==='proactive');
    for(const item of legacy){
        // Keep historical messages as ordinary topics; deleting the old navigation must not delete history.
        const retained=item.messages.length>0||item.feed_ids.length>0;
        const id=retained?`history:${item.id}`:'chat:main';
        if(retained&&conversations.items.some(other=>other.id===id))throw Error('legacy_conversation_id_collision');
        if(conversations.selected_id===item.id)conversations.selected_id='chat:main';
        if(conversations.voice_id===item.id)conversations.voice_id='chat:main';
        for(const owners of [conversations.work_owners,conversations.approval_owners])for(const key of Object.keys(owners))if(owners[key]===item.id)owners[key]=id;
        for(const other of conversations.items)if(other.build?.source_conversation_id===item.id)other.build.source_conversation_id=id;
        if(retained)conversations.items=conversations.items.map(other=>other===item?{...item,id,kind:'topic',messages:item.messages.map(message=>({...message,conversation_id:id}))}:other);
        else conversations.items=conversations.items.filter(other=>other!==item);
    }
    return stateSchema.parse(state);
}
export class PersonalStore {
    constructor(readonly path: string) { }
    async ensureScheduleBackup():Promise<void>{
        const path=this.path+'.before-schedules.json'
        // An empty backup (a truncating reset) is treated as missing and recreated below; any other invalid backup still fails.
        let empty=false
        try{const saved=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await saved.stat();if(info.size>MAX_STORE_BYTES||(process.platform!=='win32'&&(info.mode&0o777)!==0o600))throw Error('invalid_schedule_backup');if(info.size===0&&info.isFile())empty=true;else{parseStoredState(JSON.parse(await saved.readFile('utf8')));return}}finally{await saved.close()}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        if(empty)await unlink(path)
        const original=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW)
        let text:string
        try{if((await original.stat()).size>MAX_STORE_BYTES)throw Error('personal_store_capacity');text=await original.readFile('utf8')}finally{await original.close()}
        if(!text)text=JSON.stringify(initialState())
        parseStoredState(JSON.parse(text))
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
            return text === '' ? initialState() : parseStoredState(JSON.parse(text));
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
