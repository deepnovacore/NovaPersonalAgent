import {randomUUID} from 'node:crypto'
import {opendir, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
import {SensitivePathPolicy} from '../workspace-graph/sensitivity.js'
import {chunkKnowledgeText, fetchKnowledgeUrl, readKnowledgeFile, knowledgeExcerpt} from './documents.js'
import type {EmbeddingProvider} from './embeddings.js'
import type {KnowledgeStoreClient} from './store-client.js'
import type {KnowledgeSource} from './types.js'
import type {PersonalMemoryResource} from '../memory/personal-memory.js'

export interface KnowledgeEvidenceLedger {
  record(input: {sourceId: string; locator: string; text: string; observedAt: string; kind: 'file'; embeddingConsent: boolean}): Promise<{evidence_id: string}>
  read: NonNullable<PersonalMemoryResource['readEvidence']>
  remove(sourceId: string): Promise<void>
}

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u)
const ingestSchema = z.object({kind: z.enum(['file', 'url', 'folder']), locator: z.string().min(1).max(4096), consent: z.literal(true)}).strict()
const failure = (code: string): Error => new Error(code)

/** Host-only mutations; all public model surfaces receive read-only evidence. */
export class KnowledgeService {
  readonly #store: KnowledgeStoreClient
  readonly #embedding: EmbeddingProvider
  readonly #stop = new AbortController()
  #active: {id: string; abort: AbortController; root?: string} | undefined
  #folderBusy = false
  #folderSignal: AbortSignal | undefined
  #queries = 0
  #fts = false
  #ledger: KnowledgeEvidenceLedger | undefined
  #binding: Promise<void> | undefined
  #migrated = false
  readonly #requireLedger: boolean

  constructor(options: {store: KnowledgeStoreClient; embedding: EmbeddingProvider; requireEvidenceLedger?: boolean}) {
    this.#store = options.store; this.#embedding = options.embedding
    this.#requireLedger = options.requireEvidenceLedger ?? false
  }
  #assertLedger(): void {if (this.#requireLedger && (!this.#ledger || !this.#migrated)) throw failure('knowledge_unavailable')}
  async open(): Promise<void> {this.#fts = (await this.#store.open()).fts}
  async close(): Promise<void> {
    this.#stop.abort(); this.#active?.abort.abort()
    await this.#store.close()
  }
  listSources(): Promise<readonly KnowledgeSource[]> {return this.#store.listSources()}
  async getChunk(locator: string) {
    this.#assertLedger()
    const chunk = await this.#store.getChunk(locator)
    const ledger = this.#ledger
    if (!ledger) return chunk
    if (chunk.status !== 'ok' || !chunk.evidence_id) return {status: chunk.status === 'stale' ? 'stale' as const : 'gone' as const}
    const evidence = await ledger.read(chunk.evidence_id)
    if (this.#ledger !== ledger || evidence?.evidence_id !== chunk.evidence_id) return {status: 'gone' as const}
    return {...chunk, text: evidence.text}
  }

  /** Existing index chunks migrate offline; linked-but-deleted A evidence is never recreated. */
  async bindEvidenceLedger(ledger: KnowledgeEvidenceLedger): Promise<void> {
    if (this.#binding) await this.#binding
    this.#ledger = ledger
    // Reopened runtime resources keep canonical IDs; never import cached plaintext into a new binding.
    if (this.#migrated) return
    const work = this.#migrateEvidence(ledger)
    this.#binding = work
    try {await work; this.#migrated = true} finally {if (this.#binding === work) this.#binding = undefined}
  }

  async #migrateEvidence(ledger: KnowledgeEvidenceLedger): Promise<void> {
    for (const source of await this.#store.listSources()) {
      for (let offset = 0; offset < 20000; offset += 100) {
        this.#stop.signal.throwIfAborted()
        const chunks = await this.#store.listChunks(source.id, offset)
        const links: {chunk_id: string; content_digest: string; evidence_id: string}[] = []
        for (const chunk of chunks) {
          if (chunk.evidence_id) continue
          const record = await ledger.record({sourceId: `knowledge:${source.id}`, locator: `${chunk.locator}#chunk=${chunk.ordinal}`, text: chunk.text, observedAt: chunk.observed_at, kind: 'file', embeddingConsent: false})
          links.push({chunk_id: chunk.chunk_id, content_digest: chunk.content_digest, evidence_id: record.evidence_id})
        }
        if (links.length) await this.#store.linkEvidence(links)
        if (chunks.length < 100) break
      }
    }
  }

  async recall(query: string, k: number, signal?: AbortSignal) {
    this.#assertLedger()
    if (this.#queries >= 4) throw failure('knowledge_busy')
    const input = z.object({query: z.string().trim().min(1).max(512), k: z.number().int().min(1).max(5)}).parse({query, k})
    const abort = AbortSignal.any([this.#stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(8000)])
    abort.throwIfAborted()
    this.#queries++
    try {
      if ((await this.#store.listSources()).length === 0) return []
      const [vector] = await this.#embedding.embed([input.query], abort)
      abort.throwIfAborted()
      if (vector === undefined) throw failure('embedding_invalid_result')
      const hits = await this.#store.recall(input.query, [...vector], this.#embedding.id, input.k)
      abort.throwIfAborted()
      if (!this.#ledger) return hits
      const current = await Promise.all(hits.map(async hit => {
        if (!hit.evidence_id) return null
        const chunk = await this.getChunk(hit.locator)
        abort.throwIfAborted()
        return chunk.status === 'ok' && chunk.evidence_id === hit.evidence_id && typeof chunk.text === 'string' ? {...hit, text: [...chunk.text].slice(0, 600).join('')} : null
      }))
      return current.filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    } finally {this.#queries--}
  }

  /** Directory-source admission retains its grant and cancellation through the actual file read. */
  async syncFile(locator: string, root: string, signal: AbortSignal, sourceId?: string): Promise<{id: string; excerpt: string; evidence_ids?: string[]}> {
    this.#assertLedger()
    signal.throwIfAborted()
    this.#stop.signal.throwIfAborted()
    if (this.#active || this.#folderBusy) throw failure('knowledge_busy')
    if (sourceId !== undefined && !idSchema.safeParse(sourceId).success) throw failure('invalid_request')
    const active: {id: string; abort: AbortController; root: string} = {id: sourceId ?? randomUUID(), abort: new AbortController(), root}
    this.#active = active
    const cancel = () => active.abort.abort()
    signal.addEventListener('abort', cancel, {once: true})
    try {
      let old = (await this.#store.listSources()).find(source => source.locator === locator)
      signal.throwIfAborted()
      if (sourceId !== undefined && this.#ledger) {
        if (old && old.id !== sourceId) throw failure('source_changed')
        if (old) {await this.#ledger.remove(`knowledge:${old.id}`);await this.#store.removeSource(old.id)}
        active.id = randomUUID(); old = undefined
      } else if (old !== undefined) active.id = old.id
      let excerpt = ''
      const result = await this.#index('folder_child', locator, active, old, text => {excerpt = knowledgeExcerpt(text)})
      if ('error' in result) throw failure(result.error)
      const evidence_ids = (await this.#store.listChunks(active.id, 0)).flatMap(chunk => chunk.evidence_id ? [chunk.evidence_id] : []).slice(0, 2)
      return {id: active.id, excerpt, ...(evidence_ids.length ? {evidence_ids} : {})}
    } finally {
      signal.removeEventListener('abort', cancel)
      if (this.#active === active) this.#active = undefined
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    this.#stop.signal.throwIfAborted()
    if (method === 'knowledge.status') {
      if (!z.object({}).strict().safeParse(params).success) throw failure('invalid_request')
      const sources = await this.#store.listSources(), jobs = await this.#store.listJobs()
      return {fts: this.#fts, sources: sources.map(({id, title, kind, bytes, updated_at, status}) => ({id, title, kind, bytes, updated_at, status})), jobs}
    }
    if (method === 'knowledge.remove') {
      this.#assertLedger()
      const parsed = z.object({id: idSchema}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active?.id === parsed.data.id) this.#active.abort.abort()
      await this.#ledger?.remove(`knowledge:${parsed.data.id}`)
      await this.#store.removeSource(parsed.data.id)
      return {ok: true}
    }
    if (method === 'knowledge.reindex') {
      this.#assertLedger()
      const parsed = z.object({id: idSchema, consent: z.literal(true)}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      // Claim the id before any asynchronous read, so remove can fence this reindex.
      const active = {id: parsed.data.id, abort: new AbortController()}
      this.#active = active
      try {
        const source = (await this.#store.listSources()).find(value => value.id === active.id)
        if (source === undefined) return {error: 'source_gone'}
        return await this.#index(source.kind, source.locator, active, source)
      } finally {if (this.#active === active) this.#active = undefined}
    }
    if (method === 'knowledge.ingest') {
      this.#assertLedger()
      const parsed = ingestSchema.safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      if (parsed.data.kind === 'folder') return this.#folder(parsed.data.locator)
      return this.#ingest(parsed.data.kind, parsed.data.locator)
    }
    throw failure('invalid_request')
  }

  async #ingest(kind: KnowledgeSource['kind'], locator: string): Promise<unknown> {
    const active = {id: randomUUID(), abort: new AbortController()}
    this.#active = active
    try {return await this.#index(kind, locator, active)}
    finally {if (this.#active === active) this.#active = undefined}
  }

  async #index(kind: KnowledgeSource['kind'], locator: string, active: {id: string; abort: AbortController; root?: string}, old?: KnowledgeSource, onIndexed?: (text: string) => void) {
    const signal = AbortSignal.any([active.abort.signal, this.#stop.signal,
      ...(this.#folderSignal === undefined ? [] : [this.#folderSignal]), AbortSignal.timeout(120000)])
    const job = {id: randomUUID(), source_id: active.id, updated_at: Date.now(), error_code: null}
    try {
      signal.throwIfAborted()
      await this.#store.recordJob({...job, state: 'running'})
      const document = await (kind === 'url' ? fetchKnowledgeUrl(locator, signal) : readKnowledgeFile(locator, signal, active.root))
      signal.throwIfAborted()
      if (old === undefined && (await this.#store.listSources()).some(value => value.locator === document.locator)) throw failure('source_exists')
      const chunks = chunkKnowledgeText(document.text)
      const evidenceIds: (string | undefined)[] = []
      for (const [ordinal, chunk] of chunks.entries()) {
        signal.throwIfAborted()
        const evidence = await this.#ledger?.record({sourceId: `knowledge:${active.id}`, locator: `${document.locator}#chunk=${ordinal}`, text: chunk.text, observedAt: new Date().toISOString(), kind: 'file', embeddingConsent: true})
        evidenceIds.push(evidence?.evidence_id)
      }
      signal.throwIfAborted()
      const vectors = await this.#embedding.embed(chunks.map(chunk => chunk.text), signal)
      signal.throwIfAborted()
      if (vectors.length !== chunks.length) throw failure('embedding_invalid_result')
      const now = Date.now()
      const title = [...document.title].slice(0, 256).join('')
      // No await between this fence and enqueueing the atomic replacement. Remove enqueues after it.
      await this.#store.replaceSource({
        source: {id: active.id, title, kind, locator: document.locator, mime: document.mime,
          fingerprint: document.fingerprint, bytes: document.bytes, created_at: old?.created_at ?? now, updated_at: now, status: 'ready'},
        provider_id: this.#embedding.id, dims: this.#embedding.dims,
        // Plain text and extracted PDF/DOCX need not contain Markdown headings.
        chunks: chunks.map((chunk, index) => ({...chunk,
          ...(evidenceIds[index] === undefined ? {} : {evidence_id: evidenceIds[index]}),
          heading_path: [...(chunk.heading_path || title)].slice(0, 256).join(''), vector: [...vectors[index]!]})),
      })
      await this.#store.recordJob({...job, updated_at: Date.now(), state: 'complete'})
      onIndexed?.(document.text)
      return {ok: true, id: active.id}
    } catch {
      const code = signal.aborted ? 'ingest_cancelled' : 'ingest_failed'
      if (!this.#stop.signal.aborted) await this.#store.recordJob({...job, updated_at: Date.now(), state: 'failed', error_code: code}).catch(() => undefined)
      return {error: code, id: active.id}
    }
  }

  async #folder(locator: string): Promise<unknown> {
    this.#folderBusy = true
    this.#folderSignal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(120000)])
    const results: unknown[] = []
    try {
      const policy = new SensitivePathPolicy()
      if (!policy.allows(locator)) throw failure('invalid_request')
      const root = await realpath(locator)
      if (!policy.allows(root)) throw failure('invalid_request')
      const directories = [{path: root, depth: 0}]
      let visited = 0
      while (directories.length > 0 && results.length < 100 && visited < 1000) {
        this.#folderSignal.throwIfAborted()
        const directory = directories.pop()!
        for await (const entry of await opendir(directory.path)) {
          visited++
          if (visited > 1000 || results.length >= 100) break
          const path = join(directory.path, entry.name)
          if (entry.name.startsWith('.') || !policy.allows(path) || entry.isSymbolicLink()) continue
          if (entry.isDirectory() && directory.depth < 16) directories.push({path, depth: directory.depth + 1})
          else if (entry.isFile()) results.push(await this.#ingest('folder_child', path))
        }
      }
      return {results, limited: visited >= 1000 || results.length >= 100}
    } finally {this.#folderBusy = false; this.#folderSignal = undefined}
  }
}
