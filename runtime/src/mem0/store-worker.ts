import {createHash, randomUUID} from 'node:crypto'
import {MemoryListOptionsSchema, MemorySourceRefSchema, type MemoryEntry} from '../memory/entry.js'
import {memoryInspectionQuerySchema, type MemoryInspection} from '../memory/personal-memory-inspection.js'
import {existsSync} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {isMainThread, parentPort, workerData} from 'node:worker_threads'
import {Memory} from 'mem0ai/oss'
import {PrivateDatabaseError, preparePrivateDatabasePath, secureSidecar} from '../storage/private-database.js'
import type {PersonalMemoryEmbeddingConfig, VoiceMemRecallHit, VoiceMemRecallResult} from '../voicemem/store-client.js'

interface Data {conversationProviders?: string[]; path: string; userId: string; embedding: PersonalMemoryEmbeddingConfig; extractionModel?: string; extraction?: {baseUrl: string; apiKey: string}}
interface Source {id: string; payload: string; state: 'pending' | 'learned' | 'forgotten'; recorded_at: string; cleaned: number; conversation_providers: string}
type Request = Record<string, unknown> & {kind: 'request'; request_id: number; operation: 'open' | 'recall' | 'remember' | 'forget' | 'inspect' | 'get' | 'getMany' | 'list' | 'correct' | 'forgetEntry' | 'forgetSource' | 'readEvidence' | 'canReadConversationEvidence' | 'close'}
class StoreError extends Error {constructor(readonly code: string) {super(code)}}

if (isMainThread || parentPort === null) throw new Error('mem0 store requires a Worker')
const port = parentPort
const data = parseData(workerData)
let sdk: Memory | undefined
let ledger: DatabaseSync | undefined
let closed = false
let tail = Promise.resolve()
let draining = false
const failed = new Set<string>()
let learningLock: DatabaseSync | undefined
let retryTimer: ReturnType<typeof setInterval> | undefined

port.on('message', (value: unknown) => {
  const request = parseRequest(value)
  if (!request) {port.postMessage({kind: 'protocol_error'}); return}
  if (['recall','get','getMany','list','readEvidence','canReadConversationEvidence','inspect'].includes(request.operation)) {void handle(request); return}
  tail = tail.then(() => handle(request), () => handle(request))
})

async function handle(request: Request): Promise<void> {
  try {
    const result = await execute(request)
    port.postMessage({kind: 'response', request_id: request.request_id, ok: true, result})
    if (request.operation === 'open' || request.operation === 'remember' || ['forget','forgetSource','forgetEntry'].includes(request.operation)) scheduleDrain()
  } catch (error) {
    const code = error instanceof StoreError || error instanceof PrivateDatabaseError ? error.code
      : request.operation === 'recall' ? 'STORE_RECALL_FAILED'
      : ['get','getMany','list','readEvidence','canReadConversationEvidence','inspect'].includes(request.operation) ? 'STORE_READ_FAILED' : 'STORE_WRITE_FAILED'
    port.postMessage({kind: 'response', request_id: request.request_id, ok: false, error_code: code})
  }
  if (request.operation === 'close') port.close()
}

async function execute(request: Request): Promise<unknown> {
  if (request.operation === 'open') return open()
  if (request.operation === 'close') {
    closed = true
    clearInterval(retryTimer)
    sdk = undefined
    ledger?.close(); ledger = undefined
    // The SDK has no public close API. The RPC owner terminates this Worker and its SQLite handles.
    return null
  }
  if (!ledger || !sdk || closed) throw new StoreError('STORE_CLOSED')
  if (request.operation === 'inspect') return inspect(request)
  if (request.operation === 'remember') return remember(request)
  if (request.operation === 'get') return get(request.id)
  if (request.operation === 'getMany') {
    if (!Array.isArray(request.ids) || request.ids.length > 100 || !request.ids.every(id=>text(id,256))) throw new StoreError('STORE_INVALID_INPUT')
    const entries = await Promise.all(request.ids.map(id=>get(id)))
    return entries.map(entry=>entry?.evidence_refs?.every(id=>source(id)?.state==='learned') ? entry : null)
  }
  if (request.operation === 'list') return list(request)
  if (request.operation === 'correct' || request.operation === 'forgetEntry') return mutateEntry(request)
  if (request.operation === 'readEvidence') return readEvidence(request.id)
  if (request.operation === 'canReadConversationEvidence') {
    if (!text(request.id,256) || !text(request.consumer,256)) return false
    const row=source(request.id)
    return !!row && row.state!=='forgotten' && !!data.conversationProviders?.includes(request.consumer)
      && (JSON.parse(row.conversation_providers) as string[]).includes(request.consumer)
  }
  if (request.operation === 'forget' || request.operation === 'forgetSource') {
    const sourceId = request.operation === 'forgetSource' ? request.ref : request.sourceId
    if (!text(sourceId, 256)) throw new StoreError('STORE_INVALID_INPUT')
    // The durable intent is written first: a crash before the tombstone leaves a harmless flag,
    // while a crash after it must never lose the physical-cleanup obligation.
    markCompactionPending()
    // Tombstone unknown ids too, so delayed admission cannot resurrect an explicitly deleted source.
    ledger.prepare(`INSERT INTO sources (id,payload,state,recorded_at,cleaned) VALUES (?, '', 'forgotten', ?, 0)
      ON CONFLICT(id) DO UPDATE SET payload='', state='forgotten', cleaned=0`).run(sourceId, new Date().toISOString())
    ledger.prepare('DELETE FROM item_edits WHERE source_id=?').run(sourceId)
    failed.delete(sourceId)
    return request.operation === 'forgetSource' ? null : {state: 'forgotten', source_id: sourceId}
  }
  return recall(request)
}

async function inspect(request: Request): Promise<MemoryInspection> {
  const parsed = memoryInspectionQuerySchema.safeParse({query: request.query, ...(request.before === undefined ? {} : {before: request.before})})
  if (!parsed.success) throw new StoreError('STORE_INVALID_INPUT')
  const opened = sdk!
  // ponytail: substring scan over local sources; add FTS if history makes this slow.
  const rows = ledger!.prepare(`SELECT rowid AS cursor, * FROM sources
    WHERE state != 'forgotten' AND rowid < ? AND instr(lower(json_extract(NULLIF(payload, ''), '$.text')), lower(?)) > 0
    ORDER BY rowid DESC LIMIT 11`).all(parsed.data.before ?? Number.MAX_SAFE_INTEGER, parsed.data.query) as unknown as (Source & {cursor: number})[]
  const entries: MemoryInspection['entries'] = []
  for (const row of rows.slice(0, 10)) {
    const found = row.state === 'learned'
      ? await opened.getAll({filters: {user_id: data.userId, nova_source_id: {eq: row.id}}, topK: 5}) : {results: []}
    if (closed || !ledger) throw new StoreError('STORE_CLOSED')
    if (ledger.prepare('SELECT state FROM sources WHERE id=?').get(row.id)?.state === 'forgotten') continue
    const payload = JSON.parse(row.payload) as {text: string}
    const facts = found.results.filter(item => item.metadata?.nova_source_id === row.id).map(item=>project(item)).filter((entry):entry is MemoryEntry=>entry!==null).map(entry=>entry.content)
    entries.push({sourceId: row.id, state: row.state as 'pending' | 'learned', recordedAt: row.recorded_at,
      original: payload.text.slice(0, 1500), memories: facts.slice(0, 4).map(text => text.slice(0, 500)),
      truncated: payload.text.length > 1500 || facts.length > 4 || facts.some(text => text.length > 500)})
  }
  return {engine: 'mem0', entries:entries.filter(entry=>source(entry.sourceId)?.state!=='forgotten'), next: rows.length > 10 ? rows[9]!.cursor : null}
}

const COMPACTION_KEY = 'compaction_pending'

function pendingCompaction(): boolean {
  return ledger?.prepare('SELECT value FROM meta WHERE key=?').get(COMPACTION_KEY)?.value === '1'
}

function markCompactionPending(): void {
  ledger?.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(COMPACTION_KEY, '1')
}

function clearCompactionPending(): void {
  ledger?.prepare('DELETE FROM meta WHERE key=?').run(COMPACTION_KEY)
}

/** A deleted row's bytes stay in free pages and the WAL until every database is rebuilt. */
function compactStore(): void {
  if (!ledger) return
  ledger.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON')
  ledger.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  ledger.exec('VACUUM')
  ledger.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  for (const name of ['vectors.db', 'vectors_entities.db']) {
    const path = join(data.path, name)
    if (!existsSync(path)) continue
    const database = new DatabaseSync(path)
    try {
      database.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON')
      database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      database.exec('VACUUM')
      database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } finally {
      database.close()
    }
  }
  clearCompactionPending()
}

function open() {
  if (ledger || closed) throw new StoreError('STORE_CLOSED')
  for (const name of ['ledger.db', 'vectors.db', 'vectors_entities.db', 'learning-lock.db']) {
    const path = preparePrivateDatabasePath(join(data.path, name))
    secureSidecar(path, '-wal'); secureSidecar(path, '-shm')
    if (existsSync(`${path}-journal`)) preparePrivateDatabasePath(`${path}-journal`)
  }
  try {
    ledger = new DatabaseSync(join(data.path, 'ledger.db'))
    ledger.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS owner (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','learned','forgotten')), recorded_at TEXT NOT NULL, cleaned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS item_edits (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, content TEXT NOT NULL,
        version TEXT NOT NULL, status TEXT NOT NULL, user_source TEXT, cleaned INTEGER NOT NULL DEFAULT 0);`)
    ledger.exec('BEGIN IMMEDIATE')
    try {
      if (!ledger.prepare('PRAGMA table_info(sources)').all().some(row=>row.name==='conversation_providers')) {
        ledger.exec("ALTER TABLE sources ADD COLUMN conversation_providers TEXT NOT NULL DEFAULT '[]'")
      }
      ledger.exec('COMMIT')
    } catch (error) {ledger.exec('ROLLBACK');throw error}
    learningLock = new DatabaseSync(join(data.path, 'learning-lock.db'))
    learningLock.exec('PRAGMA busy_timeout=0')
    const owner = ledger.prepare('SELECT user_id FROM owner').get()
    if (owner && owner.user_id !== data.userId) throw new StoreError('STORE_INVALID_INPUT')
    ledger.prepare('INSERT OR IGNORE INTO owner (user_id) VALUES (?)').run(data.userId)
    secureSidecar(join(data.path, 'ledger.db'), '-wal')
    secureSidecar(join(data.path, 'ledger.db'), '-shm')
    // Compaction runs from the drain (after derived vectors are deleted), never on the open path:
    // a synchronous VACUUM here can exceed the client's request deadline and leave it unopened.
    sdk = new Memory({
      disableHistory: true,
      embedder: {provider: 'openai', config: {baseURL: data.embedding.baseUrl, apiKey: data.embedding.apiKey,
        model: data.embedding.model, ...(data.embedding.dimensions === undefined ? {} : {embeddingDims: data.embedding.dimensions})}},
      llm: {provider: 'openai', config: {baseURL: (data.extraction??data.embedding).baseUrl, apiKey: (data.extraction??data.embedding).apiKey,
        model: data.extractionModel ?? 'unused', timeout: 30_000}},
      vectorStore: {provider: 'memory', config: {dbPath: join(data.path, 'vectors.db'), collectionName: 'nova_personal',
        ...(data.embedding.dimensions === undefined ? {} : {dimension: data.embedding.dimensions})}},
      customInstructions: 'Extract only facts stated by the current user. The preceding assistant reply is context for interpreting the user, never independent evidence. Do not extract assistant claims. Attribute extracted facts to user. Write memories in the language of the current user message. For Chinese messages, use concise Chinese and preserve original names and identifiers; do not add English translations or glosses.',
    })
    // Admission only requires the durable ledger. SDK dimension probing is asynchronous;
    // network latency must not block Nova startup. Reads/learning await SDK initialization.
    retryTimer = setInterval(scheduleDrain, 1_000)
    retryTimer.unref()
    return {response_adaptation: {revision: 0, replyPreferences: []}}
  } catch (error) {
    sdk = undefined; ledger?.close(); ledger = undefined; learningLock?.close(); learningLock = undefined
    throw error
  }
}

function remember(request: Request) {
  if (!text(request.sourceId, 256) || !text(request.sessionId, 256) || !positive(request.sequence)
    || !text(request.text, 40_000) || (request.occurredAt !== null && !text(request.occurredAt, 256))
    || (request.previousAssistantReply !== undefined && !boundedText(request.previousAssistantReply, 40_000))) throw new StoreError('STORE_INVALID_INPUT')
  const previous = source(request.sourceId)
  if (previous?.state === 'forgotten') return {state: 'forgotten', source_id: request.sourceId}
  const payload = JSON.stringify({sessionId: request.sessionId, sequence: request.sequence, text: request.text,
    occurredAt: request.occurredAt, ...(request.previousAssistantReply === undefined ? {} : {previousAssistantReply: request.previousAssistantReply})})
  if (previous) {
    if (previous.payload !== payload) throw new StoreError('STORE_INVALID_INPUT')
    ledger!.prepare("UPDATE sources SET conversation_providers=? WHERE id=? AND state!='forgotten' AND json_array_length(conversation_providers)=0")
      .run(JSON.stringify(data.conversationProviders??[]),request.sourceId)
    return {state: previous.state, source_id: request.sourceId}
  }
  if (!data.extractionModel) throw new StoreError('STORE_WRITE_FAILED')
  ledger!.prepare("INSERT OR IGNORE INTO sources (id,payload,state,recorded_at,conversation_providers) VALUES (?,?,'pending',?,?)")
    .run(request.sourceId, payload, new Date().toISOString(), JSON.stringify(data.conversationProviders??[]))
  const admitted = source(request.sourceId)!
  if (admitted.state !== 'forgotten' && admitted.payload !== payload) throw new StoreError('STORE_INVALID_INPUT')
  return {state: admitted.state, source_id: request.sourceId}
}

async function recall(request: Request): Promise<VoiceMemRecallResult> {
  if (!text(request.query, 4_000) || (request.scope !== 'recent' && request.scope !== 'any')
    || !positive(request.limit) || request.limit > 5) throw new StoreError('STORE_INVALID_INPUT')
  const opened = sdk!
  // ponytail: local SDK already scans SQLite vectors; source-id filtering is linear until scale warrants a different provider.
  const candidates = ledger!.prepare(`SELECT id FROM sources WHERE state='learned' ORDER BY rowid DESC${request.scope === 'recent' ? ' LIMIT 5' : ''}`).all()
    .map(row => String(row.id))
  const hits: VoiceMemRecallHit[] = []
  if (candidates.length) {
    const result = await opened.search(request.query, {topK: request.limit, filters: {user_id: data.userId, nova_source_id: {in: candidates}}})
    if (closed || sdk !== opened) throw new StoreError('STORE_CLOSED')
    for (const item of result.results) {
      const id: unknown = item.metadata?.nova_source_id
      if (!text(id, 256) || !candidates.includes(id) || item.attributedTo === 'assistant') continue
      const row = source(id)
      // Recheck after the await: a concurrent forget must hide even an already-running query.
      if (row?.state !== 'learned') continue
      if (!text(item.id, 256) || !text(item.memory, Number.MAX_SAFE_INTEGER) || !Number.isFinite(item.score)) throw new StoreError('STORE_RECALL_FAILED')
      const payload = JSON.parse(row.payload) as {occurredAt: string | null}
      const entry = project(item)
      if (!entry) continue
      hits.push({memoryId: item.id, kind: 'fact', text: entry.content, subject: data.userId,
        attribute: '', emotion: '', occurredAt: payload.occurredAt, recordedAt: row.recorded_at,
        score: Math.max(-1, Math.min(1, item.score!)), evidenceIds: [id]})
    }
  }
  return {source: 'personal', state: hits.length ? 'ok' : 'empty', scope: request.scope, hits, rightBrainHits: [], degraded: ledger!.prepare("SELECT 1 FROM sources WHERE state='pending' LIMIT 1").get() !== undefined}
}

type Item = NonNullable<Awaited<ReturnType<Memory['get']>>>
interface ItemEdit {source_id:string;content:string;version:string;status:'active'|'forgotten';user_source:string|null}

interface ProjectionRows {sources:Map<string,Source>;edits:Map<string,ItemEdit>}
function project(item:Item,rows?:ProjectionRows):MemoryEntry|null {
  const sourceId:unknown = item.metadata?.nova_source_id
  if (!text(sourceId,256) || !text(item.id,256) || !text(item.memory,Number.MAX_SAFE_INTEGER) || item.attributedTo==='assistant') return null
  const row=rows?rows.sources.get(sourceId):source(sourceId)
  if (row?.state!=='learned') return null
  const edit=rows?rows.edits.get(item.id):ledger!.prepare('SELECT * FROM item_edits WHERE id=?').get(item.id) as ItemEdit|undefined
  if (edit?.status==='forgotten') return null
  const content=edit?.content??truncate(item.memory,500)
  // SDK timestamps are durable per item; older SDK rows fall back to canonical-content hashes.
  const version=edit?.version??createHash('sha256').update(item.updatedAt ? JSON.stringify([item.updatedAt,content]) : content).digest('hex')
  const original={type:'conversation' as const,ref:sourceId,observed_at:row.recorded_at}
  return {id:item.id,version,content,kind:'fact',origin:'inferred',source_refs:edit?.user_source?[original,MemorySourceRefSchema.parse(JSON.parse(edit.user_source))]:[original],
    evidence_refs:[sourceId],observed_at:row.recorded_at,recorded_at:row.recorded_at,topic:'',status:'active',corrected_to:null,confidence_note:null}
}
async function get(id:unknown):Promise<MemoryEntry|null> {
  if (!text(id,256)) throw new StoreError('STORE_INVALID_INPUT')
  const opened=sdk!
  const item=await opened.get(id)
  if (closed || sdk!==opened || !ledger) throw new StoreError('STORE_CLOSED')
  return item?.id===id ? project(item) : null
}
async function list(request:Request) {
  const parsed=MemoryListOptionsSchema.safeParse({...(request.cursor===undefined?{}:{cursor:request.cursor}),...(request.limit===undefined?{}:{limit:request.limit}),...(request.include_expired===undefined?{}:{include_expired:request.include_expired})})
  if (!parsed.success || parsed.data.include_expired===true) throw new StoreError('STORE_INVALID_INPUT')
  const opened=sdk!,limit=parsed.data.limit??100
  const found=await opened.getAll({filters:{user_id:data.userId},topK:Number.MAX_SAFE_INTEGER})
  if (closed || sdk!==opened || !ledger) throw new StoreError('STORE_CLOSED')
  // The SDK has no cursor: each request scans O(n) items once, without cross-request caching.
  // Batch local overrides/sources; only hydrate the selected page after cursor filtering and sorting.
  const rows:ProjectionRows={
    sources:new Map((ledger.prepare('SELECT * FROM sources').all() as unknown as Source[]).map(row=>[row.id,row])),
    edits:new Map((ledger.prepare('SELECT * FROM item_edits').all() as unknown as (ItemEdit & {id:string})[]).map(row=>[row.id,row])),
  }
  const candidates=found.results.filter(item=>{
    const id:unknown=item.metadata?.nova_source_id
    return text(item.id,256)&&text(id,256)&&text(item.memory,Number.MAX_SAFE_INTEGER)&&item.attributedTo!=='assistant'
      &&rows.sources.get(id)?.state==='learned'&&rows.edits.get(item.id)?.status!=='forgotten'
      &&(parsed.data.cursor===undefined||item.id>parsed.data.cursor)
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
  const entries=candidates.slice(0,limit).map(item=>project(item,rows)!)
  return {entries,cursor:candidates.length>limit?entries[limit-1]!.id:null}
}
function readEvidence(id:unknown) {
  if (!text(id,256)) throw new StoreError('STORE_INVALID_INPUT')
  const row=source(id)
  if (!row || row.state==='forgotten') return null
  const payload=JSON.parse(row.payload) as {text:string}
  return {evidence_id:id,locator:id,text:payload.text,source_kind:'conversation',observed_at:row.recorded_at,trust:'untrusted_external'}
}
async function mutateEntry(request:Request) {
  if (!text(request.id,256) || request.expectedVersion===null || (typeof request.expectedVersion!=='string' && typeof request.expectedVersion!=='number')) throw new StoreError('STORE_INVALID_INPUT')
  const correcting=request.operation==='correct'
  const userSource=correcting?MemorySourceRefSchema.safeParse(request.userSource):undefined
  if (correcting && (!text(request.content,500) || !userSource?.success)) throw new StoreError('STORE_INVALID_INPUT')
  const opened=sdk!,item=await opened.get(request.id)
  if (closed || sdk!==opened || !ledger) throw new StoreError('STORE_CLOSED')
  ledger.exec('BEGIN IMMEDIATE')
  try {
    const previous=item?project(item):null
    if (!previous) throw new StoreError('STORE_NOT_FOUND')
    if (previous.version!==request.expectedVersion) throw new StoreError('STORE_STALE_REVISION')
    const version=randomUUID(),status=correcting?'active':'forgotten'
    ledger.prepare(`INSERT INTO item_edits(id,source_id,content,version,status,user_source,cleaned) VALUES (?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content,version=excluded.version,status=excluded.status,user_source=excluded.user_source,cleaned=0`)
      .run(request.id,previous.evidence_refs![0]!,correcting?String(request.content):'',version,status,userSource?.success?JSON.stringify(userSource.data):null)
    if (!correcting) markCompactionPending()
    const entry=correcting?project(item!)!:{...previous,content:'',version,status:'forgotten' as const}
    ledger.exec('COMMIT')
    return correcting?{previous,entry}:entry
  } catch(error) {ledger.exec('ROLLBACK');throw error}
}

function source(id: string): Source | undefined {
  return ledger?.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source | undefined
}

function scheduleDrain() {
  if (draining || closed || !sdk || !ledger) return
  // ponytail: serialize extraction per owner; separate locks per source if throughput requires it.
  // A separate SQLite transaction does not block ledger admission. OS locks survive sleep and
  // release on Worker termination, so stale owners can never overlap a replacement drainer.
  try { learningLock!.exec('BEGIN IMMEDIATE') } catch (error) {
    if ((error as {errcode?: number}).errcode === 5) return
    console.error('[personal-memory] learning_lock_failed')
    return
  }
  draining = true
  const opened = sdk
  void (async () => {
    for (;;) {
      if (closed || sdk !== opened || !ledger) return
      const deleted = ledger.prepare("SELECT id FROM item_edits WHERE status='forgotten' AND cleaned=0").all()
      for (const row of deleted) {
        try {
          await deleteIfPresent(opened, String(row.id))
          if (closed || sdk !== opened || !ledger) return
          ledger.prepare('UPDATE item_edits SET cleaned=1 WHERE id=?').run(row.id!)
        } catch { /* durable per-item tombstone retries on the next drain */ }
      }
      const next = (ledger.prepare("SELECT * FROM sources WHERE state='pending' OR (state='forgotten' AND cleaned=0) ORDER BY rowid").all() as unknown as Source[])
        .find(row => !failed.has(row.id) && (row.state === 'forgotten' || data.extractionModel !== undefined))
      if (!next) return
      try {
        // A user edit freezes extraction for this source: SDK re-add assigns new ids and would
        // otherwise resurrect corrected/forgotten facts. Source erasure still cleans every item.
        if (next.state === 'pending' && ledger.prepare('SELECT 1 FROM item_edits WHERE source_id=? LIMIT 1').get(next.id)) {
          ledger.prepare("UPDATE sources SET state='learned' WHERE id=? AND state='pending'").run(next.id)
          continue
        }
        // Clean crash-interrupted ADDs before re-extraction; source metadata scopes every public deletion.
        await deleteDerived(opened, next.id)
        if (closed || sdk !== opened) return
        if (source(next.id)?.state === 'forgotten') {
          ledger.prepare('UPDATE sources SET cleaned=1 WHERE id=?').run(next.id)
          continue
        }
        const payload = JSON.parse(next.payload) as {text: string; previousAssistantReply?: string}
        const added = await opened.add([
          ...(payload.previousAssistantReply ? [{role: 'assistant', content: payload.previousAssistantReply}] : []),
          {role: 'user', content: payload.text},
        ], {userId: data.userId, filters: {nova_source_id: {eq: next.id}}, metadata: {nova_source_id: next.id}, infer: true})
        if (closed || sdk !== opened) return
        if (source(next.id)?.state === 'forgotten') {
          await deleteDerived(opened, next.id)
          if (!closed) ledger.prepare('UPDATE sources SET cleaned=1 WHERE id=?').run(next.id)
        } else {
          // Context may aid interpretation but cannot become an independently recalled assistant claim.
          const results = await opened.getAll({filters: {user_id: data.userId, nova_source_id: {eq: next.id}}, topK: Number.MAX_SAFE_INTEGER})
          for (const item of results.results) if (item.attributedTo === 'assistant') await deleteIfPresent(opened, item.id)
          // ponytail: SDK empty results cannot distinguish no facts from swallowed failures; retry on reopen.
          const persisted = new Set(results.results.filter(item => item.attributedTo !== 'assistant').map(item => item.id))
          if (!added.results.length || !persisted.size || added.results.some(item => !persisted.has(item.id))) throw new StoreError('STORE_WRITE_FAILED')
          if (!closed) ledger.prepare("UPDATE sources SET state='learned' WHERE id=? AND state='pending'").run(next.id)
        }
      } catch {
        // Retry each failed source once per Worker lifetime; pending evidence survives restart.
        failed.add(next.id)
      }
    }
  })().catch(() => undefined).finally(() => {
    learningLock?.exec('ROLLBACK')
    draining = false
    // Compact only after every forgotten source finished deleting its derived vectors.
    if (pendingCompaction() && !ledger?.prepare("SELECT 1 FROM sources WHERE state='forgotten' AND cleaned=0 LIMIT 1").get() && !ledger?.prepare("SELECT 1 FROM item_edits WHERE status='forgotten' AND cleaned=0 LIMIT 1").get()) {
      try { compactStore() } catch { /* keep the durable intent for the next attempt */ }
    }
  })
}

async function deleteIfPresent(opened: Memory, id: string): Promise<void> {
  try {await opened.delete(id)} catch (error) {
    // SDK delete throws after an interrupted cleanup already removed the vector. Verify absence
    // instead of matching SDK diagnostics; read failures must keep the cleanup obligation pending.
    if (await opened.get(id) !== null) throw error
  }
}

async function deleteDerived(opened: Memory, id: string) {
  for (;;) {
    if (closed || sdk !== opened) return
    const found = await opened.getAll({filters: {user_id: data.userId, nova_source_id: {eq: id}}, topK: 100, showExpired: true})
    if (!found.results.length) return
    for (const item of found.results) {
      if (closed || sdk !== opened) return
      if (item.metadata?.nova_source_id !== id) throw new StoreError('STORE_WRITE_FAILED')
      await deleteIfPresent(opened, item.id)
    }
  }
}

function parseData(value: unknown): Data {
  if (!record(value) || !keys(value, ['path', 'userId', 'embedding', 'extractionModel', 'extraction', 'conversationProviders'])
    || (value.conversationProviders !== undefined && (!Array.isArray(value.conversationProviders) || value.conversationProviders.length > 100 || !value.conversationProviders.every(v=>text(v,256))))
    || !text(value.path, 4096) || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || !text(value.userId, 256) || value.userId === '*' || /\s/u.test(value.userId)
    || !record(value.embedding) || !keys(value.embedding, ['baseUrl', 'apiKey', 'model', 'dimensions'])
    || !text(value.embedding.baseUrl, 2048) || !text(value.embedding.apiKey, 4096) || !text(value.embedding.model, 256)
    || (value.embedding.dimensions !== undefined && (!positive(value.embedding.dimensions) || value.embedding.dimensions > 4096))
    || (value.extraction !== undefined && (!record(value.extraction) || !keys(value.extraction, ['baseUrl', 'apiKey']) || !text(value.extraction.baseUrl, 2048) || !boundedText(value.extraction.apiKey, 4096)))
    || (value.extractionModel !== undefined && !text(value.extractionModel, 256))) throw new Error('invalid mem0 Worker data')
  return value as unknown as Data
}
function parseRequest(value: unknown): Request | undefined {
  if (!record(value) || value.kind !== 'request' || !positive(value.request_id) || !['open', 'recall', 'remember', 'forget', 'inspect', 'get', 'getMany', 'list', 'correct', 'forgetEntry', 'forgetSource', 'readEvidence', 'canReadConversationEvidence', 'close'].includes(String(value.operation))) return undefined
  const entryFields:Record<string,string[]> = {get:['id'],getMany:['ids'],list:['cursor','limit','include_expired'],correct:['id','expectedVersion','content','userSource'],forgetEntry:['id','expectedVersion'],forgetSource:['ref'],readEvidence:['id'],canReadConversationEvidence:['id','consumer']}
  const fields = entryFields[String(value.operation)] ?? (value.operation === 'remember' ? ['sourceId', 'sessionId', 'sequence', 'text', 'occurredAt', 'previousAssistantReply']
    : value.operation === 'inspect' ? ['query', 'before'] : value.operation === 'recall' ? ['query', 'scope', 'limit'] : value.operation === 'forget' ? ['sourceId'] : [])
  return keys(value, ['kind', 'request_id', 'operation', ...fields]) ? value as Request : undefined
}
function record(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value)}
function keys(value: Record<string, unknown>, allowed: string[]) {return Object.keys(value).every(key => allowed.includes(key))}
function positive(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value > 0}
function boundedText(value: unknown, max: number): value is string {return typeof value === 'string' && value.length <= max && !value.includes('\0')}
function text(value: unknown, max: number): value is string {return boundedText(value, max) && value.trim().length > 0}
function truncate(value: string, max: number) {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}
