import type {SourceChange} from '../memory-substrate/source-state.js'
import type {WakeReason} from '../core/slots.js';
import {dailyBriefSettings,dueDailyBriefs,isQuietTime,type DailyBriefSlot} from './daily-brief.js';
import {markConversationRead,conversationUnreadCount,createConversation, ConversationRuntimePool, type ConversationRuntimeFactory} from './conversations.js';
import type {UnifiedRetrieval,UnifiedRetrievalResult} from '../memory/retrieval.js';
import {validateMemoryOverview, type MemoryOverview} from './memory-overview.js';
import type { ContextView } from '../core/context-view.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PersonalMemoryResource } from '../memory/personal-memory.js';
import type { MemoryEntry } from '../memory/entry.js';
import { memoryRefSchema } from '../core/memory.js';
import type { Suggestion, SuggestionPool } from '../core/suggestions.js';
import { personalCommandSchema, personalSettingsSchema, preparedContentSchema, proposalSchema, versionSchema, type PreparedMaterial, type Proposal, type FeedItem } from './contracts.js';
import { PersonalStore, acquirePersonalLock, initialState, type PersonalState } from './store.js';
export interface Evidence {
    subject_key: string;
    source: FeedItem['source'];
    task_ref?: {
        work_id: string;
    };
}
export interface DiscoverySnapshot {
    context?: ContextView;
    retrieval?: UnifiedRetrievalResult;
    user_scope: string;
    local_date: string;
    weekday: string;
    timezone: string;
    memory: MemoryEntry[];
    evidence_refs: string[];
    recent_delivery: FeedItem[];
}
export interface PersonalSources {
    list(): unknown[];
    command(method: string, params: unknown): Promise<unknown>;
    evidence?(ref: string): Evidence | null;
    evidenceSnapshot?(): {
        ref: string;
        summary: string;
    }[];
    open?(): Promise<void>;
    close?(): Promise<void>;
}
export interface PersonalFeishu {
    snapshot(): unknown;
    command(method: string, params: unknown): Promise<unknown>;
    open(): Promise<void>;
    close(): Promise<void>;
}
export interface HostOptions {
    context?: () => ContextView;
    path: string;
    userScope: string;
    memory: () => PersonalMemoryResource | undefined;
    pool: SuggestionPool;
    evidence: (ref: string) => Evidence | null;
    discover?: (snapshot: DiscoverySnapshot, signal: AbortSignal) => Promise<Proposal | null>;
    prepareBrief?: (snapshot:DiscoverySnapshot,slot:DailyBriefSlot,signal:AbortSignal)=>Promise<PreparedMaterial|null>;
    prepareProposal?: (snapshot:DiscoverySnapshot,proposal:Proposal,signal:AbortSignal)=>Promise<PreparedMaterial|null>;
    summarizeMemory?: (entries: readonly MemoryEntry[], signal: AbortSignal) => Promise<MemoryOverview | null>;
    evidenceRefs?: () => string[];
    onTick?: (snapshot: DiscoverySnapshot) => void;
    act?: (item: FeedItem) => Promise<void>;
    now?: () => Date;
}
const hash = (s: unknown): string => createHash('sha256').update(JSON.stringify(s)).digest('hex');
export class PersonalAgentHost {
    #voiceTransition=false;
    #clearingConversations=new Set<string>();
    #conversationEmit:((frame:Record<string,unknown>)=>void)|undefined;
    #conversationRuns=new Map<string,Promise<void>>();
    waitConversation(id:string):Promise<void>{return this.#conversationRuns.get(id)??Promise.resolve()}
    #conversationPool: ConversationRuntimePool | undefined;
    setConversationRuntime(factory:ConversationRuntimeFactory,emit:(frame:Record<string,unknown>)=>void):void {
        this.#conversationEmit=emit;
        this.#conversationPool=new ConversationRuntimePool(factory,frame=>{emit(frame);void this.#persistConversationFrame(frame).catch(()=>{ /* retry via next snapshot */ })});
    }
    async #persistConversationFrame(frame:Record<string,unknown>):Promise<void>{
        const background=frame.type==='conversation.completed';
        const voice=(frame.type==='caption'&&frame.role==='user')||frame.type==='conversation.delivered'||frame.type==='conversation.generated';
        if((!background&&!voice)||frame.final!==true||typeof frame.text!=='string'||!frame.text.trim()||typeof frame.conversation_id!=='string')return;
        if(!background&&this.#state.conversations.voice_id!==frame.conversation_id)return;
        await this.#serial(async()=>{const next=structuredClone(this.#state),item=next.conversations.items.find(item=>item.id===frame.conversation_id);if(!item)return;
            const turn=typeof frame.turn_id==='string'?frame.turn_id:randomUUID();const previous=item.messages.find(message=>message.turn_id===turn);
            const delivery=frame.delivery==='generated'||frame.delivery==='interrupted'?frame.delivery:'completed';
            if(previous){if(frame.type!=='conversation.delivered'&&!(frame.type==='conversation.completed'&&turn.startsWith('task:')))return;previous.delivery=delivery;previous.text=String(frame.text).slice(0,16000)}
            else item.messages.push({id:randomUUID(),conversation_id:item.id,role:frame.role==='user'?'user':'assistant',text:String(frame.text).slice(0,16000),created_at:this.#now().toISOString(),turn_id:turn,delivery});
            item.messages=item.messages.slice(-512);await this.#commit(next);
        });
    }

    conversationSnapshot(){const c=this.#state.conversations;return {selected_id:c.selected_id,voice_id:c.voice_id,unread_count:c.items.reduce((count,item)=>count+conversationUnreadCount(item),0),items:c.items.map(item=>({id:item.id,kind:item.kind,unread_count:conversationUnreadCount(item),title:item.title,subject_key:item.subject_key,created_at:item.created_at,updated_at:item.updated_at,generation:item.generation})),messages:structuredClone(c.items.find(item=>item.id===c.selected_id)?.messages??[])}}
    async submitConversationText(id:string,text:string,requestId?:string):Promise<void>{
        if(!this.#conversationPool)throw Error('conversation_runtime_unavailable');
        let conversation=this.#state.conversations.items.find(item=>item.id===id);
        if(!conversation)throw Error('conversation_not_found');
        if(this.#clearingConversations.has(id))throw Error('conversation_clearing');
        if(this.#state.conversations.voice_id===id||this.#voiceTransition)throw Error('voice_active');
        if(!this.#conversationPool.acceptsText(id))throw Error('conversation_busy');
        if(requestId&&conversation.messages.some(message=>message.request_id===requestId))return;
        const userMessageId=randomUUID();
        await this.#serial(async()=>{const next=structuredClone(this.#state);const item=next.conversations.items.find(item=>item.id===id)!;if(this.#clearingConversations.has(id))throw Error('conversation_clearing');if(requestId&&item.messages.some(message=>message.request_id===requestId))return;item.messages.push({id:userMessageId,conversation_id:id,role:'user',generation_status:'pending',text,created_at:this.#now().toISOString(),...(requestId?{request_id:requestId}:{})});item.messages=item.messages.slice(-512);item.updated_at=this.#now().toISOString();await this.#commit(next)});
        conversation=this.#state.conversations.items.find(item=>item.id===id)!;
        if(!conversation.messages.some(message=>message.id===userMessageId))return;
        const generation=conversation.generation;
        const operation=this.#conversationPool.run(conversation,text).then(result=>this.#serial(async()=>{const next=structuredClone(this.#state);const item=next.conversations.items.find(item=>item.id===id)!;if(item.generation!==generation)return;const admitted=item.messages.find(message=>message.id===userMessageId);if(admitted)admitted.generation_status='completed';item.messages.push({id:randomUUID(),conversation_id:id,role:'assistant',reply_to:userMessageId,text:result.assistant.slice(0,16000),created_at:this.#now().toISOString(),...(result.turn_id?{turn_id:result.turn_id}:{})});item.messages=item.messages.slice(-512);await this.#commit(next)})).catch(async(error:unknown)=>{if(!this.#opened||this.#clearingConversations.has(id))return;await this.#serial(async()=>{const next=structuredClone(this.#state),item=next.conversations.items.find(item=>item.id===id);if(item?.generation!==generation)return;const admitted=item.messages.find(message=>message.id===userMessageId);if(!admitted)return;admitted.generation_status=error instanceof Error&&/conversation_(?:cleared|closed)/u.test(error.message)?'interrupted':'failed';await this.#commit(next)});this.#conversationEmit?.({type:'conversation.error',conversation_id:id,error:'response_failed'})});
        this.#conversationRuns.set(id,operation);
        void operation.catch(()=>{this.#conversationEmit?.({type:'conversation.error',conversation_id:id,error:'status_persistence_failed'})});
    }
    conversationService(id:string){return this.#conversationPool?.service(id)}
    workConversation(id:string){return this.#conversationPool?.workConversation(id)??this.#state.conversations.work_owners[id]}
    rememberWorkOwner(id:string,conversationId:string,approvalId?:string):Promise<void>{return this.#serial(async()=>{const next=structuredClone(this.#state);if(!next.conversations.items.some(item=>item.id===conversationId))return;next.conversations.work_owners[id]=conversationId;if(approvalId)next.conversations.approval_owners[approvalId]=conversationId;for(const owners of [next.conversations.work_owners,next.conversations.approval_owners])for(const key of Object.keys(owners).slice(0,-1024))delete owners[key];await this.#commit(next)})}
    voiceService(){const id=this.#state.conversations.voice_id;return id?this.#conversationPool?.service(id):undefined}
    async sendConversationAudio(id:string,pcm:Uint8Array):Promise<void>{if(this.#state.conversations.voice_id!==id)throw Error('voice_not_owned');await this.#conversationPool?.sendAudio(id,pcm)}
    async #conversationCommand(method:string,p:Record<string,unknown>):Promise<unknown>{
        if(method==='conversations.voice'){const q=z.object({id:z.string(),enabled:z.boolean()}).strict().parse(p);const c=this.#state.conversations;const item=c.items.find(item=>item.id===q.id);if(!item)throw Error('conversation_not_found');if(q.enabled){if(c.voice_id&&c.voice_id!==q.id)throw Error('voice_active');if(c.voice_id===q.id)return this.conversationSnapshot();if(!this.#conversationPool)throw Error('voice_unavailable');this.#voiceTransition=true;try{await this.#conversationPool.startVoice(item)}finally{this.#voiceTransition=false}}else{if(c.voice_id!==q.id)throw Error('voice_not_owned');await this.#conversationPool?.stopVoice(q.id)}await this.#serial(async()=>{const next=structuredClone(this.#state);next.conversations.voice_id=q.enabled?q.id:null;await this.#commit(next)});return this.conversationSnapshot()}
        if(method==='conversations.clear'){const q=z.object({id:z.string(),expected_generation:z.number().int().optional()}).strict().parse(p);const item=this.#state.conversations.items.find(item=>item.id===q.id);if(!item)throw Error('conversation_not_found');if(q.expected_generation!==undefined&&item.generation!==q.expected_generation)throw Error('generation_conflict');if(this.#state.conversations.voice_id===q.id)throw Error('voice_active');this.#clearingConversations.add(q.id);try{await this.#conversationPool?.clear(q.id);await this.#serial(async()=>{const next=structuredClone(this.#state);const target=next.conversations.items.find(item=>item.id===q.id)!;target.messages=[];target.read_through_id=null;target.generation++;target.prepared=null;await this.#commit(next)});}finally{this.#clearingConversations.delete(q.id)}return this.conversationSnapshot()}
        if(method==='conversations.open_feed'){const feed=this.#state.feed.find(f=>f.id===p.feed_id);const item=feed?this.#state.conversations.items.find(c=>c.feed_ids.includes(feed.id)||c.kind==='topic'&&c.subject_key===feed.subject_key):undefined;if(item&&JSON.stringify(item.prepared)!==JSON.stringify(feed?.prepared)){if(this.#state.conversations.voice_id===item.id)throw Error('voice_active');await this.#conversationPool?.clear(item.id)}}
        return this.#serial(async()=>{const next=structuredClone(this.#state),c=next.conversations;
            if(method==='conversations.create'){const q=z.object({title:z.string().min(1).max(120).optional()}).strict().parse(p);if(c.items.length>=128)throw Error('conversation_limit');const item=createConversation('chat',q.title??'新对话');c.items.push(item);c.selected_id=item.id}
            else if(method==='conversations.read'){const q=z.object({id:z.string(),through_message_id:z.string()}).strict().parse(p);const item=c.items.find(item=>item.id===q.id);if(!item)throw Error('conversation_not_found');markConversationRead(item,q.through_message_id)}
            else if(method==='conversations.select'){const q=z.object({id:z.string()}).strict().parse(p);if(!c.items.some(item=>item.id===q.id))throw Error('conversation_not_found');c.selected_id=q.id}
            else if(method==='conversations.open_feed'){const q=z.object({feed_id:z.string(),label:z.string().min(1).max(120).optional()}).strict().parse(p);const feed=next.feed.find(item=>item.id===q.feed_id);if(!feed)throw Error('feed_not_found');if(feed.lifecycle!=='active'||feed.user_state==='dismissed'||(feed.expires_at&&Date.parse(feed.expires_at)<=this.#now().getTime())||!await this.#valid(feed))throw Error('stale');let item=c.items.find(item=>item.feed_ids.includes(feed.id)||item.kind==='topic'&&item.subject_key===feed.subject_key);if(!item){if(c.items.length>=128)throw Error('conversation_limit');item=createConversation('topic',feed.title,feed.subject_key);c.items.push(item)}const prepared=feed.prepared??{trust:'untrusted_external' as const,text:feed.why_now.slice(0,12000),evidence_refs:feed.evidence_refs.slice(0,16)};if(JSON.stringify(item.prepared)!==JSON.stringify(prepared)){if(c.voice_id===item.id)throw Error('voice_active');if(!await this.#valid(feed))throw Error('stale');item.prepared=structuredClone(prepared)}if(!item.feed_ids.includes(feed.id))item.feed_ids.push(feed.id);c.selected_id=item.id}
            else throw Error('unsupported');await this.#commit(next);return this.conversationSnapshot();
        });
    }
    #retrieval:UnifiedRetrieval|undefined;
    #prefetched:{query:string;result:UnifiedRetrievalResult;at:number}|undefined;
    setRetrieval(retrieval:UnifiedRetrieval):void{this.#retrieval=retrieval}
    setPrefetchedRetrieval(query:string,result:UnifiedRetrievalResult):void{this.#prefetched={query,result:structuredClone(result),at:this.#now().getTime()}}
    #commands: Promise<unknown> = Promise.resolve();
    #pendingCommands = 0;
    #release: (() => Promise<void>) | undefined;
    readonly #store: PersonalStore;
    #state: PersonalState = initialState();
    #includeExpired=false;
    #memory: {
        include_expired?: boolean;
        entries: MemoryEntry[];
        cursor: string | null;
        overview?: MemoryOverview | null;
    } = { entries: [], cursor: null };
    #sources: PersonalSources | undefined;
    #feishu: PersonalFeishu | undefined;
    #connectors: PersonalFeishu | undefined;
    #listeners = new Set<() => void>();
    #tail: Promise<unknown> = Promise.resolve();
    #timer: ReturnType<typeof setInterval> | undefined;
    #abort = new AbortController();
    #discovery: Promise<void> | undefined;
    #briefing: Promise<void> | undefined;
    #nextDiscovery=0;
    #opened = false;
    #sourceSignature = '';
    #sourcePending={invalidated:0,ready:new Set<number>(),legacy:false};
    #sourceSeen={invalidated:0,ready:new Set<number>()};
    #sourceDrain:Promise<void>|null=null;
    #projectionRevision = 0;
    #memoryRefresh = 0;
    #overviewKey = '';
    #overviewRun: Promise<void> | undefined;
    #overviewAbort = new AbortController();
    #overviewCache: {key:string; value:MemoryOverview} | undefined;
    #notify(): void { this.#projectionRevision = Math.max(this.#projectionRevision, this.#state.revision) + 1; for (const listener of this.#listeners) { try { listener(); } catch { /* observer only */ } } }
    #invalidateOverview(): void {
        this.#memoryRefresh++;
        this.#overviewKey = '';
        this.#overviewAbort.abort();
        this.#memory.overview = null;
        this.#notify();
    }
    #summarize(): void {
        if (this.#overviewRun || !this.#opened || !this.options.summarizeMemory || !this.#overviewKey) return;
        const key = this.#overviewKey, generation = this.#memoryRefresh;
        const entries = structuredClone(this.#memory.entries.filter(e => e.status === 'active' && e.version !== null));
        if (!entries.length) return;
        const controller = new AbortController();
        this.#overviewAbort = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        const run = (async () => {
            let value: MemoryOverview|null = null;
            try {
                const result = await Promise.race([
                    this.options.summarizeMemory!(entries, signal),
                    new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), {once:true})),
                ]);
                value = validateMemoryOverview(result, entries);
            } catch { /* optional summary: keep source entries available */ }
            if (!this.#opened || key !== this.#overviewKey || controller.signal.aborted) return;
            if (signal.aborted) value = null;
            if (value) this.#overviewCache = {key,value};
            this.#memory.overview = value;
            this.#notify();
        })();
        this.#overviewRun = run;
        void run.finally(() => { this.#overviewRun = undefined; if (generation !== this.#memoryRefresh && this.#overviewCache?.key !== this.#overviewKey) this.#summarize(); });
    }
    constructor(readonly options: HostOptions) { this.#store = new PersonalStore(options.path); }
    get path(): string { return this.options.path; }
    connectionChanged(): void { this.#notify(); }
    setConnectors(connectors: PersonalFeishu): void { this.#connectors = connectors; }
    setFeishu(feishu: PersonalFeishu): void { this.#feishu = feishu; }
    setSources(sources: PersonalSources): void { this.#sources = sources; }
    subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
    #now(): Date { return this.options.now?.() ?? new Date(); }
    #serial<T>(fn: () => Promise<T>): Promise<T> { const run = this.#tail.then(fn); this.#tail = run.catch(() => { /* optional observer or cleanup already reported */ }); return run; }
    async open(): Promise<void> {
        if (this.#opened) return;
        this.#release = await acquirePersonalLock(this.options.path);
        try {
            this.#state = await this.#store.read();
            this.#state.conversations.voice_id=null;
            if (this.#state.user_scope !== null && this.#state.user_scope !== this.options.userScope) throw Error('scope_mismatch');
            this.#state.user_scope = this.options.userScope;
            let recovered=false;for(const conversation of this.#state.conversations.items)for(const message of conversation.messages)if(message.generation_status==='pending'){message.generation_status='interrupted';recovered=true;}
            if(recovered){this.#state.revision++;await this.#store.write(this.#state);}

            this.#abort = new AbortController();
            this.#opened = true;
            await this.#sources?.open?.();
            await this.#feishu?.open();
            await this.#connectors?.open();
            await this.refreshMemory();
            await this.revalidate();
            for (const item of this.#state.feed) {
                if (item.lifecycle === 'active' && item.user_state !== 'dismissed' && (!item.snooze_until || Date.parse(item.snooze_until) <= this.#now().getTime())) this.#pool(item);
            }
            this.#schedule();
        } catch (error) {
            await this.close().catch(() => { /* preserve primary lifecycle failure */ });
            throw error;
        }
    }
    async close(): Promise<void> {
        await this.#conversationPool?.close();
        this.#opened = false;
        this.#prefetched=undefined;
        this.#invalidateOverview();
        this.#overviewCache = undefined;
        clearInterval(this.#timer);
        this.#abort.abort();
        for (const item of this.#state.feed) if (item.suggestion_id) this.options.pool.withdraw(item.suggestion_id);
        try {
            await this.#connectors?.close().catch(() => { /* connector shutdown cannot block remaining resources */ });
            await this.#feishu?.close().catch(() => { /* optional connector failure must not prevent runtime shutdown */ });
            await this.#sources?.close?.();
            await this.#briefing?.catch(()=>{/* aborted preparation */});
            await this.#discovery?.catch(() => { /* preserve primary lifecycle failure */ });
            await this.#commands;
            await this.#tail;
        } finally {
            const release=this.#release;
            this.#release=undefined;
            await release?.();
        }
    }
    #schedule(): void {
        clearInterval(this.#timer);
        const settings=dailyBriefSettings(this.#state.settings);
        this.#nextDiscovery=this.#now().getTime()+this.#state.settings.discovery_interval_minutes*60000;
        if(this.#opened&&(this.#state.settings.discovery_enabled||settings.briefing_outlook_enabled||settings.briefing_review_enabled)){
            this.#timer=setInterval(()=>{void this.scheduledTick().catch(()=>{/* next tick remains available */})},60000);
            this.#timer.unref();
        }
    }
    async scheduledTick():Promise<void>{
        if(!this.#opened)return;
        if(this.#now().getTime()>=this.#nextDiscovery){this.#nextDiscovery=this.#now().getTime()+this.#state.settings.discovery_interval_minutes*60000;void this.discover().catch(()=>{/* optional discovery */})}
        if(this.#briefing)return this.#briefing;
        const run=this.#runBriefs();this.#briefing=run;
        try{await run}finally{if(this.#briefing===run)this.#briefing=undefined}
    }
    async #claim(key:string):Promise<boolean>{return this.#serial(async()=>{
        if(!this.#opened||this.#state.dedupe.includes(key))return false;
        const next=structuredClone(this.#state);next.dedupe.push(key);await this.#commit(next);return true;
    })}
    async #prepare(call:(signal:AbortSignal)=>Promise<PreparedMaterial|null>,snapshot:DiscoverySnapshot):Promise<PreparedMaterial|null>{
        const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(30000)]);
        let cancel:()=>void=()=>{/* listener assigned below */};
        try{
            const raw=await Promise.race([call(signal),new Promise<null>(resolve=>{cancel=()=>resolve(null);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()})]);
            if(signal.aborted||!this.#opened||!raw)return null;
            const parsed=z.object({prepared:preparedContentSchema,action_label:z.string().trim().min(1).max(80),memory_refs:z.array(z.object({entry_id:z.string(),version:versionSchema}).strict()).max(16)}).strict().safeParse(raw);
            if(!parsed.success)return null;
            const value=parsed.data,refs={evidence_refs:value.prepared.evidence_refs,memory_refs:value.memory_refs};
            if(!refs.evidence_refs.length&&!refs.memory_refs.length||refs.evidence_refs.some(r=>!snapshot.evidence_refs.includes(r))||refs.memory_refs.some(r=>!snapshot.memory.some(m=>m.id===r.entry_id&&m.version===r.version))||!await this.#valid(refs))return null;
            return value;
        }catch{return null}finally{signal.removeEventListener('abort',cancel)}
    }
    async #runBriefs():Promise<void>{
        if(!this.options.prepareBrief)return;
        for(const slot of dueDailyBriefs(this.#state.settings,this.#now(),this.#state.dedupe)){
            if(!await this.#claim(slot.dedupe_key))continue;
            const controller=this.#abort,snapshot=await this.discoverySnapshot();
            const prepared=await this.#prepare(signal=>this.options.prepareBrief!(snapshot,slot,signal),snapshot);
            if(!prepared||controller.signal.aborted||!dueDailyBriefs(this.#state.settings,this.#now(),[]).some(s=>s.dedupe_key===slot.dedupe_key))continue;
            await this.#admit({kind:'notify',summary:slot.kind==='outlook'?'今日前瞻':'今日回顾',why_now:slot.kind==='outlook'?'根据当前可用信息准备的今日前瞻':'根据当前可用信息准备的今日回顾',evidence_refs:prepared.prepared.evidence_refs,memory_refs:prepared.memory_refs},snapshot,prepared,slot.dedupe_key);
        }
    }
    async refreshMemory(cursor?: string, limit = 100, includeExpired=this.#includeExpired): Promise<void> {
        this.#includeExpired=includeExpired;
        this.#invalidateOverview();
        const refresh = this.#memoryRefresh, memory = this.options.memory();
        const page = memory?.list ? await memory.list({ ...(cursor ? { cursor } : {}), limit,...(includeExpired?{include_expired:true}:{}) }) : {entries: [], cursor: null};
        if (refresh !== this.#memoryRefresh || !this.#opened) return;
        const key = hash(page);
        this.#overviewAbort.abort();
        this.#overviewKey = key;
        this.#memory = {...page, include_expired:includeExpired, overview: this.#overviewCache?.key === key ? this.#overviewCache.value : null};
        this.#notify();
        if (this.#overviewCache?.key !== key) this.#summarize();
    }
    snapshot() { const m = this.options.memory(); return { type: 'personal.state' as const, revision: Math.max(this.#projectionRevision, this.#state.revision), conversations:this.conversationSnapshot(), feed: structuredClone(this.#state.feed), memory: structuredClone(this.#memory), sources: this.#sources?.list() ?? [], feishu: this.#feishu?.snapshot() ?? null, connectors: this.#connectors?.snapshot() ?? null, capabilities: { memory: { list: !!m?.list, get: !!m?.get, correct: !!m?.correct, forgetEntry: !!m?.forgetEntry, forgetSource: !!m?.forgetSource }, discovery: !!this.options.discover, sources: !!this.#sources }, settings: { ...this.#state.settings,...dailyBriefSettings(this.#state.settings) } }; }
    async #commit(next: PersonalState): Promise<void> { next.revision = this.#state.revision + 1; await this.#store.write(next); this.#state = next; this.#notify(); }
    async #evidence(ref: string): Promise<Evidence|null> {
        const direct=this.options.evidence(ref)??this.#sources?.evidence?.(ref);if(direct)return direct
        if(!this.#retrieval)return null
        const result=await this.#retrieval.evidence(ref,{signal:this.#abort.signal});const row=result.evidence;if(result.state!=='ok'||!row)return null
        const type:FeedItem['source']['type']=row.source_kind==='task_result'?'task':['file','mail','calendar','im'].includes(row.source_kind)?row.source_kind as FeedItem['source']['type']:'conversation'
        return {subject_key:'evidence:'+row.source_kind+':'+hash(row.locator),source:{type,ref:row.evidence_id}}
    }
    async #valid(p: Pick<Proposal, 'memory_refs' | 'evidence_refs'>): Promise<boolean> { for (const ref of p.evidence_refs)
        if (!await this.#evidence(ref))
            return false; for (const ref of p.memory_refs) {
        const entry = await this.options.memory()?.get?.(ref.entry_id);
        if (entry?.status !== 'active' || entry.version !== ref.version || (entry.commitment !== undefined && entry.commitment.status !== 'open'))
            return false;
    } return true; }
    async discoverySnapshot(): Promise<DiscoverySnapshot> {
        await this.refreshMemory();const now=this.#now(),timezone=dailyBriefSettings(this.#state.settings).timezone,memory=this.options.memory(),context=this.options.context?.();let relevant=this.#memory.entries
        const query=context?.channels.find(c=>c.name==='conversation')?.recent.map(i=>typeof i.content.text==='string'?i.content.text:'').filter(Boolean).slice(-1)[0]??now.toLocaleDateString('en-CA')
        let retrieval:UnifiedRetrievalResult|undefined
        if(this.#retrieval){
            const cached=this.#prefetched?.query===query&&now.getTime()-this.#prefetched.at>=0&&now.getTime()-this.#prefetched.at<30000
            retrieval=cached?structuredClone(this.#prefetched!.result):await this.#retrieval.recall(query,{scope:'any',limit:8,signal:this.#abort.signal})
            if(cached){const current=await Promise.all(retrieval.snippets.map(row=>this.#retrieval!.evidence(row.evidence_id,{signal:this.#abort.signal})));retrieval.snippets=current.flatMap(result=>result.evidence?[{...result.evidence,text:result.evidence.text.slice(0,300)}]:[])}
            if(memory?.get){const hits=await Promise.all(retrieval.entries.map(async ref=>{const row=await memory.get!(ref.entry_id);return row?.version===ref.revision?row:null}));relevant=[...hits.filter((e):e is MemoryEntry=>e!==null),...relevant];retrieval.entries=retrieval.entries.filter(ref=>hits.some(hit=>hit?.id===ref.entry_id&&hit.version===ref.revision&&hit.status==='active'&&(hit.commitment===undefined||hit.commitment.status==='open')))}else{retrieval.entries=[]}
        }else if(memory?.get&&typeof memory.recall==='function'){
            const recalled=await memory.recall(query,{scope:'recent',limit:8,signal:AbortSignal.any([this.#abort.signal,AbortSignal.timeout(5000)])});const hits=await Promise.all(recalled.hits.slice(0,8).map(hit=>memory.get!(hit.memoryId)));relevant=[...hits.filter((e):e is MemoryEntry=>e!==null),...relevant]
        }
        relevant=relevant.filter((e,i,all)=>all.findIndex(a=>a.id===e.id)===i)
        return {...(context?{context}:{}),...(retrieval?{retrieval}:{}),user_scope:this.options.userScope,local_date:now.toLocaleDateString('en-CA',{timeZone:timezone}),weekday:now.toLocaleDateString('en-US',{weekday:'long',timeZone:timezone}),timezone,memory:relevant.filter(e=>e.status==='active'&&e.version!==null&&(e.commitment===undefined||e.commitment.status==='open')).slice(0,16),evidence_refs:[...new Set([...(this.options.evidenceRefs?.()??[]),...(this.#sources?.evidenceSnapshot?.()??[]).map(item=>item.ref),...(retrieval?.snippets??[]).map(item=>item.evidence_id)])].slice(-16),recent_delivery:this.#state.feed.filter(f=>Object.values(f.delivery).some(Boolean)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,8)}
    }
    discover(): Promise<void> { if (this.#discovery)
        return this.#discovery; if (!this.#opened || !this.#state.settings.discovery_enabled || !this.options.discover)
        return Promise.resolve(); const controller=this.#abort; const run = (async () => { await this.revalidate(); const snapshot = await this.discoverySnapshot(); this.options.onTick?.(snapshot); if(snapshot.memory.length===0&&snapshot.evidence_refs.length===0)return; const proposal = await this.options.discover!(snapshot, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])); if (proposal && !controller.signal.aborted && this.#opened && this.#state.settings.discovery_enabled)
        await this.admit(proposal, snapshot); })(); this.#discovery = run; void run.finally(() => { if (this.#discovery === run)
        this.#discovery = undefined; }).catch(() => { /* optional observer or cleanup already reported */ }); return run; }
    async admit(input:unknown,snapshot:DiscoverySnapshot):Promise<'admitted'|'rejected'|'suppressed_duplicate'>{
        const parsed=proposalSchema.safeParse(input);if(!parsed.success)return 'rejected';
        if(!this.options.prepareProposal)return this.#admit(input,snapshot);
        const proposal=parsed.data;
        if(snapshot.user_scope!==this.options.userScope||proposal.evidence_refs.some(r=>!snapshot.evidence_refs.includes(r))||proposal.memory_refs.some(r=>!snapshot.memory.some(m=>m.id===r.entry_id&&m.version===r.version))||!await this.#valid(proposal))return 'rejected';
        const entities=await Promise.all(proposal.evidence_refs.map(ref=>this.#evidence(ref)));
        const subject=entities.filter((e):e is Evidence=>e!==null).sort((a,b)=>Number(b.task_ref!==undefined)-Number(a.task_ref!==undefined)||a.subject_key.localeCompare(b.subject_key))[0]?.subject_key??proposal.memory_refs.map(r=>'memory:'+r.entry_id).sort()[0];
        const key=hash(['prepare',this.options.userScope,proposal.kind,subject,snapshot.local_date]);
        if(!await this.#claim(key))return 'suppressed_duplicate';
        const controller=this.#abort,prepared=await this.#prepare(signal=>this.options.prepareProposal!(snapshot,proposal,signal),snapshot);
        if(controller.signal.aborted||!this.#opened)return 'rejected';
        const evidence_refs=[...new Set([...proposal.evidence_refs,...(prepared?.prepared.evidence_refs??[])])];
        const memory_refs=[...proposal.memory_refs,...(prepared?.memory_refs??[])].filter((r,i,all)=>all.findIndex(x=>x.entry_id===r.entry_id&&x.version===r.version)===i);
        return this.#admit({...proposal,evidence_refs,memory_refs},snapshot,prepared??undefined);
    }
    async #admit(input: unknown, snapshot: DiscoverySnapshot,prepared?:PreparedMaterial,briefKey?:string): Promise<'admitted' | 'rejected' | 'suppressed_duplicate'> { return this.#serial(async () => { const parsed = proposalSchema.safeParse(input); if (!parsed.success || snapshot.user_scope !== this.options.userScope)
        return 'rejected'; const p = parsed.data; if (p.evidence_refs.some(r => !snapshot.evidence_refs.includes(r)) || p.memory_refs.some(r => !snapshot.memory.some(m => m.id === r.entry_id && m.version === r.version)) || !await this.#valid(p))
        return 'rejected'; const resolved=await Promise.all(p.evidence_refs.map(r=>this.#evidence(r)));if(resolved.some(e=>e===null))return 'rejected';const entities = resolved.filter((e):e is Evidence=>e!==null).filter(e => e.task_ref!==undefined || e.source.type !== 'conversation').sort((a,b)=>Number(b.task_ref!==undefined)-Number(a.task_ref!==undefined)||a.subject_key.localeCompare(b.subject_key));
        const memorySubjects=p.memory_refs.map(r=>'memory:'+r.entry_id).sort();
        const primary = entities[0] ?? (p.memory_refs[0] ? {subject_key:memorySubjects[0]!,source:{type:'memory' as const,ref:p.memory_refs[0].entry_id}} : await this.#evidence([...p.evidence_refs].sort()[0]!));if(!primary)return 'rejected';
        const subject = briefKey ?? (primary.subject_key || hash([...p.evidence_refs].sort()));
        const keyFor=(subjectKey:string)=>hash([this.options.userScope,p.kind,subjectKey,snapshot.local_date]);
        const key=keyFor(subject);
        if([subject,...(briefKey?[]:entities.length>0?entities.map(e=>e.subject_key):memorySubjects)].some(candidate=>this.#state.dedupe.includes(keyFor(candidate)))) return 'suppressed_duplicate'; const now = this.#now(); const item: FeedItem = { ...(prepared?{prepared:prepared.prepared,action_label:prepared.action_label}:{}), id: randomUUID(), kind: p.kind, title: p.summary.slice(0, 120), why_now: p.why_now, evidence_refs: p.evidence_refs, memory_refs: p.memory_refs, source: primary.source, subject_key: subject, task_ref: entities[0]?.task_ref ?? null, suggestion_id: null, priority: 40, created_at: now.toISOString(), updated_at: now.toISOString(), expires_at: new Date(now.getTime() + 86400000).toISOString(), user_state: 'new', snooze_until: null, lifecycle: 'active', delivery: { presented_at: null, notified_at: null, spoken_at: null } }; const next = structuredClone(this.#state); next.feed.push(item); const proactive=next.conversations.items.find(c=>c.kind==='proactive')!;proactive.messages.push({id:'feed:'+item.id,conversation_id:proactive.id,role:'assistant',text:(item.title+'\n'+(item.prepared?.text??item.why_now)).slice(0,16000),created_at:item.created_at});proactive.messages=proactive.messages.slice(-512);proactive.updated_at=item.created_at;next.dedupe.push(key); await this.#commit(next); this.#pool(item); return 'admitted'; }); }
    #pool(item: FeedItem): void { const suggestion = this.options.pool.add({ origin: 'surrogate', kind: item.kind === 'question' ? 'question' : 'notify', content: { summary: item.title, why_now: item.why_now, personal_feed_id: item.id }, evidence_refs: item.evidence_refs.filter(r => memoryRefSchema.safeParse(r).success), salience: 40, expires_at: Date.parse(item.expires_at!) / 1000 }); item.suggestion_id = suggestion.id; }
    async revalidate(): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); let changed = false; for (const item of next.feed) {
        if (item.lifecycle !== 'active')
            continue;
        if ((item.expires_at && Date.parse(item.expires_at) <= this.#now().getTime()) || !await this.#valid(item)) {
            item.lifecycle = 'invalidated';
            item.updated_at = this.#now().toISOString();
            if (item.suggestion_id)
                this.options.pool.withdraw(item.suggestion_id);
            changed = true;
        }
    } if (changed)
        await this.#commit(next); }); }
    async invalidateEvidence(ref: string): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); for (const item of next.feed)
        if (item.evidence_refs.includes(ref) && item.lifecycle === 'active') {
            item.lifecycle = 'invalidated';
            item.updated_at = this.#now().toISOString();
            if (item.suggestion_id)
                this.options.pool.withdraw(item.suggestion_id);
        } await this.#commit(next); }); }
    sourceChanged(change?:SourceChange):Promise<void>{
        if(change){const q=z.object({revision:z.number().int().positive(),phase:z.enum(['invalidated','ready'])}).strict().parse(change);if(q.phase==='invalidated')this.#sourcePending.invalidated=Math.max(this.#sourcePending.invalidated,q.revision);else if(!this.#sourceSeen.ready.has(q.revision))this.#sourcePending.ready.add(q.revision)}else this.#sourcePending.legacy=true;
        if(this.#sourceDrain)return this.#sourceDrain;
        const work=Promise.resolve().then(async()=>{
            while(this.#sourcePending.legacy||this.#sourcePending.invalidated>this.#sourceSeen.invalidated||this.#sourcePending.ready.size){
                const next={...this.#sourcePending,ready:[...this.#sourcePending.ready]};this.#sourcePending.legacy=false;
                try{
                    await this.refreshMemory();await this.revalidate();await this.#serial(()=>this.#commit(structuredClone(this.#state)));
                    if(next.legacy||next.ready.length){
                        const signature=hash({refs:(this.#sources?.evidenceSnapshot?.()??[]).map(item=>item.ref).sort(),revision:next.ready});
                        if(signature!==this.#sourceSignature){await this.discover();this.#sourceSignature=signature;}
                    }
                    this.#sourceSeen.invalidated=Math.max(this.#sourceSeen.invalidated,next.invalidated);
                    for(const revision of next.ready){this.#sourceSeen.ready.add(revision);this.#sourcePending.ready.delete(revision);}
                    // ponytail: retain 2048 duplicate receipts in memory; durable acknowledgements cover older delivery.
                    while(this.#sourceSeen.ready.size>2048)this.#sourceSeen.ready.delete(this.#sourceSeen.ready.values().next().value!);
                }catch(error){this.#sourcePending.legacy ||= next.legacy;throw error;}
            }
        }).finally(()=>{this.#sourceDrain=null;});
        this.#sourceDrain=work;return work;
    }
    async taskResult(workId: string, title: string): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); const owner=next.conversations.items.find(c=>c.id===next.conversations.work_owners[workId]);let item = next.feed.find(f => f.task_ref?.work_id === workId)??next.feed.find(f=>owner?.feed_ids.includes(f.id)&&f.task_ref===null); if (!item) {
        const now = this.#now().toISOString();
        item = { id: randomUUID(), kind: 'task_result', title: '', why_now: '任务已有结果', evidence_refs: [], memory_refs: [], source: { type: 'task', ref: workId }, task_ref: { work_id: workId }, suggestion_id: null, subject_key: 'task:' + workId, priority: 40, created_at: now, updated_at: now, expires_at: null, user_state: 'new', snooze_until: null, lifecycle: 'resolved', delivery: { presented_at: null, notified_at: null, spoken_at: null } };
        next.feed.push(item);
    } item.task_ref={work_id:workId};item.title = title.slice(0, 120); item.kind = 'task_result'; item.lifecycle = 'resolved'; item.updated_at = this.#now().toISOString(); if (item.suggestion_id)
        this.options.pool.withdraw(item.suggestion_id); if(owner){const prior=owner.messages.find(m=>m.turn_id==='task:'+workId);if(prior)prior.text=title.slice(0,16000);else owner.messages.push({id:'task:'+workId,conversation_id:owner.id,role:'assistant',text:title.slice(0,16000),created_at:item.updated_at,turn_id:'task:'+workId,delivery:'completed'});owner.messages=owner.messages.slice(-512);owner.updated_at=item.updated_at;}await this.#commit(next); }); }
    async spoken(suggestionId: string): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); const item = next.feed.find(f => f.suggestion_id === suggestionId); if (!item)
        return; item.delivery.spoken_at ??= this.#now().toISOString(); item.updated_at = this.#now().toISOString(); await this.#commit(next); }); }
    async imDelivered(id: string): Promise<void> { await this.#serial(async () => {
        const next = structuredClone(this.#state), item = next.feed.find(f => f.id === id);
        if (!item) throw Error('not_found');
        item.delivery.im_sent_at ??= this.#now().toISOString();
        await this.#commit(next);
    }); }
    routePersonalSuggestion(suggestion:Suggestion,reason:WakeReason):boolean{if(!this.#conversationPool)return false;if(this.#state.conversations.voice_id==='chat:proactive')this.#conversationPool.deliverSuggestion('chat:proactive',suggestion,reason);return true}
    personalVoiceDeliveryAllowed():boolean{return this.#conversationPool===undefined||this.#state.conversations.voice_id==='chat:proactive'}
    async canDeliver(id: string): Promise<boolean> { if(!this.#opened||isQuietTime(this.#state.settings,this.#now()))return false; await this.revalidate(); const item = this.#state.feed.find(f => f.id === id); return !!item && item.lifecycle === 'active' && item.user_state !== 'dismissed' && (!item.snooze_until || Date.parse(item.snooze_until) <= this.#now().getTime()) && await this.#valid(item); }
    async action(params: unknown): Promise<unknown> { const p = z.object({ id: z.string(), action: z.enum(['open', 'act', 'snooze', 'dismiss', 'expand_evidence', 'presented', 'notified']), snooze_until: z.string().datetime().optional() }).strict().parse(params); await this.revalidate(); return this.#serial(async () => { const next = structuredClone(this.#state), item = next.feed.find(f => f.id === p.id); if (!item)
        throw Error('not_found'); if (['act', 'presented', 'notified'].includes(p.action) && ((item.lifecycle !== 'active' && !(p.action === 'presented' && item.lifecycle === 'resolved')) || item.user_state === 'dismissed' || (item.snooze_until && Date.parse(item.snooze_until) > this.#now().getTime())))
        throw Error('stale'); if (p.action === 'act') {
        if (!this.options.act)
            throw Error('unsupported');
        if (!await this.#valid(item))
            throw Error('stale');
        await this.options.act(item);
    }
    else if (p.action === 'dismiss') {
        item.user_state = 'dismissed';
        if (item.suggestion_id)
            this.options.pool.withdraw(item.suggestion_id);
    }
    else if (p.action === 'snooze') {
        if (!p.snooze_until || Date.parse(p.snooze_until) <= this.#now().getTime())
            throw Error('invalid_snooze');
        item.user_state = 'snoozed';
        item.snooze_until = p.snooze_until;
        if (item.suggestion_id)
            this.options.pool.withdraw(item.suggestion_id);
    }
    else if (p.action === 'presented')
        item.delivery.presented_at ??= this.#now().toISOString();
    else if (p.action === 'notified') {
        if (item.kind !== 'question')
            throw Error('notification_not_allowed');
        item.delivery.notified_at ??= this.#now().toISOString();
    }
    else if (p.action === 'open')
        item.user_state = 'seen'; item.updated_at = this.#now().toISOString(); await this.#commit(next); return item; }); }
    command(raw: unknown): Promise<unknown> { const parsed = personalCommandSchema.parse(raw); if (!this.#opened || this.#pendingCommands >= 8)
        return Promise.resolve({ type: 'personal.result', request_id: parsed.request_id, ok: false, error: 'unavailable' }); this.#pendingCommands++; const run = this.#commands.then(() => this.#executeCommand(parsed)); this.#commands = run.catch(() => { /* optional observer or cleanup already reported */ }).finally(() => { this.#pendingCommands--; }); return run; }
    async #executeCommand(raw: unknown): Promise<unknown> { const command = personalCommandSchema.parse(raw), payload = hash(command), prior = this.#state.receipts[command.request_id]; if (prior)
        return prior.payload === payload ? prior.result : { type: 'personal.result', request_id: command.request_id, ok: false, error: 'request_id_conflict' }; let result: unknown; try {
        let data: unknown;
        const m = this.options.memory(), p = command.params;
        if(command.method==='feed.action' && p.action==='act') {
            await this.#serial(async()=>{
                const next=structuredClone(this.#state);
                next.receipts[command.request_id]={payload,result:{type:'personal.result',request_id:command.request_id,ok:false,error:'outcome_unknown'}};
                const keys=Object.keys(next.receipts);for(const key of keys.slice(0,Math.max(0,keys.length-256)))delete next.receipts[key];
                await this.#commit(next);
            });
        }
        if(command.method.startsWith('conversations.')) {data=await this.#conversationCommand(command.method,p);if(command.method==='conversations.open_feed'&&this.#conversationPool){const id=this.#state.conversations.selected_id;const label=typeof p.label==='string'?p.label:'聊聊这条建议';await this.submitConversationText(id,label,'feed:'+String(p.feed_id))}}
        else if (command.method === 'state') {
            await this.revalidate();
            await this.refreshMemory();
            data = this.snapshot();
        }
        else if (command.method === 'feed.action')
            data = await this.action(p);
        else if (command.method.startsWith('connector.')) {
            if (!this.#connectors) throw Error('unsupported');
            data = await this.#connectors.command(command.method, p);
            this.connectionChanged();
        }
        else if (command.method.startsWith('feishu.')) {
            if (!this.#feishu) throw Error('unsupported');
            data = await this.#feishu.command(command.method, p);
            await this.sourceChanged();
        }
        else if (command.method === 'memory.evidence') {
            const q=z.object({evidence_id:z.string().min(1).max(600).refine(value=>!value.includes('\0'))}).strict().parse(p);
            data=this.#retrieval ? await this.#retrieval.evidence(q.evidence_id) : {state:'unavailable',evidence:null};
        }
        else if (command.method === 'memory.reextract') {
            const q=z.object({id:z.string().min(1).max(256)}).strict().parse(p);
            if (!m?.reextract) throw Error('unsupported');
            await m.reextract(q.id);await this.revalidate();await this.refreshMemory();
        }
        else if (command.method === 'memory.list') {
            const q = z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(100).optional(),include_expired:z.boolean().optional() }).strict().parse(p);
            if (!m?.list)
                throw Error('unsupported');
            this.#invalidateOverview();
            await this.refreshMemory(q.cursor, q.limit, q.include_expired??false);
            data = this.#memory;
        }
        else if (command.method === 'memory.correct' || command.method === 'memory.forget') {
            const q = z.object({ id: z.string().min(1).max(256), expected_version: versionSchema, content: z.string().trim().min(1).max(500).optional() }).strict().parse(p);
            this.#invalidateOverview();
            this.#overviewCache = undefined;
            if (command.method === 'memory.correct') {
                if (!m?.correct || !q.content)
                    throw Error('unsupported');
                data = await m.correct(q.id, q.expected_version, q.content, { type: 'conversation', ref: 'personal-command:' + command.request_id, observed_at: this.#now().toISOString() });
            }
            else {
                if (!m?.forgetEntry)
                    throw Error('unsupported');
                data = await m.forgetEntry(q.id, q.expected_version);
            }
            await this.revalidate();
            await this.refreshMemory();
        }
        else if (command.method === 'discovery.configure') {
            const q = personalSettingsSchema.partial().extend({ enabled: z.boolean().optional(), interval_minutes: z.number().int().min(5).max(1440).optional() }).strict().parse(p);
            await this.#serial(async () => { const next = structuredClone(this.#state);const settings={...q};delete settings.enabled;delete settings.interval_minutes;Object.assign(next.settings,settings); if (q.enabled !== undefined)
                next.settings.discovery_enabled = q.enabled; if (q.interval_minutes !== undefined)
                next.settings.discovery_interval_minutes = q.interval_minutes; await this.#commit(next); });
            this.#abort.abort();this.#abort=new AbortController();
            this.#schedule();
        }
        else {
            if (!this.#sources)
                throw Error('unsupported');
            data = await this.#sources.command(command.method, p);
        }
        result = { type: 'personal.result', request_id: command.request_id, ok: true, ...(data === undefined ? {} : { data }) };
    }
    catch (e) {
        result = { type: 'personal.result', request_id: command.request_id, ok: false, error: e instanceof Error ? e.message : 'unavailable' };
    } await this.#serial(async () => { const next = structuredClone(this.#state); const receipt={...result as Record<string,unknown>}; if(Object.hasOwn(receipt,'data')){delete receipt.data;receipt.reload_required=true;} next.receipts[command.request_id] = { payload, result:receipt }; const keys = Object.keys(next.receipts); for (const key of keys.slice(0, Math.max(0, keys.length - 256)))
        delete next.receipts[key]; await this.#commit(next); }); return result; }
}
