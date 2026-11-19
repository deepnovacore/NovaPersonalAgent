import {responseStyleContext, validateResponseStyleHits} from './ledger-recall-engine.js'
import type {PersonalMemoryRecallHit} from './personal-memory.js'
import type {RealtimeTelemetry} from '../realtime/telemetry.js'
import {withUsageContext,type UsageContext} from '../usage/context.js'
import {abortable} from '../core/camera-session.js'
import {sourceFilterSchema,type SourceFilter} from './source-retrieval.js'
import type {JsonValue} from '../core/events.js'
import {SensitiveContentPolicy} from '../memory/sensitivity.js'
import type {PersonalMemoryResource, MemoryVersion} from './personal-memory.js'

export interface RetrievedEntry extends Record<string, JsonValue> {
  entry_id: string; revision: Exclude<MemoryVersion, null>; reference: string;
  text: string; origin: 'stated' | 'inferred'; evidence_refs: string[];
  kind: string; life: JsonValue; memory_scope?: 'user'|'general'|null;
}
export interface RetrievedSnippet extends Record<string, JsonValue> {
  evidence_id: string; source_kind: string; locator: string; text: string;
  observed_at: string; trust: 'untrusted_external'; context_kind?: 'knowledge_reference';
}
export interface UnifiedRetrievalResult extends Record<string, JsonValue> {
  state: 'ok' | 'empty' | 'unavailable'; scope: 'recent' | 'any';
  entries: RetrievedEntry[]; snippets: RetrievedSnippet[]; degraded: boolean;
}
export interface RetrievedEvidenceResult extends Record<string, JsonValue> {
  state: 'ok' | 'gone' | 'unavailable'; evidence: RetrievedSnippet | null;
}

const safeId = (id: string): boolean => typeof id === 'string' && id.length > 0 && id.length <= 600 && !id.includes('\0');
const policy = new SensitiveContentPolicy();
function excerpt(text: string, bytes: number): string | null {
  if (!text.trim() || policy.scrub('retrieval', text).kind !== 'clean') return null;
  // Streaming decode excludes an incomplete final UTF-8 code point rather than adding a replacement.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, bytes), {stream: true});
}
const deadline = (signal?: AbortSignal): AbortSignal => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]);

/** C projection: entries and raw-index candidates resolve against the same A/B authority. */
export class UnifiedRetrieval {
  // Serialized snippet labels are not proof of host knowledge-index provenance.
  private readonly knowledgeReferences = new WeakMap<UnifiedRetrievalResult, ReadonlySet<string>>();
  private readonly userOnly = new WeakSet<UnifiedRetrievalResult>();
  // Styles depend on the entire source inventory, not just their supporting sources.
  private readonly styleProjections = new WeakMap<UnifiedRetrievalResult, {hits: readonly PersonalMemoryRecallHit[]; authorityRevision: number}>();
  private readonly owners = new WeakMap<UnifiedRetrievalResult, PersonalMemoryResource>();
  private readonly consumers = new WeakMap<UnifiedRetrievalResult,string>();
  constructor(private readonly options: {
    memory: () => PersonalMemoryResource | undefined;
    usageContext?: UsageContext;
    telemetry?: Pick<RealtimeTelemetry, 'record'>;
    /** Host wiring only: candidates originate in the canonical-bound knowledge index, never a provider claim. */
    rawRecallKind?: 'knowledge';
    rawPurgeEvidence?: (ids: readonly string[]) => Promise<void>;
    rawRecall?: (query: string, limit: number, signal: AbortSignal) => Promise<readonly {evidence_id: string; score?: number}[]>;
  }) {}

  async purgeEvidence(ids: readonly string[]): Promise<void> {
    if (!this.options.rawPurgeEvidence) throw Error('knowledge_purge_unavailable');
    await this.options.rawPurgeEvidence(ids);
  }

  /** A synchronous fence for all async work consuming this projection. */
  recallAuthorityUnchanged(result: UnifiedRetrievalResult): () => boolean {
    const resource = this.owners.get(result), revision = resource?.recallAuthorityRevision?.();
    return () => this.options.memory() === resource && revision === resource?.recallAuthorityRevision?.();
  }

  /** Consume a prefetched projection using current A/B rows, without another embedding request. */
  async revalidate(result: UnifiedRetrievalResult, signal: AbortSignal): Promise<UnifiedRetrievalResult> {
    signal.throwIfAborted();
    const resource = this.owners.get(result);
    const empty: UnifiedRetrievalResult = {state: 'unavailable', scope: result.scope, entries: [], snippets: [], degraded: true};
    if (!resource || this.options.memory() !== resource) return empty;
    const userOnly=this.userOnly.has(result),knowledge=this.knowledgeReferences.get(result)??new Set<string>();
    const entries = await Promise.all(result.entries.map(async item => {
      const row = await abortable(resource.get?.(item.entry_id) ?? Promise.resolve(null), signal);
      return row?.status === 'active' && row.version === item.revision && excerpt(row.content, 1000) === item.text
        && (row.memory_scope??null)===(item.memory_scope??null) && (!userOnly||row.memory_scope==='user') ? item : null;
    }));
    const allowedRefs=new Set(entries.flatMap(item=>item?.evidence_refs??[]));
    const snippets = await Promise.all(result.snippets.map(async item => {
      if(userOnly&&!allowedRefs.has(item.evidence_id)&&!knowledge.has(item.evidence_id))return null;
      const row = await abortable(resource.readEvidence?.(item.evidence_id) ?? Promise.resolve(null), signal);
      const snippet=row?.evidence_id===item.evidence_id?this.snippet(row,1000,knowledge.has(item.evidence_id)):null;
      return snippet&&(!knowledge.has(item.evidence_id)||(snippet.text===item.text&&snippet.locator===item.locator&&snippet.source_kind===item.source_kind&&snippet.observed_at===item.observed_at))?snippet:null;
    }));
    signal.throwIfAborted();
    if (this.options.memory() !== resource) return empty;
    const current = {...result, entries: entries.filter((item): item is RetrievedEntry => item !== null), snippets: snippets.filter((item): item is RetrievedSnippet => item !== null)};
    current.state = current.entries.length || current.snippets.length ? 'ok' : 'empty';
    this.owners.set(current, resource);
    if(userOnly)this.userOnly.add(current);
    this.knowledgeReferences.set(current,knowledge);
    const styleProjection=this.styleProjections.get(result);
    if(styleProjection)this.styleProjections.set(current,styleProjection);
    const consumer=this.consumers.get(result);if(consumer!==undefined)this.consumers.set(current,consumer);
    return this.authorize(current,resource,consumer,signal);
  }

  /** Response adaptation only: never include style records in factual entries or tool results. */
  async prepareResponseStyle(result: UnifiedRetrievalResult, signal: AbortSignal): Promise<() => string | null> {
    signal.throwIfAborted();
    const resource = this.owners.get(result), consumer = this.consumers.get(result), projection=this.styleProjections.get(result);
    const unchanged=()=>this.options.memory()===resource&&projection!==undefined&&resource?.recallAuthorityRevision?.()===projection.authorityRevision;
    if (resource?.supportsResponseStyle !== true || !consumer || !projection || !unchanged()) return () => null;
    // Authorization reads also discover committed changes made by other ledger clients.
    const hits = await validateResponseStyleHits(resource, projection.hits, consumer, signal);
    signal.throwIfAborted();
    if(!unchanged())return () => null;
    return () => !signal.aborted&&unchanged() ? responseStyleContext(hits) : null;
  }

  private async authorize(result:UnifiedRetrievalResult,resource:PersonalMemoryResource,consumer:string|undefined,signal:AbortSignal):Promise<UnifiedRetrievalResult>{
    const knowledge=this.knowledgeReferences.get(result);
    if(knowledge?.size&&(!consumer||!resource.canReadConversationEvidence)){
      result.snippets=result.snippets.filter(snippet=>!knowledge.has(snippet.evidence_id));result.degraded=true;
      result.state=result.entries.length||result.snippets.length?'ok':'unavailable';
    }
    if((consumer===undefined&&!resource.requiresConversationConsumer)||!resource.canReadConversationEvidence)return result;
    const allowed=async(ids:readonly string[])=>ids.length>0&&(await Promise.all(ids.map(id=>abortable(resource.canReadConversationEvidence!(id,consumer??''),signal)))).every(Boolean);
    const entries=await Promise.all(result.entries.map(async entry=>await allowed(entry.evidence_refs)?entry:null));
    const snippets=await Promise.all(result.snippets.map(async snippet=>await allowed([snippet.evidence_id])?snippet:null));
    signal.throwIfAborted();
    if(this.options.memory()!==resource)return {state:'unavailable',scope:result.scope,entries:[],snippets:[],degraded:true};
    result.entries=entries.filter((entry):entry is RetrievedEntry=>entry!==null);
    const allowedRefs=new Set(result.entries.flatMap(entry=>entry.evidence_refs));
    result.snippets=snippets.filter((snippet):snippet is RetrievedSnippet=>snippet!==null&&(!this.userOnly.has(result)||allowedRefs.has(snippet.evidence_id)||this.knowledgeReferences.get(result)?.has(snippet.evidence_id)===true));
    result.state=result.entries.length||result.snippets.length?'ok':result.degraded?'unavailable':'empty';
    return result;
  }

  private snippet(row: NonNullable<Awaited<ReturnType<NonNullable<PersonalMemoryResource['readEvidence']>>>>, bytes: number, knowledge=false): RetrievedSnippet | null {
    if(knowledge&&row.source_kind!=='file')return null;
    const text = excerpt(row.text, bytes);
    if (!safeId(row.evidence_id) || !text) return null;
    return {evidence_id: row.evidence_id, source_kind: row.source_kind, locator: row.locator, text, observed_at: row.observed_at, trust: 'untrusted_external',...(knowledge?{context_kind:'knowledge_reference' as const}:{})};
  }

  async evidence(id: string, options: {signal?: AbortSignal;consumer?:string} = {}): Promise<RetrievedEvidenceResult> {
    if (!safeId(id)) throw new Error('invalid_evidence_request');
    const signal = deadline(options.signal); signal.throwIfAborted();
    const resource = this.options.memory();
    if (!resource?.readEvidence) return {state: 'unavailable', evidence: null};
    try {
      const row = await abortable(resource.readEvidence(id), signal);
      options.signal?.throwIfAborted();
      if (this.options.memory() !== resource) return {state: 'unavailable', evidence: null};
      const allowed=(options.consumer===undefined&&!resource.requiresConversationConsumer)||!resource.canReadConversationEvidence||await abortable(resource.canReadConversationEvidence(id,options.consumer??''),signal);
      options.signal?.throwIfAborted();
      if(this.options.memory()!==resource)return {state:'unavailable',evidence:null};
      const evidence = allowed&&row?.evidence_id === id ? this.snippet(row, 2000) : null;
      return {state: evidence ? 'ok' : 'gone', evidence};
    } catch {
      options.signal?.throwIfAborted();
      return {state: 'unavailable', evidence: null};
    }
  }

  async recall(query: string, options: {scope?: 'recent' | 'any'; limit?: number; signal?: AbortSignal;consumer?:string;sourceFilter?:SourceFilter;userOnly?:boolean} = {}): Promise<UnifiedRetrievalResult> {
    const userOnly=options.userOnly===true;
    const filter=options.sourceFilter===undefined?undefined:sourceFilterSchema.parse(options.sourceFilter);
    const scope = options.scope ?? 'any', requested = options.limit ?? 8;
    if (typeof query !== 'string' || !query.trim() || query.length > 512 || query.includes('\0')
      || !['recent', 'any'].includes(scope) || !Number.isSafeInteger(requested) || requested < 1) throw new Error('invalid_retrieval_request');
    const limit = Math.min(8, requested), signal = deadline(options.signal);
    signal.throwIfAborted();
    const resource = this.options.memory();
    if (!resource) return {state: 'unavailable', scope, entries: [], snippets: [], degraded: true};
    const styleAuthorityRevision=resource.recallAuthorityRevision?.();
    const call = <T>(work: (abort: AbortSignal) => Promise<T>): Promise<T> => {
      const abort = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      return withUsageContext({...this.options.usageContext,feature:'recall',operation:'retrieve'},()=>abortable(Promise.resolve().then(() => work(abort)), abort));
    };
    const [recalled, raw, sources] = await Promise.allSettled([
      filter?Promise.resolve({hits:[],degraded:false}):call(abort => resource.recall(query.trim(), {scope, userOnly, limit: Math.min(8, resource.maxRecallLimit ?? 8), signal: abort})),
      // Recent is the memory provider's bounded candidate window and those entries' originals.
      // The current raw index has no recent-window ranking contract, so search it only for any.
      (!userOnly||this.options.rawRecallKind==='knowledge') && !filter && this.options.rawRecall && scope === 'any' ? call(abort => {
        if(this.options.rawRecallKind==='knowledge'&&(!options.consumer||!resource.readEvidence||!resource.canReadConversationEvidence))return Promise.reject(Error('knowledge_reference_authority_unavailable'));
        return this.options.rawRecall!(query.trim(), 8, abort);
      }) : Promise.resolve([]),
      !userOnly && resource.recallSources && options.consumer ? call(abort=>resource.recallSources!(query.trim(),{scope,limit:8,consumer:options.consumer!,signal:abort,...(filter?{filter}:{})})) : Promise.resolve({hits:[],truncated:filter!==undefined}),
    ]);
    options.signal?.throwIfAborted();
    if (recalled.status === 'rejected') {
      // Never forward provider messages, arbitrary error codes, queries or endpoint identities.
      const error: unknown = recalled.reason;
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
        : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error';
      this.options.telemetry?.record('memory.recall.engine_failed', {engine: resource.recallEngine ?? 'unknown', code});
    }
    let degraded = recalled.status === 'rejected' || raw.status === 'rejected' || sources.status === 'rejected';
    if(sources.status==='fulfilled')degraded ||= sources.value.truncated;
    if (recalled.status === 'fulfilled') degraded ||= recalled.value.degraded;
    const entries = new Map<string, {rank: number; entry: RetrievedEntry}>();
    const evidenceRanks = new Map<string, number>(),knowledge=new Set<string>();
    if (recalled.status === 'fulfilled') {
      if (!resource.get&&recalled.value.hits.length) degraded = true;
      else if(resource.get)for (const [index, hit] of recalled.value.hits.slice(0, 8).entries()) {
        if (!safeId(hit.memoryId) || entries.has(hit.memoryId)) continue;
        try {
          const current = await abortable(resource.get(hit.memoryId), signal);
          if (current?.status !== 'active' || current.version === null || current.id !== hit.memoryId
            || (hit.revision !== undefined && current.version !== hit.revision)
            || current.content !== hit.text.slice(0, 500)) continue;
          if(userOnly&&current.memory_scope!=='user'){if(current.memory_scope!=='general')degraded=true;continue;}
          const text = excerpt(current.content, 1000); if (!text) continue;
          const refs = [...new Set(hit.evidenceIds.filter(safeId))].slice(0, 16);
          const rank = 1 / (60 + index + 1);
          entries.set(current.id, {rank, entry: {entry_id: current.id, revision: current.version, reference: `${current.id}@${current.version}`, origin: current.origin, text, evidence_refs: refs, kind:current.kind, memory_scope:current.memory_scope??null, life:current.life?{...current.life,due_precision:current.life.due===null?null:'date',due_time:null}:null}});
          // The same evidence appearing in several memories counts once in this ranked channel.
          for (const id of refs) if (!evidenceRanks.has(id)) evidenceRanks.set(id, rank);
        } catch { degraded = true; }
      }
    }
    if (raw.status === 'fulfilled') {
      const seen = new Set<string>();
      for (const [index, hit] of raw.value.slice(0, 8).entries()) {
        if (!safeId(hit.evidence_id)) { degraded = true; continue; }
        if (seen.has(hit.evidence_id)) continue;
        seen.add(hit.evidence_id);
        if(this.options.rawRecallKind==='knowledge')knowledge.add(hit.evidence_id);
        // Reciprocal rank fusion; index-specific similarity scores carry no cross-channel meaning.
        evidenceRanks.set(hit.evidence_id, (evidenceRanks.get(hit.evidence_id) ?? 0) + 1 / (60 + index + 1));
      }
    }
    if(sources.status==='fulfilled')for(const [index,hit] of sources.value.hits.entries()){
      if(safeId(hit.evidence_id))evidenceRanks.set(hit.evidence_id,(evidenceRanks.get(hit.evidence_id)??0)+1/(60+index+1));
    }
    interface Candidate {rank: number; key: string; entry?: RetrievedEntry; evidenceId?: string}
    const candidates: Candidate[] = [
      ...[...entries.values()].map(({rank, entry}) => ({rank, key: `entry:${entry.entry_id}`, entry})),
      ...[...evidenceRanks].map(([evidenceId, rank]) => ({rank, key: `snippet:${evidenceId}`, evidenceId})),
    ];
    const selected: Candidate[] = [];
    const snippets = new Map<string, RetrievedSnippet>();
    const ranked = candidates.sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key));
    const rankedEntries = ranked.filter(candidate => candidate.entry), rankedSnippets = ranked.filter(candidate => candidate.evidenceId);
    // Preserve both understanding and original context when both are relevant; fill unused seats.
    const balanced = Array.from({length: Math.max(rankedEntries.length, rankedSnippets.length)}, (_, index) => [rankedEntries[index], rankedSnippets[index]]).flat().filter((candidate): candidate is Candidate => candidate !== undefined);
    for (const candidate of balanced) {
      if (selected.length >= limit) break;
      options.signal?.throwIfAborted();
      if (this.options.memory() !== resource) return {state: 'unavailable', scope, entries: [], snippets: [], degraded: true};
      try {
        if (candidate.entry) {
          const current = await abortable(resource.get!(candidate.entry.entry_id), signal);
          if (current?.status !== 'active' || current.version !== candidate.entry.revision || excerpt(current.content, 1000) !== candidate.entry.text
            || (current.memory_scope??null)!==(candidate.entry.memory_scope??null) || (userOnly&&current.memory_scope!=='user')) continue;
        } else {
          if (!resource.readEvidence) { degraded = true; continue; }
          const row = await abortable(resource.readEvidence(candidate.evidenceId!), signal);
          const snippet = row !== null && row.evidence_id === candidate.evidenceId ? this.snippet(row, 1000,knowledge.has(candidate.evidenceId)) : null;
          if (!snippet) continue;
          snippets.set(snippet.evidence_id, snippet);
        }
        selected.push(candidate);
      } catch { degraded = true; }
    }
    // Recheck after all hydration: a slow index must not revive an earlier corrected/deleted hit.
    const checked = await Promise.all(selected.map(async candidate => {
      try {
        if (candidate.entry) {
          const current = await abortable(resource.get!(candidate.entry.entry_id), signal);
          return current?.status === 'active' && current.version === candidate.entry.revision && excerpt(current.content, 1000) === candidate.entry.text
            && (current.memory_scope??null)===(candidate.entry.memory_scope??null) && (!userOnly||current.memory_scope==='user') ? candidate : null;
        }
        const row = await abortable(resource.readEvidence!(candidate.evidenceId!), signal);
        const snippet = row !== null && row.evidence_id === candidate.evidenceId ? this.snippet(row, 1000,knowledge.has(candidate.evidenceId)) : null;
        if (!snippet || snippet.text !== snippets.get(snippet.evidence_id)?.text) return null;
        snippets.set(snippet.evidence_id, snippet); return candidate;
      } catch { degraded = true; return null; }
    }));
    options.signal?.throwIfAborted();
    if (this.options.memory() !== resource) return {state: 'unavailable', scope, entries: [], snippets: [], degraded: true};
    const resultEntries = checked.flatMap(candidate => candidate?.entry ? [candidate.entry] : []);
    const allowedRefs=new Set(resultEntries.flatMap(entry=>entry.evidence_refs));
    const resultSnippets = checked.flatMap(candidate => candidate?.evidenceId && (!userOnly||allowedRefs.has(candidate.evidenceId)||knowledge.has(candidate.evidenceId)) ? [snippets.get(candidate.evidenceId)!] : []);
    const result: UnifiedRetrievalResult = {state: resultEntries.length || resultSnippets.length ? 'ok' : degraded ? 'unavailable' : 'empty', scope, entries: resultEntries, snippets: resultSnippets, degraded};
    this.owners.set(result, resource);
    if(userOnly)this.userOnly.add(result);
    this.knowledgeReferences.set(result,new Set(resultSnippets.filter(snippet=>snippet.context_kind==='knowledge_reference').map(snippet=>snippet.evidence_id)));
    if (resource.supportsResponseStyle === true && styleAuthorityRevision!==undefined && recalled.status === 'fulfilled' && 'contextHits' in recalled.value) this.styleProjections.set(result, {hits:recalled.value.contextHits ?? [],authorityRevision:styleAuthorityRevision});
    if(options.consumer!==undefined)this.consumers.set(result,options.consumer);
    return this.authorize(result,resource,options.consumer,signal);
  }
}
