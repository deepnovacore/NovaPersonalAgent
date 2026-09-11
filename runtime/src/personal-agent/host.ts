import type { ContextView } from '../context-view.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PersonalMemoryResource } from '../memory/personal-memory.js';
import type { MemoryEntry } from '../memory/entry.js';
import { memoryRefSchema } from '../memory.js';
import type { SuggestionPool } from '../suggestions.js';
import { personalCommandSchema, proposalSchema, versionSchema, type Proposal, type FeedItem } from './contracts.js';
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
export interface HostOptions {
    context?: () => ContextView;
    path: string;
    userScope: string;
    memory: () => PersonalMemoryResource | undefined;
    pool: SuggestionPool;
    evidence: (ref: string) => Evidence | null;
    discover?: (snapshot: DiscoverySnapshot, signal: AbortSignal) => Promise<Proposal | null>;
    evidenceRefs?: () => string[];
    onTick?: (snapshot: DiscoverySnapshot) => void;
    act?: (item: FeedItem) => Promise<void>;
    now?: () => Date;
}
const hash = (s: unknown): string => createHash('sha256').update(JSON.stringify(s)).digest('hex');
export class PersonalAgentHost {
    #commands: Promise<unknown> = Promise.resolve();
    #pendingCommands = 0;
    #release: (() => Promise<void>) | undefined;
    readonly #store: PersonalStore;
    #state: PersonalState = initialState();
    #memory: {
        entries: MemoryEntry[];
        cursor: string | null;
    } = { entries: [], cursor: null };
    #sources: PersonalSources | undefined;
    #listeners = new Set<() => void>();
    #tail: Promise<unknown> = Promise.resolve();
    #timer: ReturnType<typeof setInterval> | undefined;
    #abort = new AbortController();
    #discovery: Promise<void> | undefined;
    #opened = false;
    #sourceSignature = '';
    constructor(readonly options: HostOptions) { this.#store = new PersonalStore(options.path); }
    get path(): string { return this.options.path; }
    setSources(sources: PersonalSources): void { this.#sources = sources; }
    subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
    #now(): Date { return this.options.now?.() ?? new Date(); }
    #serial<T>(fn: () => Promise<T>): Promise<T> { const run = this.#tail.then(fn); this.#tail = run.catch(() => { /* optional observer or cleanup already reported */ }); return run; }
    async open(): Promise<void> {
        if (this.#opened) return;
        this.#release = await acquirePersonalLock(this.options.path);
        try {
            this.#state = await this.#store.read();
            if (this.#state.user_scope !== null && this.#state.user_scope !== this.options.userScope) throw Error('scope_mismatch');
            this.#state.user_scope = this.options.userScope;
            this.#abort = new AbortController();
            this.#opened = true;
            await this.#sources?.open?.();
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
        this.#opened = false;
        clearInterval(this.#timer);
        this.#abort.abort();
        for (const item of this.#state.feed) if (item.suggestion_id) this.options.pool.withdraw(item.suggestion_id);
        try {
            await this.#sources?.close?.();
            await this.#discovery?.catch(() => { /* preserve primary lifecycle failure */ });
            await this.#commands;
            await this.#tail;
        } finally {
            const release=this.#release;
            this.#release=undefined;
            await release?.();
        }
    }
    #schedule(): void { clearInterval(this.#timer); if (this.#opened && this.#state.settings.discovery_enabled) {
        this.#timer = setInterval(() => { void this.discover().catch(() => { /* optional observer or cleanup already reported */ }); }, this.#state.settings.discovery_interval_minutes * 60000);
        this.#timer.unref();
    } }
    async refreshMemory(cursor?: string, limit = 100): Promise<void> { const memory = this.options.memory(); this.#memory = memory?.list ? await memory.list({ ...(cursor ? { cursor } : {}), limit }) : { entries: [], cursor: null }; }
    snapshot() { const m = this.options.memory(); return { type: 'personal.state' as const, revision: this.#state.revision, feed: structuredClone(this.#state.feed), memory: structuredClone(this.#memory), sources: this.#sources?.list() ?? [], capabilities: { memory: { list: !!m?.list, get: !!m?.get, correct: !!m?.correct, forgetEntry: !!m?.forgetEntry, forgetSource: !!m?.forgetSource }, discovery: !!this.options.discover, sources: !!this.#sources }, settings: { ...this.#state.settings } }; }
    async #commit(next: PersonalState): Promise<void> { next.revision = this.#state.revision + 1; await this.#store.write(next); this.#state = next; for (const listener of this.#listeners) {
        try {
            listener();
        }
        catch { /* observers do not own persistence */ }
    } }
    #evidence(ref: string): Evidence | null { return this.options.evidence(ref) ?? this.#sources?.evidence?.(ref) ?? null; }
    async #valid(p: Pick<Proposal, 'memory_refs' | 'evidence_refs'>): Promise<boolean> { for (const ref of p.evidence_refs)
        if (!this.#evidence(ref))
            return false; for (const ref of p.memory_refs) {
        const entry = await this.options.memory()?.get?.(ref.entry_id);
        if (entry?.status !== 'active' || entry.version !== ref.version)
            return false;
    } return true; }
    async discoverySnapshot(): Promise<DiscoverySnapshot> { await this.refreshMemory(); const now = this.#now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; const memory = this.options.memory(); let relevant = this.#memory.entries; const context = this.options.context?.(); if (memory?.get && typeof memory.recall === 'function') {
        const query = context?.channels.find(c => c.name === 'conversation')?.recent.map(i => typeof i.content.text === 'string' ? i.content.text : '').filter(Boolean).slice(-1)[0] ?? now.toLocaleDateString('en-CA');
        const recalled = await memory.recall(query, { scope: 'recent', limit: 8, signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000)]) });
        const hits = await Promise.all(recalled.hits.slice(0, 8).map(hit => memory.get!(hit.memoryId)));
        relevant = [...hits.filter((e): e is MemoryEntry => e !== null), ...relevant].filter((e, i, all) => all.findIndex(a => a.id === e.id) === i);
    } return { ...(context ? { context } : {}), user_scope: this.options.userScope, local_date: now.toLocaleDateString('en-CA'), weekday: now.toLocaleDateString('en-US', { weekday: 'long' }), timezone, memory: relevant.filter(e => e.status === 'active' && e.version !== null).slice(0, 16), evidence_refs: [...(this.options.evidenceRefs?.() ?? []), ...(this.#sources?.evidenceSnapshot?.() ?? []).map(item => item.ref)].slice(-16), recent_delivery: this.#state.feed.filter(f => Object.values(f.delivery).some(Boolean)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8) }; }
    discover(): Promise<void> { if (this.#discovery)
        return this.#discovery; if (!this.#opened || !this.#state.settings.discovery_enabled || !this.options.discover)
        return Promise.resolve(); const controller=this.#abort; const run = (async () => { await this.revalidate(); const snapshot = await this.discoverySnapshot(); this.options.onTick?.(snapshot); if(snapshot.memory.length===0&&snapshot.evidence_refs.length===0)return; const proposal = await this.options.discover!(snapshot, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])); if (proposal && !controller.signal.aborted && this.#opened && this.#state.settings.discovery_enabled)
        await this.admit(proposal, snapshot); })(); this.#discovery = run; void run.finally(() => { if (this.#discovery === run)
        this.#discovery = undefined; }).catch(() => { /* optional observer or cleanup already reported */ }); return run; }
    async admit(input: unknown, snapshot: DiscoverySnapshot): Promise<'admitted' | 'rejected' | 'suppressed_duplicate'> { return this.#serial(async () => { const parsed = proposalSchema.safeParse(input); if (!parsed.success || snapshot.user_scope !== this.options.userScope)
        return 'rejected'; const p = parsed.data; if (p.evidence_refs.some(r => !snapshot.evidence_refs.includes(r)) || p.memory_refs.some(r => !snapshot.memory.some(m => m.id === r.entry_id && m.version === r.version)) || !await this.#valid(p))
        return 'rejected'; const entities = p.evidence_refs.map(r => this.#evidence(r)!).filter(e => e.task_ref!==undefined || e.source.type !== 'conversation').sort((a,b)=>Number(b.task_ref!==undefined)-Number(a.task_ref!==undefined)||a.subject_key.localeCompare(b.subject_key));
        const memorySubjects=p.memory_refs.map(r=>'memory:'+r.entry_id).sort();
        const primary = entities[0] ?? (p.memory_refs[0] ? {subject_key:memorySubjects[0]!,source:{type:'memory' as const,ref:p.memory_refs[0].entry_id}} : this.#evidence([...p.evidence_refs].sort()[0]!)!);
        const subject = primary.subject_key || hash([...p.evidence_refs].sort());
        const keyFor=(subjectKey:string)=>hash([this.options.userScope,p.kind,subjectKey,snapshot.local_date]);
        const key=keyFor(subject);
        if([subject,...(entities.length>0?entities.map(e=>e.subject_key):memorySubjects)].some(candidate=>this.#state.dedupe.includes(keyFor(candidate)))) return 'suppressed_duplicate'; const now = this.#now(); const item: FeedItem = { id: randomUUID(), kind: p.kind, title: p.summary.slice(0, 120), why_now: p.why_now, evidence_refs: p.evidence_refs, memory_refs: p.memory_refs, source: primary.source, subject_key: subject, task_ref: entities[0]?.task_ref ?? null, suggestion_id: null, priority: 40, created_at: now.toISOString(), updated_at: now.toISOString(), expires_at: new Date(now.getTime() + 86400000).toISOString(), user_state: 'new', snooze_until: null, lifecycle: 'active', delivery: { presented_at: null, notified_at: null, spoken_at: null } }; const next = structuredClone(this.#state); next.feed.push(item); next.dedupe.push(key); await this.#commit(next); this.#pool(item); return 'admitted'; }); }
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
    async sourceChanged(): Promise<void> { await this.revalidate(); await this.#serial(() => this.#commit(structuredClone(this.#state))); const signature=hash((this.#sources?.evidenceSnapshot?.()??[]).map(item=>item.ref).sort());if(signature!==this.#sourceSignature){this.#sourceSignature=signature;await this.discover();} }
    async taskResult(workId: string, title: string): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); let item = next.feed.find(f => f.task_ref?.work_id === workId); if (!item) {
        const now = this.#now().toISOString();
        item = { id: randomUUID(), kind: 'task_result', title: '', why_now: '任务已有结果', evidence_refs: [], memory_refs: [], source: { type: 'task', ref: workId }, task_ref: { work_id: workId }, suggestion_id: null, subject_key: 'task:' + workId, priority: 40, created_at: now, updated_at: now, expires_at: null, user_state: 'new', snooze_until: null, lifecycle: 'resolved', delivery: { presented_at: null, notified_at: null, spoken_at: null } };
        next.feed.push(item);
    } item.title = title.slice(0, 120); item.kind = 'task_result'; item.lifecycle = 'resolved'; item.updated_at = this.#now().toISOString(); if (item.suggestion_id)
        this.options.pool.withdraw(item.suggestion_id); await this.#commit(next); }); }
    async spoken(suggestionId: string): Promise<void> { await this.#serial(async () => { const next = structuredClone(this.#state); const item = next.feed.find(f => f.suggestion_id === suggestionId); if (!item)
        return; item.delivery.spoken_at ??= this.#now().toISOString(); item.updated_at = this.#now().toISOString(); await this.#commit(next); }); }
    async canDeliver(id: string): Promise<boolean> { if(!this.#opened)return false; await this.revalidate(); const item = this.#state.feed.find(f => f.id === id); return !!item && item.lifecycle === 'active' && item.user_state !== 'dismissed' && (!item.snooze_until || Date.parse(item.snooze_until) <= this.#now().getTime()) && await this.#valid(item); }
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
        if (command.method === 'state') {
            await this.revalidate();
            await this.refreshMemory();
            data = this.snapshot();
        }
        else if (command.method === 'feed.action')
            data = await this.action(p);
        else if (command.method === 'memory.list') {
            const q = z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(p);
            if (!m?.list)
                throw Error('unsupported');
            await this.refreshMemory(q.cursor, q.limit);
            data = this.#memory;
        }
        else if (command.method === 'memory.correct' || command.method === 'memory.forget') {
            const q = z.object({ id: z.string().min(1).max(256), expected_version: versionSchema, content: z.string().trim().min(1).max(500).optional() }).strict().parse(p);
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
            const q = z.object({ enabled: z.boolean().optional(), interval_minutes: z.number().int().min(5).max(1440).optional() }).strict().parse(p);
            await this.#serial(async () => { const next = structuredClone(this.#state); if (q.enabled !== undefined)
                next.settings.discovery_enabled = q.enabled; if (q.interval_minutes !== undefined)
                next.settings.discovery_interval_minutes = q.interval_minutes; await this.#commit(next); });
            if(!this.#state.settings.discovery_enabled)this.#abort.abort();
            else if(this.#abort.signal.aborted)this.#abort=new AbortController();
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
