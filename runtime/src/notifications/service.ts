import { createHash } from 'node:crypto';
import { notificationStore } from './store.js';
import { bindingSchema, notificationSchema, partSchema, type ChannelBinding, type Delivery, type DeliveryStatus, type NotificationInput, type NotificationState, type NotificationChannelAdapter, type SendOutcome } from './contracts.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set<DeliveryStatus>(['accepted', 'cancelled', 'expired', 'superseded']);
const uncertain = (d: Delivery) => d.status === 'sending' || d.status === 'unknown' || d.parts.some(p => p.receipt !== null);
export interface NotificationOptions {
    path: string;
    userScope: string;
    adapters: NotificationChannelAdapter[];
    now?: () => number;
    random?: () => number;
    valid?: (notification: NotificationInput) => Promise<'valid' | 'defer' | 'invalid'>;
    changed?: () => void;
}
/** The host owns the process lock. Network calls never hold the serialized state lock. */
export class NotificationService {
    readonly #store;
    readonly #adapters: Map<string, NotificationChannelAdapter>;
    #state: NotificationState;
    #tail = Promise.resolve();
    #run: Promise<void> | undefined;
    #stop = new AbortController();
    #opened = false;
    constructor(readonly options: NotificationOptions) { this.#store = notificationStore(options.path); this.#adapters = new Map(options.adapters.map(a => [a.providerId, a])); this.#state = this.#initial(); }
    #now() { return this.options.now?.() ?? Date.now(); }
    #initial(): NotificationState { return { schema_version: 1, user_scope: this.options.userScope, route_revision: 0, primary_binding_id: 'nova', configured: false, legacy_binding_id: null, bindings: [{ id: 'nova', provider: 'nova', identity: 'local', generation: 0, user_scope: this.options.userScope, status: 'ready' }], deliveries: [], dedupe: {}, migrated: false, cutoff: 0 }; }
    register(adapter: NotificationChannelAdapter) { if (this.#opened)
        throw Error('notification_adapter_already_started'); this.#adapters.set(adapter.providerId, adapter); }
    get local() { return this.#state.primary_binding_id === 'nova'; }
    get migrated() { return this.#state.migrated; }
    get configured() { return this.#state.configured; }
    binding(id: string) { return structuredClone(this.#state.bindings.find(b => b.id === id)); }
    #mutate<T>(fn: (state: NotificationState) => T, notify = true): Promise<T> { const run = this.#tail.then(async () => { const next = structuredClone(this.#state); const value = fn(next); if (JSON.stringify(next) === JSON.stringify(this.#state))
        return value; await this.#store.write(next); this.#state = next; if (notify)
        this.options.changed?.(); return value; }); this.#tail = run.then(() => { /* caller owns the result */ }, () => { /* caller owns the result */ }); return run; }
    async open() { if (this.#opened)
        return; try {
        this.#state = await this.#store.read(this.#initial());
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    } if (this.#state.user_scope !== this.options.userScope)
        throw Error('notification_scope_mismatch'); this.#stop = new AbortController(); await this.#mutate(s => { for (const d of s.deliveries)
        if (d.status === 'sending') {
            d.status = 'unknown';
            d.error = 'interrupted_send';
        } }); this.#opened = true; }
    async close() { this.#opened = false; this.#stop.abort(); await this.#run; await this.#tail; }
    snapshot() { const counts = Object.fromEntries(['pending', 'sending', 'accepted', 'retry_wait', 'blocked', 'unknown', 'cancelled', 'expired', 'superseded'].map(s => [s, 0])) as Record<DeliveryStatus, number>; for (const d of this.#state.deliveries)
        counts[d.status]++; return { primary_binding_id: this.#state.primary_binding_id, route_revision: this.#state.route_revision, local: this.local, configured: this.#state.configured, legacy_additional: this.#state.legacy_binding_id !== null, bindings: this.#state.bindings.map(b => ({id:b.id,provider:b.provider,user_scope:b.user_scope,generation:b.generation,status:b.status})), counts, deliveries: this.#state.deliveries.slice(-100).map(d => ({ id: d.id, title: d.notification.title, source: d.notification.source, status: d.status, error: d.error, binding_id: d.binding.id, updated_at: d.updated_at })) }; }
    /** Accepted is the only delivered terminal status; its `updated_at` is set when the final part's receipt is stored. */
    deliveredToday(kinds: readonly NotificationInput['kind'][], timezone: string, now: number): number { const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); const today = format.format(now); return this.#state.deliveries.filter(d => d.status === 'accepted' && kinds.includes(d.notification.kind) && format.format(d.updated_at) === today).length; }
    async bind(value: ChannelBinding) { const binding = bindingSchema.parse(value); if (binding.user_scope !== this.options.userScope)
        throw Error('notification_scope_mismatch'); await this.#mutate(s => { const old = s.bindings.find(b => b.id === binding.id); if (old && (binding.generation < old.generation || old.identity !== binding.identity && binding.generation === old.generation))
        throw Error('notification_binding_generation'); s.bindings = s.bindings.filter(b => b.id !== binding.id); s.bindings.push(binding); }); }
    async configure(id: string) { const binding = this.binding(id); const adapter = binding && this.#adapters.get(binding.provider); if (binding?.status !== 'ready' || !adapter || !await adapter.inspect(binding, this.#stop.signal))
        throw Error('notification_channel_unavailable'); await this.#mutate(s => { const current = s.bindings.find(b => b.id === id); if (current?.identity !== binding.identity || current.generation !== binding.generation || current.status !== 'ready')
        throw Error('notification_binding_changed'); s.configured = true; s.legacy_binding_id = null; s.primary_binding_id = id; s.route_revision++; for (const d of [...s.deliveries]) {
        if (terminal.has(d.status) || uncertain(d))
            continue;
        const original = s.bindings.find(b => b.id === d.binding.id);
        if (original?.identity !== d.binding.identity || original.generation !== d.binding.generation) { d.status = 'blocked'; d.error = 'binding_changed'; continue; }
        d.status = 'superseded';
        d.updated_at = this.#now();
        if (!d.invalidated)
            this.#enqueue(s, d.notification, binding);
    } }); }
    async migrate(legacyBindingId: string | null, delivered: NotificationInput[] = []) { if (this.#state.migrated)
        return; await this.#mutate(s => { if (s.migrated)
        return; s.migrated = true; s.cutoff = this.#now() - 90 * 86400000; if (!s.configured)
        s.legacy_binding_id = legacyBindingId; for (const n of delivered)
        s.dedupe[this.#messageKey(n)] = this.#now(); }); }
    #messageKey(n: NotificationInput) { return digest([this.options.userScope, n.event_key, n.revision, n.occurrence]); }
    #enqueue(s: NotificationState, n: NotificationInput, binding: ChannelBinding) { const id = digest([this.#messageKey(n), binding.id, binding.generation, s.route_revision]); if (s.deliveries.some(d => d.id === id))
        return; s.deliveries.push({ id, notification: structuredClone(n), route_revision: s.route_revision, binding: structuredClone(binding), status: 'pending', parts: [], attempts: 0, next_attempt_at: n.not_before, updated_at: this.#now(), error: null, invalidated: false }); }
    async publish(input: NotificationInput) {
        if (!this.#opened)
            throw Error('notifications_unavailable');
        const n = notificationSchema.parse(input);
        await this.#mutate(s => {
            const key = this.#messageKey(n);
            if (s.dedupe[key] !== undefined)
                return;
            this.#prune(s);
            if (s.deliveries.length >= 10000)
                throw Error('notification_capacity_blocked');
            if (n.created_at < s.cutoff)
                throw Error('notification_too_old');
            if (n.coalesce_key)
                for (const d of s.deliveries) {
                    if (d.notification.coalesce_key === n.coalesce_key && !terminal.has(d.status) && !uncertain(d)) {
                        d.status = 'superseded';
                        d.updated_at = this.#now();
                    }
                }
            const target = s.bindings.find(b => b.id === s.primary_binding_id);
            if (!target)
                throw Error('notification_binding_missing');
            this.#enqueue(s, n, target);
            if (s.legacy_binding_id && n.source.type === 'feed') {
                const extra = s.bindings.find(b => b.id === s.legacy_binding_id);
                if (extra)
                    this.#enqueue(s, n, extra);
            }
            s.dedupe[key] = this.#now();
        });
    }
    #prune(s: NotificationState) { const now = this.#now(); s.deliveries = s.deliveries.filter(d => !terminal.has(d.status) || d.updated_at > now - 30 * 86400000); const keep = new Set(s.deliveries.map(d => this.#messageKey(d.notification))); for (const [key, at] of Object.entries(s.dedupe))
        if (at < now - 90 * 86400000 && !keep.has(key))
            delete s.dedupe[key]; s.cutoff = Math.max(s.cutoff, now - 90 * 86400000); }
    async #invalidateDelivery(id: string) { await this.#mutate(s => { const d=s.deliveries.find(row=>row.id===id);if(d)this.#erase(d); }); }
    #erase(d: Delivery) {d.invalidated=true;d.notification.body='';d.notification.title='';for(const p of d.parts){p.part.body='';p.part.title='';delete p.part.payload;}if(d.status!=='sending'&&d.status!=='unknown'&&!terminal.has(d.status))d.status='cancelled';}
    async invalidate(type: string, id: string, notify = true) { if (!this.#state.deliveries.some(d => d.notification.source.type === type && d.notification.source.id === id && !d.invalidated))
        return; await this.#mutate(s => { for (const d of s.deliveries)
        if (d.notification.source.type === type && d.notification.source.id === id) {
            d.invalidated = true;
            d.notification.body = '';
            d.notification.title = '';
            for (const p of d.parts) {
                p.part.body = '';p.part.title = '';
                delete p.part.payload;
            }
            if (d.status !== 'sending' && d.status !== 'unknown' && !terminal.has(d.status))
                d.status = 'cancelled';
        } }, notify); }
    /** Manual resend acknowledges an uncertain prior request; normal dispatch never uses this. */
    async retry(id: string, confirmUnknown = false) { await this.#mutate(s => { const d = s.deliveries.find(d => d.id === id); if (!d || d.invalidated || terminal.has(d.status) || d.status === 'sending')
        throw Error('notification_not_retryable'); if (d.status === 'unknown' && !confirmUnknown)
        throw Error('notification_resend_confirmation_required'); if (d.status === 'unknown')
        for (const p of d.parts)
            if (!p.receipt)
                p.key = digest([p.key, this.#now(), d.attempts]); d.status = 'pending'; d.next_attempt_at = this.#now(); d.error = null; }); }
    dispatch(): Promise<void> { if (this.#run)
        return this.#run; const run = this.#dispatch(); this.#run = run; void run.finally(() => { if (this.#run === run)
        this.#run = undefined; }).catch(() => { /* caller owns the result */ }); return run; }
    async #dispatch() { if (!this.#opened || this.#stop.signal.aborted)
        return; const ids = this.#state.deliveries.filter(d => ['pending', 'retry_wait', 'blocked'].includes(d.status)).map(d => d.id); for (const id of ids) {
        if (this.#stop.signal.aborted)
            return;
        await this.#deliver(id);
    } }
    async #deliver(id: string) {
        let d = this.#state.deliveries.find(d => d.id === id);
        if (!d || d.invalidated || d.next_attempt_at > this.#now() || !['pending', 'retry_wait', 'blocked'].includes(d.status))
            return;
        if (d.notification.expires_at !== null && d.notification.expires_at <= this.#now()) {
            await this.#finish(id, 'expired', null);
            return;
        }
        const valid = await this.options.valid?.(structuredClone(d.notification)) ?? 'valid';
        if (valid === 'invalid') {
            await this.#invalidateDelivery(id);
            return;
        }
        if (valid === 'defer')
            return;
        const binding = this.binding(d.binding.id);
        if (binding?.generation !== d.binding.generation || binding.identity !== d.binding.identity || binding.status !== 'ready') {
            await this.#finish(id, 'blocked', 'binding_changed');
            return;
        }
        const adapter = this.#adapters.get(binding.provider);
        if (!adapter) {
            await this.#finish(id, 'blocked', 'adapter_unavailable');
            return;
        }
        try {
            if (!await adapter.inspect(binding, this.#stop.signal)) {
                await this.#finish(id, 'blocked', 'channel_unavailable');
                return;
            }
        }
        catch {
            await this.#finish(id, 'blocked', 'channel_unavailable');
            return;
        }
        if (d.parts.length === 0) {
            let parts;
            try {
                parts = (await adapter.prepare(structuredClone(d.notification), binding)).map(p => partSchema.parse(p));
                if (parts.length === 0 || parts.length > 256)
                    throw Error('invalid_parts');
            }
            catch {
                await this.#finish(id, 'blocked', 'content_unavailable');
                return;
            }
            await this.#mutate(s => { const current = s.deliveries.find(x => x.id === id)!; if (current.status === 'superseded' || current.invalidated)
                return; current.parts = parts.map((part, i) => ({ part, key: digest([id, i]), receipt: null })); });
        }
        while (!this.#stop.signal.aborted) {
            const before = this.#state.deliveries.find(x => x.id === id);
            if (!before || before.invalidated)
                return;
            if (before.notification.expires_at !== null && before.notification.expires_at <= this.#now()) {
                await this.#finish(id, 'expired', null);
                return;
            }
            const currentValidity = await this.options.valid?.(structuredClone(before.notification)) ?? 'valid';
            if (currentValidity !== 'valid') {
                if (currentValidity === 'invalid')
                    await this.#invalidateDelivery(id);
                return;
            }
            const claim = await this.#mutate(s => { const current = s.deliveries.find(x => x.id === id); if (!current || current.invalidated || !['pending', 'retry_wait', 'blocked'].includes(current.status))
                return null; const actual = s.bindings.find(b => b.id === current.binding.id); if (actual?.generation !== current.binding.generation || actual.identity !== current.binding.identity || actual.status !== 'ready') {
                current.status = 'blocked';
                current.error = 'binding_changed';
                return null;
            } if (current.route_revision !== s.route_revision && !uncertain(current)) {
                current.status = 'superseded';
                return null;
            } const index = current.parts.findIndex(p => p.receipt === null); if (index < 0) {
                current.status = 'accepted';
                return null;
            } current.status = 'sending'; current.attempts++; current.updated_at = this.#now(); return { delivery: structuredClone(current), index }; });
            if (!claim)
                return;
            const part = claim.delivery.parts[claim.index]!;
            let outcome: SendOutcome;
            try {
                outcome = await adapter.send(part.part, { binding: claim.delivery.binding, idempotency_key: part.key, notification: claim.delivery.notification, signal: this.#stop.signal });
            }
            catch {
                outcome = { kind: 'unknown', reason: 'transport_exception' };
            }
            try {
                await this.#mutate(s => { const current = s.deliveries.find(x => x.id === id)!; current.updated_at = this.#now(); if (outcome.kind === 'accepted') {
                    if (!outcome.receipt.message_id) {
                        current.status = 'unknown';
                        current.error = 'missing_receipt';
                        return;
                    }
                    current.parts[claim.index]!.receipt = outcome.receipt;
                    current.status = current.parts.every(p => p.receipt !== null) ? 'accepted' : current.invalidated ? 'cancelled' : 'pending';
                    current.error = null;
                }
                else if (outcome.kind === 'retryable') {
                    current.status = current.invalidated ? 'cancelled' : 'retry_wait';
                    current.next_attempt_at = this.#now() + Math.max(outcome.retryAfterMs ?? 0, Math.min(900000, 5000 * 2 ** Math.min(current.attempts - 1, 8)) * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4));
                    current.error = 'retryable';
                    if (current.route_revision !== s.route_revision && !current.parts.some(p => p.receipt) && !current.invalidated) {
                        const original=s.bindings.find(b=>b.id===current.binding.id);
                        if(original?.identity!==current.binding.identity||original.generation!==current.binding.generation){current.status='blocked';current.error='binding_changed';return;}
                        current.status = 'superseded';
                        const target = s.bindings.find(b => b.id === s.primary_binding_id);
                        if (target)
                            this.#enqueue(s, current.notification, target);
                    }
                }
                else {
                    current.status = outcome.kind;
                    current.error = outcome.reason.slice(0, 128);
                } });
            }
            catch {
                await this.#finish(id, 'unknown', 'receipt_persistence_failed').catch(() => { /* caller owns the result */ });
                return;
            }
            d = this.#state.deliveries.find(x => x.id === id);
            if (d?.status !== 'pending')
                return;
            const validity = await this.options.valid?.(structuredClone(d.notification)) ?? 'valid';
            if (validity !== 'valid') {
                if (validity === 'invalid')
                    await this.#invalidateDelivery(id);
                return;
            }
        }
    }
    async #finish(id: string, status: DeliveryStatus, error: string | null) { await this.#mutate(s => { const d = s.deliveries.find(x => x.id === id); if (d && !terminal.has(d.status)) {
        d.status = status;
        d.error = error;
        d.updated_at = this.#now();
        if (status === 'blocked')
            d.next_attempt_at = this.#now() + 30000;
    } }); }
}
