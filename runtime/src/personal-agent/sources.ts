import {homedir} from 'node:os'
import {processingGrantSchema,type ProcessingGrant} from '../memory-substrate/source-state.js'
import {interleave} from './sampling.js'
import {randomUUID} from 'node:crypto'
import {acquirePersonalLock} from './store.js'
import {lstat, readdir, opendir, open, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises'
import {basename, parse, dirname, extname, isAbsolute, join, relative, sep} from 'node:path'
import {z} from 'zod'
import {preparePrivateDatabasePath} from '../storage/private-database.js'
import {SensitivePathPolicy} from '../memory/sensitivity.js'
import type {KnowledgeService} from '../knowledge/service.js'

export const SOURCE_EXCLUDES = ['.git', '.worktrees', '.codex', '.claude', 'node_modules', 'dist', 'build', 'target', '.cache', '__pycache__', '.venv', 'venv', 'Library', 'Browser', 'Chrome', 'Chromium', 'Firefox', 'Safari'] as const
const COMPUTER_EXCLUDES = ['Applications', 'opt', 'System', 'Windows', 'Program Files', 'Program Files (x86)', '$RECYCLE.BIN', 'System Volume Information', 'private', 'dev', 'proc', 'sys', 'bin', 'sbin', 'usr', 'etc', 'var', '.Trash', '.Trashes', '.npm', '.cargo', '.rustup', '.local', '.nova-audio-agent']
const policy = new SensitivePathPolicy()
const pathSchema = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'))
const idSchema = z.string().uuid()
const excludeSchema = z.array(z.string().min(1).max(100).regex(/^[^/\\\0]+$/u)).max(32)
const snapshotSchema = z.object({
  scope: z.enum(['directory','computer']).default('directory'), scan_pending:z.boolean().default(false), indexed:z.number().int().nonnegative().default(0),
  id: idSchema, path: pathSchema, state: z.enum(['connected', 'paused', 'disconnected', 'error']),
  scanned: z.number().int().nonnegative(), read: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  reasons: z.record(z.string(), z.number().int().nonnegative()),
  failures: z.array(z.object({path: z.string().max(4096), code: z.string().max(80)}).strict()).max(50),
  last_sync: z.string().datetime().nullable(), excludes: excludeSchema,
  processing_consent_required:z.boolean().optional(),
  max_files: z.number().int().min(1).max(200), max_bytes: z.number().int().min(1).max(20 * 1024 * 1024),
}).strict()
export type SourceSnapshot = z.infer<typeof snapshotSchema>
const trackedSchema = z.object({unit: pathSchema.optional(), path: pathSchema, id: z.string().min(1).max(80), fingerprint: z.string().max(256),
  evidence_ids: z.array(z.string().min(1).max(600)).min(1).max(2).optional(), size: z.number().nonnegative(), mtime: z.number(), owned: z.boolean(), valid: z.boolean().default(true), excerpt: z.string().max(900).nullable().default(null), observed: z.boolean().default(false), observation_ref: z.string().max(80).nullable().default(null)}).strict()
const walkSchema=z.object({queue:z.array(z.object({path:pathSchema,offset:z.number().int().nonnegative()}).strict()).max(20000),pending:z.array(z.object({path:pathSchema,size:z.number(),mtime:z.number(),unit:pathSchema}).strict()).max(200)}).strict()
const recordSchema = z.object({walk:walkSchema.nullable().default(null),processing_consent:processingGrantSchema.optional(),view: snapshotSchema, files: z.array(trackedSchema).max(20000),
  deleting: z.boolean().default(false), observation: z.string().max(500).default(''),
  pending: z.object({path: pathSchema, size: z.number().nonnegative(), mtime: z.number(), owned: z.boolean(), previous_updated_at: z.number().nullable()}).strict().nullable().default(null)}).strict()
type SourceRecord = z.infer<typeof recordSchema>
const diskSchema = z.object({version: z.literal(1), sources: z.array(recordSchema).max(8)}).strict()
const supported = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.pdf', '.docx'])
const overviewDocument = (path: string) => /^(?:readme(?:[._-][a-z]+)?|overview|about|project)\.(?:md|markdown|txt)$/iu.test(basename(path))
const representativeDocument = (path: string) => /\.(?:md|markdown|txt|pdf|docx)$/iu.test(path)
const generatedFile = (path: string) => /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.min\.js$|\.d\.ts$|\.generated\./iu.test(basename(path))
function balanced<T extends {path: string; unit?: string | undefined}>(files: T[], root: string): T[] {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const unit = file.unit ?? join(root, relative(root, file.path).split(sep).slice(0, -1)[0] ?? '')
    const group = groups.get(unit) ?? []; group.push(file); groups.set(unit, group)
  }
  return interleave(groups.values(), files.length)
}
const refFor = (file: SourceRecord['files'][number]) => `file:${file.id}:${file.fingerprint}`
const errorCode = (error: unknown) => error instanceof Error && /^(?:knowledge_busy|ingest_failed|source_busy)$/u.test(error.message) ? error.message : 'source_unavailable'

export interface LocalDirectorySourceOptions {
  readonly computerRoot?: string
  readonly path: string
  readonly knowledge: Pick<KnowledgeService, 'listSources' | 'handle' | 'syncFile'>
  readonly pollMs?: number
  readonly onChange?: (changed: boolean) => void | Promise<void>
  readonly onInvalidate?: (ref: string) => void | Promise<void>
  readonly processingGrant?: (consent:boolean,revision:number,scopeRevision:number)=>ProcessingGrant | undefined
  readonly onProcessingConsent?: (sourceIds:string[],grant:ProcessingGrant)=>Promise<void>
  readonly onObserve?: (source: {source_ref: {type: 'file'; ref: string; observed_at: string}; content: string; topic?: string; evidence_ids?: string[]; processing_consent?:ProcessingGrant}) => void | Promise<void>
}

/** Opt-in local grants. Existing knowledge ingestion owns parsing, screening and embeddings. */
export class LocalDirectorySources {
  readonly #options: LocalDirectorySourceOptions
  #records: SourceRecord[] = []
  #release: (() => Promise<void>) | undefined
  #path = ''
  #timer: ReturnType<typeof setInterval> | undefined
  #closed = true
  #active: {id: string; abort: AbortController; done: Promise<void>} | undefined
  #writes: Promise<void> = Promise.resolve()
  #commands: Promise<unknown> = Promise.resolve()

  constructor(options: LocalDirectorySourceOptions) {this.#options = options}
  async open(): Promise<void> {
    this.#path = preparePrivateDatabasePath(this.#options.path)
    this.#release = await acquirePersonalLock(this.#path)
    const info = await lstat(this.#path)
    if (info.size > 32 * 1024 * 1024) throw new Error('sources_state_too_large')
    const text = await readFile(this.#path, 'utf8')
    this.#records = text.trim() ? diskSchema.parse(JSON.parse(text)).sources : []
    this.#closed = false
    for (const record of [...this.#records]) {
      await this.#recoverPending(record)
      if (record.deleting) await this.#delete(record)
      else if (record.view.state === 'connected' || record.view.state === 'error') {if(record.view.scope==='computer'){const timer=setTimeout(()=>{if(!this.#closed)void this.#sync(record).catch(()=>undefined)},0);timer.unref()}else await this.#sync(record)}
    }
    const pollMs = this.#options.pollMs ?? 300000
    if (pollMs > 0) {this.#timer = setInterval(() => {void this.#poll().catch(() => undefined)}, pollMs); this.#timer.unref()}
  }
  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    this.#active?.abort.abort()
    await this.#active?.done
    await this.#commands.catch(() => undefined)
    await this.#writes
    await this.#release?.(); this.#release = undefined
  }
  list(): SourceSnapshot[] {const expected=this.#options.processingGrant?.(true,1,0);return this.#records.map(record => ({...structuredClone(record.view), processing_consent_required:!record.processing_consent?.extraction_provider||record.processing_consent.extraction_provider!==expected?.extraction_provider||record.processing_consent.embedding_provider!==expected?.embedding_provider, excludes: [...new Set([...SOURCE_EXCLUDES, ...(record.view.scope==='computer'?COMPUTER_EXCLUDES:[]), ...record.view.excludes])]}))}
  evidence(ref: string) {
    for (const record of this.#records) {
      const file = record.files.find(file => refFor(file) === ref)
      if (file?.valid && !record.deleting) return {subject_key: `file:${file.id}`, source: {type: 'file' as const, ref}}
    }
    return null
  }
  contextEntries():{id:string;version:string;content:string}[]{
    const expected=this.#options.processingGrant?.(true,1,0)
    return this.#records.filter(r=>!r.deleting&&['connected','error'].includes(r.view.state)&&!!r.processing_consent?.extraction_provider&&r.processing_consent.extraction_provider===expected?.extraction_provider&&r.processing_consent.embedding_provider===expected?.embedding_provider).flatMap(record=>record.files.filter(f=>f.valid&&f.excerpt).map(file=>({id:'source:'+file.id,version:file.fingerprint,content:`${relative(record.view.path,file.path)}: ${file.excerpt}`.slice(0,1200)})))
  }
  evidenceSnapshot(): {ref: string; summary: string}[] {
    const fingerprints = new Set<string>()
    return interleave(this.#records.filter(record => !record.deleting).map(record =>
      balanced(record.files.filter(file => file.valid), record.view.path).map(file => ({
        ref: refFor(file), fingerprint: file.fingerprint,
        summary: `已授权本地文件：${relative(record.view.path, file.path).slice(0, 160)}`,
      }))), Infinity).filter(file => {
        if (fingerprints.has(file.fingerprint)) return false
        fingerprints.add(file.fingerprint); return true
      }).slice(0, 8).map(({ref, summary}) => ({ref, summary}))
  }
  command(method: string, params: unknown): Promise<unknown> {
    // Revocation fences the current ingestion immediately, before waiting for serialized commands.
    if (['sources.pause', 'sources.disconnect', 'sources.delete','sources.consent'].includes(method)) {
      const parsed = z.object({id: idSchema,consent:z.boolean().optional()}).strict().safeParse(params)
      if (parsed.success && this.#active?.id === parsed.data.id) this.#active.abort.abort()
    }
    const result = this.#commands.then(async () => {await this.#active?.done; return this.#command(method, params)})
    this.#commands = result.catch(() => undefined)
    return result
  }
  async #command(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error('sources_closed')
    if (method === 'sources.authorize_computer') {
      z.object({consent:z.literal(true)}).strict().parse(params)
      const existing=this.#records.find(r=>r.view.scope==='computer');if(existing)return {id:existing.view.id}
      return this.#addComputer()
    }
    if (method === 'sources.add') {
      const parsed = z.object({path: pathSchema, consent: z.literal(true), excludes: excludeSchema.optional(),
        max_files: snapshotSchema.shape.max_files.optional(), max_bytes: snapshotSchema.shape.max_bytes.optional()}).strict().safeParse(params)
      if (!parsed.success) throw new Error('invalid_request')
      const path = await realpath(parsed.data.path)
      if (!policy.allows(path) || !policy.allows(parsed.data.path) || path.split(/[/\\]/u).some(part => SOURCE_EXCLUDES.some(excluded => excluded.toLowerCase() === part.toLowerCase())) || !(await lstat(path)).isDirectory()) throw new Error('path_denied')
      if (this.#records.length >= 8) throw new Error('source_limit')
      if (this.#records.some(record => within(record.view.path, path) || within(path, record.view.path))) throw new Error('source_exists')
      const record: SourceRecord = {walk:null,view: {scope:'directory',scan_pending:false,indexed:0,id: randomUUID(), path, state: 'connected', scanned: 0, read: 0, skipped: 0,
        reasons: {}, failures: [], last_sync: null, excludes: parsed.data.excludes ?? [],
        max_files: parsed.data.max_files ?? 200, max_bytes: parsed.data.max_bytes ?? 20 * 1024 * 1024}, files: [], deleting: false, observation: '', pending: null}
      const grant=this.#options.processingGrant?.(parsed.data.consent,1,0);if(grant)record.processing_consent=grant
      this.#records.push(record)
      try {await this.#save()} catch (error) {this.#records.pop(); throw error}
      await this.#sync(record)
      return {id: record.view.id}
    }
    if(method==='sources.consent'){
      const q=z.object({id:idSchema,consent:z.boolean()}).strict().parse(params)
      const record=this.#records.find(r=>r.view.id===q.id);if(!record)throw Error('source_gone')
      const grant=this.#options.processingGrant?.(q.consent,(record.processing_consent?.revision??0)+1,record.processing_consent?.scope_revision??0)
      if(!grant)throw Error('memory_unavailable')
      await this.#options.onProcessingConsent?.(record.files.flatMap(f=>['knowledge:'+f.id,...(f.observation_ref?[f.observation_ref]:[])]),grant)
      record.processing_consent=grant
      for(const file of record.files)file.observed=false
      await this.#save();await this.#options.onChange?.(false);return {ok:true}
    }
    const parsed = z.object({id: idSchema}).strict().safeParse(params)
    if (!parsed.success) throw new Error('invalid_request')
    const record = this.#records.find(record => record.view.id === parsed.data.id)
    if (!record) throw new Error('source_gone')
    if (method === 'sources.delete') {await this.#delete(record); return {ok: true}}
    if (record.view.state === 'disconnected' && ['sources.pause', 'sources.resume', 'sources.sync'].includes(method)) throw new Error('source_disconnected')
    if (method === 'sources.pause' || method === 'sources.disconnect') {
      const before = record.view.state
      record.view.state = method === 'sources.pause' ? 'paused' : 'disconnected'
      try {await this.#save()} catch (error) {record.view.state = before; throw error}
    } else if (method === 'sources.resume') {
      record.view.state = 'connected'; await this.#save(); await this.#sync(record)
    } else if (method === 'sources.sync') {
      if (record.view.state === 'connected' || record.view.state === 'error') await this.#sync(record)
    } else throw new Error('invalid_request')
    await this.#options.onChange?.(false)
    return {ok: true}
  }
  async #addComputer():Promise<{id:string}>{
    if(this.#records.length>=8)throw Error('source_limit')
    const path=await realpath(this.#options.computerRoot??parse(homedir()).root)
    const record:SourceRecord={walk:null,view:{scope:'computer',scan_pending:true,indexed:0,id:randomUUID(),path,state:'connected',scanned:0,read:0,skipped:0,reasons:{},failures:[],last_sync:null,excludes:[],max_files:200,max_bytes:20*1024*1024},files:[],deleting:false,observation:'',pending:null}
    const grant=this.#options.processingGrant?.(true,1,0);if(grant)record.processing_consent=grant
    this.#records.push(record);try{await this.#save()}catch(error){this.#records.pop();throw error}
    // The grant returns immediately; indexing cannot block the settings window.
    void this.#sync(record).catch(()=>undefined)
    return {id:record.view.id}
  }
  async #computerBatch(record:SourceRecord,signal:AbortSignal):Promise<{path:string;size:number;mtime:number;unit:string}[]>{
    const walk=record.walk??={queue:[{path:record.view.path,offset:0}],pending:[]}
    const excluded=new Set([...SOURCE_EXCLUDES,...COMPUTER_EXCLUDES,...record.view.excludes].map(s=>s.toLowerCase()))
    let visited=0
    while(walk.queue.length&&walk.pending.length<16&&visited<20000){
      signal.throwIfAborted();const directory=walk.queue[0]!
      try{
        if(directory.path!==record.view.path&&relative(record.view.path,directory.path).split(sep).some(part=>excluded.has(part.toLowerCase()))){walk.queue.shift();continue}
        if(await realpath(directory.path)!==directory.path){walk.queue.shift();continue}
        const entries=(await readdir(directory.path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))
        const names=new Set(entries.map(e=>e.name));for(const file of [...record.files])if(dirname(file.path)===directory.path&&!names.has(basename(file.path)))await this.#removeFile(record,file)
        while(directory.offset<entries.length&&walk.pending.length<16&&visited++<20000){
          const entry=entries[directory.offset++]!,path=join(directory.path,entry.name)
          if(excluded.has(entry.name.toLowerCase())||!policy.allows(path)||entry.isSymbolicLink()){record.view.skipped++;continue}
          if(entry.isDirectory()){
            if(this.#records.some(r=>r!==record&&within(r.view.path,path)))continue
            if(walk.queue.length>=20000)throw Error('directory_capacity')
            walk.queue.push({path,offset:0})
          }else if(entry.isFile()){
            record.view.scanned++
            if(!supported.has(extname(path).toLowerCase())||generatedFile(path)){record.view.skipped++;continue}
            const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())continue
            walk.pending.push({path,size:stat.size,mtime:stat.mtimeMs,unit:dirname(path)})
          }
        }
        if(directory.offset>=entries.length)walk.queue.shift()
      }catch(error){signal.throwIfAborted();if(record.view.failures.length<50)record.view.failures.push({path:directory.path,code:error instanceof Error&&'code' in error?String(error.code):'directory_unavailable'});walk.queue.shift()}
    }
    record.view.scan_pending=walk.queue.length>0||walk.pending.length>0
    await this.#save()
    return [...walk.pending]
  }
  async #poll(): Promise<void> {
    if (this.#closed || this.#active) return
    for (const record of this.#records) {
      if (this.#closed) return
      if (record.view.state === 'connected' || record.view.state === 'error') await this.#sync(record)
    }
  }
  async #sync(record: SourceRecord): Promise<void> {
    if (this.#closed || this.#active) return
    const abort = new AbortController()
    const done = this.#scan(record, abort.signal)
    this.#active = {id: record.view.id, abort, done}
    try {await done} finally {this.#active = undefined;if(record.view.scope==='computer'&&record.view.scan_pending&&!this.#closed&&['connected','error'].includes(record.view.state)){const timer=setTimeout(()=>{if(!this.#closed&&!this.#active&&['connected','error'].includes(record.view.state))void this.#sync(record).catch(()=>undefined)},record.view.state==='error'?30000:1000);timer.unref()}}
  }
  async #scan(record: SourceRecord, signal: AbortSignal): Promise<void> {
    const view = record.view
    const beforeEvidence = record.files.filter(file => file.valid).map(refFor).sort().join()
    const beforeObservation = record.observation
    view.read=0; if(view.scope!=='computer'||record.walk===null){view.scanned=0;view.skipped=0;view.reasons={};view.failures=[]}
    const skip = (reason: string) => {view.skipped++; view.reasons[reason] = (view.reasons[reason] ?? 0) + 1}
    const files: {path: string; size: number; mtime: number; unit: string}[] = []
    const seen = new Set<string>(), excluded = new Set([...SOURCE_EXCLUDES, ...view.excludes].map(name => name.toLowerCase()))
    const directories = [{path: view.path, depth: 0, project: null as string | null}]
    const projectEntries = new Map<string, number>()
    const projects = new Set<string>()
    let complete = true, visited = 0
    try {
      if (await realpath(view.path) !== view.path) throw new Error('path_denied')
      if(view.scope==='computer'){files.push(...await this.#computerBatch(record,signal));directories.length=0;complete=false}
      while (directories.length > 0 && visited < 20000) {
        signal.throwIfAborted()
        const directory = directories.shift()!
        if (await realpath(directory.path) !== directory.path) {complete = false; skip('changed_path'); continue}
        const marker = await lstat(join(directory.path, '.git')).catch(() => null)
        if (marker && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) {
          directory.project = directory.path; projects.add(directory.path)
        }
        for await (const entry of await opendir(directory.path)) {
          signal.throwIfAborted()
          if (directory.project) {
            const count = (projectEntries.get(directory.project) ?? 0) + 1
            projectEntries.set(directory.project, count)
            if (count > 2000) {complete = false; skip('project_metadata_limit'); break}
          }
          if (++visited > 20000) {complete = false; break}
          const path = join(directory.path, entry.name)
          if (excluded.has(entry.name.toLowerCase()) || !policy.allows(path)) {skip('excluded'); continue}
          if (entry.isSymbolicLink()) {skip('symbolic_link'); continue}
          if (entry.isDirectory()) {
            if (directory.depth < 16) directories.push({path, depth: directory.depth + 1, project: directory.project})
            else {skip('depth_limit'); complete = false}
          } else if (entry.isFile()) {
            view.scanned++; seen.add(path)
            if (generatedFile(path)) {skip('generated_file'); continue}
            if (!supported.has(extname(path).toLowerCase())) {skip('unsupported_type'); continue}
            const stat = await lstat(path)
            if (!stat.isFile() || stat.isSymbolicLink()) {skip('changed_path'); complete = false; continue}
            files.push({path, size: stat.size, mtime: stat.mtimeMs, unit: directory.project ?? (directory.depth === 0 ? view.path : join(view.path, relative(view.path, directory.path).split(sep)[0]!))})
          }
        }
      }
      if (directories.length || visited >= 20000) {complete = false; skip('metadata_limit')}
      // Reconcile only after a complete metadata pass; unreadable/offline is never deletion.
      if (complete) for (const previous of [...record.files]) {
        if (seen.has(previous.path)) continue
        signal.throwIfAborted()
        await this.#removeFile(record, previous)
      }
      const known = new Map((await this.#options.knowledge.listSources()).map(item => [item.locator, item]))
      let bytes = 0
      const counts = new Map<string, number>()
      const selected = files.sort((a, b) => Number(overviewDocument(b.path)) - Number(overviewDocument(a.path)) || Number(representativeDocument(b.path)) - Number(representativeDocument(a.path)) || relative(a.unit, a.path).split(sep).length - relative(b.unit, b.path).split(sep).length || b.mtime - a.mtime || a.path.localeCompare(b.path)).filter(file => {
        const count = (counts.get(file.unit) ?? 0) + 1; counts.set(file.unit, count)
        // ponytail: Git overview reads eight documents; task-directed retrieval owns deeper investigation.
        if (projects.has(file.unit) && count > 8) {skip('project_budget'); return false}
        return true
      })
      const selectedPaths = new Set(selected.map(file => file.path))
      // Budgeting must not keep a changed, no-longer-selected version authoritative.
      for (const file of files) {
        const previous = record.files.find(old => old.path === file.path)
        if (previous && !selectedPaths.has(file.path) && (previous.mtime !== file.mtime || previous.size !== file.size)) {
          signal.throwIfAborted(); previous.valid = false; await this.#save(); await this.#removeFile(record, previous)
        }
      }
      for (const file of balanced(selected, view.path)) {
        signal.throwIfAborted()
        const previous = record.files.find(old => old.path === file.path)
        if (previous) previous.unit = file.unit
        if (previous?.valid && previous.mtime === file.mtime && previous.size === file.size && known.has(file.path) && (!representativeDocument(file.path) || previous.excerpt !== null)) {if(record.walk)record.walk.pending=record.walk.pending.filter(f=>f.path!==file.path);continue}
        if (previous?.valid) {
          previous.valid = false
          await this.#save()
        }
        if (previous) {
          // Retry propagation after interruption before accepting a replacement version.
          await this.#invalidateFile(previous)
          if (previous.owned) {await this.#options.knowledge.handle('knowledge.remove', {id: previous.id}); known.delete(file.path)}
        }
        if (file.size > 10 * 1024 * 1024 || file.size === 0) {skip('file_size');if(record.walk)record.walk.pending=record.walk.pending.filter(f=>f.path!==file.path);continue}
        if (view.read >= view.max_files || bytes + file.size > view.max_bytes) {skip('body_budget'); continue}
        if (record.files.length >= 20000 && !previous) {skip('index_limit'); continue}
        try {
          if (await realpath(file.path) !== file.path) {skip('changed_path'); continue}
          record.pending = {path: file.path, size: file.size, mtime: file.mtime, owned: previous?.owned ?? !known.has(file.path), previous_updated_at: known.get(file.path)?.updated_at ?? null}
          await this.#save()
          const result = await this.#options.knowledge.syncFile(file.path, view.path, signal, previous?.id,record.processing_consent)
          const indexed = (await this.#options.knowledge.listSources()).find(item => item.id === result.id)
          if (!indexed) throw new Error('ingest_failed')
          const tracked = {...file, id: result.id, fingerprint: indexed.fingerprint, owned: previous?.owned ?? !known.has(file.path), valid: true, excerpt: result.excerpt, observed: false, observation_ref: result.evidence_ids?.length ? `knowledge:${result.id}` : randomUUID(), ...(result.evidence_ids?.length ? {evidence_ids: result.evidence_ids} : {})}
          record.files = record.files.filter(old => old.path !== file.path); record.files.push(tracked); record.pending = null
          if(record.walk)record.walk.pending=record.walk.pending.filter(f=>f.path!==file.path)
          bytes += file.size; view.read++
          await this.#save()
        } catch (error) {
          await this.#recoverPending(record)
          signal.throwIfAborted()
          if(record.walk)record.walk.pending=record.walk.pending.filter(f=>f.path!==file.path)
          skip('read_failed')
          if (view.failures.length < 50) view.failures.push({path: relative(view.path, file.path), code: errorCode(error)})
          if (errorCode(error) === 'knowledge_busy') break
        }
      }
      signal.throwIfAborted()
      view.state = view.failures.length > 0 ? 'error' : 'connected'; view.last_sync = new Date().toISOString()
      // Scan statistics belong in source settings, not in the user's memory.
      if (record.observation) {await this.#options.onInvalidate?.(view.id); record.observation = ''; await this.#save()}
      await this.#options.onChange?.(beforeEvidence!==record.files.filter(file=>file.valid).map(refFor).sort().join())
      for (const file of balanced(record.files.filter(file => file.valid && !file.observed && representativeDocument(file.path) && (view.scope==='computer'||selectedPaths.has(file.path))), view.path).slice(0, 8)) {
        signal.throwIfAborted()
        if (file.observed || !file.excerpt || !this.#options.onObserve) continue
        if (!file.observation_ref) {file.observation_ref = randomUUID(); await this.#save()}
        const document = relative(view.path, file.path), project = dirname(document) === '.' ? basename(view.path) : dirname(document)
        const context = `文档 ${basename(view.path)}/${document}`.slice(0, 100) + '（资料摘录；作者与当前承诺未确认）：'
        await this.#options.onObserve({source_ref: {type: 'file', ref: file.observation_ref, observed_at: view.last_sync},
          ...(record.processing_consent?{processing_consent:record.processing_consent}:{}),content: context + file.excerpt.slice(0, 500 - context.length), topic: project.slice(0, 80), ...(file.evidence_ids ? {evidence_ids: file.evidence_ids} : {})})
        file.observed = true
        await this.#save()
      }
    } catch (error) {
      if (!signal.aborted) {view.state = 'error'; view.failures.push({path: '', code: errorCode(error)})}
    }
    view.indexed=record.files.filter(f=>f.valid).length
    if(record.walk){view.scan_pending=!!(record.walk.queue.length||record.walk.pending.length||record.files.some(f=>f.valid&&!f.observed&&f.excerpt&&representativeDocument(f.path)&&this.#options.onObserve));if(!view.scan_pending)record.walk=null}
    await this.#save()
    await this.#options.onChange?.(beforeEvidence !== record.files.filter(file => file.valid).map(refFor).sort().join() || beforeObservation !== record.observation)
  }
  async #recoverPending(record: SourceRecord): Promise<void> {
    const pending = record.pending
    if (!pending) return
    const indexed = (await this.#options.knowledge.listSources()).find(item => item.locator === pending.path)
    if (indexed && indexed.updated_at !== pending.previous_updated_at) {
      const previous = record.files.find(item => item.path === pending.path)
      if (previous && previous.fingerprint !== indexed.fingerprint) {
        await this.#invalidateFile(previous)
      }
      record.files = record.files.filter(item => item.path !== pending.path)
      record.files.push({path: pending.path, size: pending.size, mtime: pending.mtime, owned: pending.owned, id: indexed.id, fingerprint: indexed.fingerprint, valid: true, excerpt: null, observed: false, observation_ref: randomUUID()})
    }
    record.pending = null
    await this.#save()
  }
  async #invalidateFile(file: SourceRecord['files'][number]): Promise<void> {
    for (const ref of new Set([refFor(file), file.id, ...(file.observation_ref ? [file.observation_ref] : [])])) await this.#options.onInvalidate?.(ref)
  }
  async #removeFile(record: SourceRecord, file: SourceRecord['files'][number]): Promise<void> {
    await this.#invalidateFile(file)
    if (file.owned) await this.#options.knowledge.handle('knowledge.remove', {id: file.id})
    record.files = record.files.filter(item => item.id !== file.id)
    await this.#save()
  }
  async #delete(record: SourceRecord): Promise<void> {
    record.deleting = true; record.view.state = 'disconnected'; await this.#save()
    for (const file of [...record.files]) await this.#removeFile(record, file)
    await this.#options.onInvalidate?.(record.view.id)
    this.#records = this.#records.filter(item => item !== record)
    await this.#save(); await this.#options.onChange?.(false)
  }
  #save(): Promise<void> {
    const data = JSON.stringify({version: 1, sources: this.#records})
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) return Promise.reject(new Error('sources_state_too_large'))
    const write = this.#writes.then(async () => {
      const temporary = join(dirname(this.#path), `.sources-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, data, {mode: 0o600, flag: 'wx'})
        const file = await open(temporary, 'r+'); try {await file.sync()} finally {await file.close()}
        await rename(temporary, this.#path)
        if (process.platform !== 'win32') {const directory = await open(dirname(this.#path), 'r'); try {await directory.sync()} finally {await directory.close()}}
      }
      finally {await rm(temporary, {force: true})}
    })
    this.#writes = write.catch(() => undefined)
    return write
  }
}
function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child))
}
