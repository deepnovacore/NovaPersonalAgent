import {homedir} from 'node:os'
import {watch, type FSWatcher} from 'node:fs'
import {processingGrantSchema,type ProcessingGrant} from '../memory-substrate/source-state.js'
import {interleave} from './sampling.js'
import {nextComputerRoot,rootActivity} from './source-priority.js'
import {scanDirectory} from './source-walk.js'
import type {ContextInput} from './context-candidates.js'
import {randomUUID} from 'node:crypto'
import {acquirePersonalLock} from './store.js'
import {lstat, opendir, open, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises'
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
  coverage:z.enum(['complete','partial']).optional(), health:z.enum(['healthy','degraded','error']).optional(),
  priority_dirs:z.array(pathSchema).max(16).default([]),
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
const walkFileSchema=z.object({path:pathSchema,size:z.number().nonnegative(),mtime:z.number(),unit:pathSchema,attempts:z.number().int().nonnegative().optional(),eligible_at:z.number().optional(),reason:z.enum(['body_budget','retry']).optional()}).strict()
const deferredFileSchema=walkFileSchema.extend({eligible_at:z.number().default(0),attempts:z.number().int().nonnegative().default(0),reason:z.enum(['body_budget','retry']).default('retry')}).strict()
const directoryLedgerSchema=z.object({path:pathSchema,unit:pathSchema.optional(),generation:z.number().int().nonnegative(),status:z.enum(['queued','done','partial']),identity:z.object({dev:z.string(),ino:z.string(),mtimeNs:z.string()}).strict().optional(),eligible_at:z.number().optional(),attempts:z.number().int().nonnegative().default(0)}).strict()
const walkSchema=z.object({queue:z.array(z.object({path:pathSchema,offset:z.number().int().nonnegative().optional(),unit:pathSchema.optional()}).strict()).max(20000),ledger:z.array(directoryLedgerSchema).max(20000).default([]),generation:z.number().int().nonnegative().default(1),turn:z.number().int().nonnegative().default(0),cursors:z.array(z.number().int().nonnegative()).length(3).default([0,0,0]),pending:z.array(walkFileSchema).max(200),deferred:z.array(deferredFileSchema).max(200).default([]),workspace_seeded:pathSchema.optional()}).strict()
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
function isAutoHiddenPath(root: string, path: string, selected: readonly string[] = []): boolean {
  const parts = relative(root, path).split(sep)
  if (parts.includes('.git')) return true
  const allowed=selected.filter(value=>within(value,path)).map(value=>relative(root,value).split(sep))
  return parts.some((part,index)=>part.startsWith('.')&&!allowed.some(prefix=>index<prefix.length&&prefix[index]===part))
}
function isComputerExcludedPath(view:SourceSnapshot,path:string):boolean{
  if(isAutoHiddenPath(view.path,path,view.priority_dirs))return true
  const excluded=new Set([...SOURCE_EXCLUDES,...COMPUTER_EXCLUDES,...view.excludes].map(part=>part.toLowerCase()))
  return relative(view.path,path).split(sep).some(part=>excluded.has(part.toLowerCase()))
}
function hiddenPrefixDepth(view:SourceSnapshot,path:string):number{
  if(view.scope==='directory')return basename(view.path).startsWith('.')?1:0
  const selected=view.priority_dirs.filter(dir=>within(dir,path)).sort((a,b)=>b.length-a.length)[0]
  return selected?relative(view.path,selected).split(sep).length:0
}
function computerUnit(root:string,path:string):string {
  const home=homedir()
  const base=within(home,path)&&within(root,home)?home:root
  if(dirname(path)===base)return base
  return join(base,relative(base,path).split(sep)[0]??'')
}
function settlePending(record:SourceRecord,path:string):void {
  if(record.walk){record.walk.pending=record.walk.pending.filter(item=>item.path!==path);record.walk.deferred=record.walk.deferred.filter(item=>item.path!==path)}
}
function deferPending(record:SourceRecord,file:{path:string;size:number;mtime:number;unit:string;attempts?:number},reason:'body_budget'|'retry',eligibleAt:number):void {
  if(!record.walk)return
  const previous=record.walk.deferred.find(item=>item.path===file.path)
  const attempts=Math.max(file.attempts??0,previous?.attempts??0)+(reason==='retry'?1:0)
  settlePending(record,file.path)
  if(record.walk.deferred.length<200)record.walk.deferred.push({...file,eligible_at:eligibleAt,attempts,reason})
  else record.walk.pending.push({...file,eligible_at:eligibleAt,attempts,reason})
}

export interface LocalDirectorySourceOptions {
  readonly computerRoot?: string
  /** Load persisted source context without recovery, scanning or polling (isolated acceptance copies). */
  readonly scanOnOpen?: boolean
  readonly priorityWorkspace?: () => Promise<string | null>
  /** Testable bound; production uses the scanner's hard default. */
  readonly directorySafetyCap?: number
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
  #workspacePath:string|null=null
  #activityCache=new Map<string,{value:Awaited<ReturnType<typeof rootActivity>>;checked:number}>()
  #watchers:FSWatcher[]=[]
  #dirtyHints=new Map<string,Set<string>>()
  #hintTimers=new Map<string,ReturnType<typeof setTimeout>>()

  constructor(options: LocalDirectorySourceOptions) {this.#options = options}
  async open(): Promise<void> {
    this.#path = preparePrivateDatabasePath(this.#options.path)
    this.#release = await acquirePersonalLock(this.#path)
    const info = await lstat(this.#path)
    if (info.size > 32 * 1024 * 1024) throw new Error('sources_state_too_large')
    const text = await readFile(this.#path, 'utf8')
    const raw:unknown=text.trim()?JSON.parse(text):{version:1,sources:[]}
    // Older scans could append a 51st terminal failure after the capped per-file list.
    if(raw&&typeof raw==='object'&&'sources' in raw&&Array.isArray(raw.sources))for(const item of raw.sources as unknown[]){
      if(!item||typeof item!=='object'||!('view' in item))continue
      const view=item.view
      if(view&&typeof view==='object'&&'failures' in view&&Array.isArray(view.failures)&&view.failures.length>50)view.failures=(view.failures as unknown[]).slice(-50)
    }
    this.#records = diskSchema.parse(raw).sources
    this.#closed = false
    if(this.#options.scanOnOpen===false)return
    for (const record of [...this.#records]) {
      await this.#recoverPending(record)
      if (record.deleting) await this.#delete(record)
      else if (record.view.state === 'connected' || record.view.state === 'error') {if(record.view.scope==='computer'){const timer=setTimeout(()=>{if(!this.#closed)void this.#sync(record).catch(()=>undefined)},0);timer.unref()}else await this.#sync(record)}
    }
    for(const record of this.#records)if(record.view.scope==='computer'&&record.view.state==='connected')this.#watchComputer(record)
    const pollMs = this.#options.pollMs ?? 300000
    if (pollMs > 0) {this.#timer = setInterval(() => {void this.#poll().catch(() => undefined)}, pollMs); this.#timer.unref()}
  }
  async close(): Promise<void> {
    this.#closed = true
    for(const watcher of this.#watchers)watcher.close()
    this.#watchers=[]
    for(const timer of this.#hintTimers.values())clearTimeout(timer)
    this.#hintTimers.clear()
    clearInterval(this.#timer)
    this.#active?.abort.abort()
    await this.#active?.done
    await this.#commands.catch(() => undefined)
    await this.#writes
    await this.#release?.(); this.#release = undefined
  }
  list(): SourceSnapshot[] {const expected=this.#options.processingGrant?.(true,1,0);return this.#records.map(record => ({...structuredClone(record.view), processing_consent_required:!record.processing_consent?.extraction_provider||record.processing_consent.extraction_provider!==expected?.extraction_provider||record.processing_consent.embedding_provider!==expected?.embedding_provider, excludes: [...new Set([...SOURCE_EXCLUDES, ...(record.view.scope==='computer'?COMPUTER_EXCLUDES:[]), ...record.view.excludes])]}))}
  #watchComputer(record:SourceRecord):void {
    const hint=(path:string)=>{
      if(!['connected','error'].includes(record.view.state))return
      const pending=this.#dirtyHints.get(record.view.id)??new Set<string>()
      if(pending.size>=64){pending.clear();pending.add(record.view.path)}else if(!pending.has(record.view.path))pending.add(path)
      this.#dirtyHints.set(record.view.id,pending)
      if(this.#hintTimers.has(record.view.id))return
      this.#activityCache.clear()
      const timer=setTimeout(()=>{
        this.#hintTimers.delete(record.view.id)
        if(this.#closed||!['connected','error'].includes(record.view.state))return
        const active=this.#active
        if(active)void active.done.catch(()=>undefined).then(()=>{if(!this.#closed&&['connected','error'].includes(record.view.state))void this.#sync(record).catch(()=>undefined)})
        else void this.#sync(record).catch(()=>undefined)
      },1000)
      timer.unref();this.#hintTimers.set(record.view.id,timer)
    }
    try{
      const watcher=watch(record.view.path,{recursive:true},(_event,filename)=>{
        const path=filename?join(record.view.path,String(filename)):record.view.path
        hint(within(record.view.path,path)?dirname(path):record.view.path)
      })
      watcher.on('error',()=>hint(record.view.path))
      this.#watchers.push(watcher)
    }catch{hint(record.view.path)}
  }
  evidence(ref: string) {
    for (const record of this.#records) {
      const file = record.files.find(file => refFor(file) === ref)
      if (file?.valid && !record.deleting && (record.view.scope !== 'computer' || !isComputerExcludedPath(record.view,file.path))) return {subject_key: `file:${file.id}`, source: {type: 'file' as const, ref}}
    }
    return null
  }
  contextEntries():ContextInput[]{
    const expected=this.#options.processingGrant?.(true,1,0)
    return this.#records.filter(r=>!r.deleting&&['connected','error'].includes(r.view.state)&&!!r.processing_consent?.extraction_provider&&r.processing_consent.extraction_provider===expected?.extraction_provider&&r.processing_consent.embedding_provider===expected?.embedding_provider).flatMap(record=>record.files.filter(f=>f.valid&&f.excerpt&&(record.view.scope!=='computer'||!isComputerExcludedPath(record.view,f.path))).map(file=>({kind:'file' as const,id:'source:'+file.id,version:file.fingerprint,content:file.excerpt!,source_id:record.view.id,file_id:file.id,root:file.unit??computerUnit(record.view.path,file.path),rel_path:record.view.scope==='computer'?relative(record.view.path,file.path):join(basename(record.view.path),relative(record.view.path,file.path)),role:/\.(?:md|markdown|txt|pdf|docx)$/iu.test(file.path)?'document' as const:/\.(?:json|yaml|yml|csv)$/iu.test(file.path)?'config' as const:'code' as const,mtime_ms:file.mtime,hidden_prefix_depth:hiddenPrefixDepth(record.view,file.path),priority:record.view.priority_dirs.some(dir=>within(dir,file.path))?3:record.view.scope==='directory'?2:this.#workspacePath&&within(this.#workspacePath,file.path)?1:0})))
  }
  evidenceSnapshot(): {ref: string; summary: string}[] {
    const fingerprints = new Set<string>()
    return interleave(this.#records.filter(record => !record.deleting).map(record =>
      balanced(record.files.filter(file => file.valid && (record.view.scope!=='computer'||!isComputerExcludedPath(record.view,file.path))), record.view.path).map(file => ({
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
    if(method==='sources.priority.add'||method==='sources.priority.remove'){
      const {path}=z.object({path:pathSchema}).strict().parse(params)
      const computer=this.#records.find(record=>record.view.scope==='computer'&&!record.deleting&&record.view.state!=='disconnected')
      if(!computer)throw Error('source_gone')
      if(method==='sources.priority.add'){
        const canonical=await realpath(path)
        const excluded=new Set([...SOURCE_EXCLUDES,...COMPUTER_EXCLUDES,...computer.view.excludes].map(part=>part.toLowerCase()))
        if(canonical!==path||!within(computer.view.path,path)||!policy.allows(path)||!((await lstat(path)).isDirectory())||relative(computer.view.path,path).split(sep).some(part=>excluded.has(part.toLowerCase())))throw Error('path_denied')
        if(this.#records.some(record=>record!==computer&&within(record.view.path,path)))throw Error('source_exists')
        if(!computer.view.priority_dirs.includes(path)){
          if(computer.view.priority_dirs.length>=16)throw Error('source_limit')
          computer.view.priority_dirs.push(path);await this.#save()
        }
        if(computer.walk){computer.walk.queue=computer.walk.queue.filter(entry=>entry.path!==path);computer.walk.queue.unshift({path});computer.walk.ledger=computer.walk.ledger.filter(entry=>entry.path!==path);await this.#save()}
        if(computer.view.state==='connected'||computer.view.state==='error')void this.#sync(computer).catch(()=>undefined)
      }else{
        computer.view.priority_dirs=computer.view.priority_dirs.filter(value=>value!==path)
        await this.#save()
      }
      await this.#options.onChange?.(false)
      return {ok:true}
    }
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
        priority_dirs:[],max_files: parsed.data.max_files ?? 200, max_bytes: parsed.data.max_bytes ?? 20 * 1024 * 1024}, files: [], deleting: false, observation: '', pending: null}
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
      if (record.view.state === 'connected' || record.view.state === 'error') await this.#sync(record,true)
    } else throw new Error('invalid_request')
    await this.#options.onChange?.(false)
    return {ok: true}
  }
  async #addComputer():Promise<{id:string}>{
    if(this.#records.length>=8)throw Error('source_limit')
    const path=await realpath(this.#options.computerRoot??parse(homedir()).root)
    const record:SourceRecord={walk:null,view:{scope:'computer',scan_pending:true,indexed:0,priority_dirs:[],id:randomUUID(),path,state:'connected',scanned:0,read:0,skipped:0,reasons:{},failures:[],last_sync:null,excludes:[],max_files:200,max_bytes:20*1024*1024},files:[],deleting:false,observation:'',pending:null}
    const grant=this.#options.processingGrant?.(true,1,0);if(grant)record.processing_consent=grant
    this.#records.push(record);try{await this.#save()}catch(error){this.#records.pop();throw error}
    // The grant returns immediately; indexing cannot block the settings window.
    void this.#sync(record).catch(()=>undefined)
    this.#watchComputer(record)
    return {id:record.view.id}
  }
  async #computerBatch(record:SourceRecord,signal:AbortSignal,force=false):Promise<{path:string;size:number;mtime:number;unit:string}[]>{
    const walk:z.infer<typeof walkSchema>=record.walk??(record.walk={queue:[...record.view.priority_dirs.map(path=>({path})),{path:record.view.path}],ledger:[],generation:1,turn:0,cursors:[0,0,0],pending:[],deferred:[]})
    // v1 offsets are deliberately ignored: reopening a changed directory starts a new pass.
    const ledger=new Map(walk.ledger.map(item=>[item.path,item]))
    for(const item of walk.queue)if(!ledger.has(item.path)){
      if(ledger.size>=20000){record.view.reasons.directory_capacity=(record.view.reasons.directory_capacity??0)+1;continue}
      ledger.set(item.path,{path:item.path,unit:item.unit,generation:walk.generation,status:'queued',attempts:0})
    }
    walk.queue=walk.queue.filter(item=>ledger.has(item.path))
    const resumePaths=new Set(walk.queue.map(item=>item.path))
    for(const item of ledger.values())if(item.status==='queued'&&!resumePaths.has(item.path)&&walk.queue.length<20000){walk.queue.push({path:item.path,...(item.unit?{unit:item.unit}:{})});resumePaths.add(item.path)}
    if(force&&walk.queue.length===0&&walk.pending.length===0&&walk.deferred.length===0&&ledger.size>0){walk.generation++;for(const entry of ledger.values())entry.status='queued';walk.queue=[...record.view.priority_dirs.map(path=>({path})),{path:record.view.path}]}
    else if(walk.queue.length===0&&walk.pending.length===0&&walk.deferred.length===0){
      const due=[...ledger.values()].filter(item=>(item.eligible_at??Infinity)<=Date.now()).slice(0,64)
      if(due.length){walk.generation++;for(const item of due){item.generation=walk.generation;item.status='queued';walk.queue.push({path:item.path,...(item.unit?{unit:item.unit}:{})})}}
    }
    const hints=this.#dirtyHints.get(record.view.id)
    if(hints?.size){walk.generation++;const existing=new Set(walk.queue.map(item=>item.path));for(const path of [...hints].slice(0,64)){const old=ledger.get(path);if(!old&&ledger.size>=20000||!existing.has(path)&&walk.queue.length>=20000){record.view.reasons.directory_capacity=(record.view.reasons.directory_capacity??0)+1;hints.delete(path);continue}ledger.set(path,{...old,path,generation:walk.generation,status:'queued',attempts:old?.attempts??0});if(!existing.has(path)){walk.queue.push({path,...(old?.unit?{unit:old.unit}:{})});existing.add(path)}hints.delete(path)}}
    const now=Date.now()
    const eligible=walk.deferred.filter(item=>item.eligible_at<=now).slice(0,Math.max(0,200-walk.pending.length))
    const eligiblePaths=new Set(eligible.map(item=>item.path))
    walk.deferred=walk.deferred.filter(item=>!eligiblePaths.has(item.path))
    const pendingPaths=new Set(walk.pending.map(item=>item.path))
    const queuedPaths=new Set(walk.queue.map(item=>item.path))
    for(const item of eligible)if(!pendingPaths.has(item.path)){walk.pending.push({...item});pendingPaths.add(item.path)}
    const excluded=new Set([...SOURCE_EXCLUDES,...COMPUTER_EXCLUDES,...record.view.excludes].map(s=>s.toLowerCase()))
    const workspace=await this.#options.priorityWorkspace?.().then(path=>path&&within(record.view.path,path)?path:null).catch(()=>null)??null
    this.#workspacePath=workspace
    const enqueue=(path:string,unit?:string)=>{
      const prior=ledger.get(path)
      if(prior?.generation===walk.generation&&(prior.status==='done'||prior.status==='partial'||queuedPaths.has(path)))return
      if(walk.queue.length>=20000||ledger.size>=20000){record.view.reasons.directory_capacity=(record.view.reasons.directory_capacity??0)+1;return}
      ledger.set(path,{...prior,path,unit,generation:walk.generation,status:'queued',attempts:prior?.attempts??0})
      walk.queue.push({path,...(unit?{unit}:{})});queuedPaths.add(path)
    }
    if(workspace&&walk.workspace_seeded!==workspace){
      walk.workspace_seeded=workspace
      if(workspace!==record.view.path&&!isComputerExcludedPath(record.view,workspace)&&policy.allows(workspace)&&await realpath(workspace).catch(()=>null)===workspace&&await lstat(workspace).then(stat=>stat.isDirectory()).catch(()=>false)){enqueue(workspace);const index=walk.queue.findIndex(item=>item.path===workspace);if(index>0)walk.queue.unshift(walk.queue.splice(index,1)[0]!)}
    }
    const knownFiles=new Map(record.files.filter(file=>file.valid).map(file=>[file.path,file]))
    const signalFor=async(path:string)=>{
      let cached=this.#activityCache.get(path)
      if(!cached||Date.now()-cached.checked>300_000){cached={value:await rootActivity(path),checked:Date.now()};this.#activityCache.set(path,cached)}
      const recent=cached.value
      return {path,selected:record.view.priority_dirs.some(value=>within(value,path)),currentWorkspace:!!workspace&&within(workspace,path),...recent}
    }
    let turns=0
    let metadataSeen=0
    let statCalls=0
    const yielded=new Set<string>()
    const cursors=walk.cursors
    try{
    while(walk.queue.length&&walk.pending.length<16&&metadataSeen<20_000&&statCalls<20_000&&turns++<64){
      signal.throwIfAborted()
      // Rotate roots; ranking is a tier hint, not a permanent sort of every turn.
      const front=walk.queue.slice(0,Math.min(32,walk.queue.length))
      const signals=await Promise.all(front.map(item=>signalFor(item.path)))
      const turn=walk.turn++
      const candidate=nextComputerRoot(signals,turn,cursors,yielded)??nextComputerRoot(signals,turn,cursors)!
      const selected=front.find(item=>item.path===candidate.path)!
      const index=walk.queue.indexOf(selected),directory=walk.queue.splice(index,1)[0]!
      queuedPaths.delete(directory.path)
      const item=ledger.get(directory.path)??{path:directory.path,generation:walk.generation,status:'queued' as const,attempts:0}
      item.generation=walk.generation
      ledger.set(directory.path,item)
      if(directory.path!==record.view.path&&(isAutoHiddenPath(record.view.path,directory.path,record.view.priority_dirs)||relative(record.view.path,directory.path).split(sep).some(part=>excluded.has(part.toLowerCase())))){ledger.delete(directory.path);continue}
      const seen=new Set<string>()
      let admitted=0
      try{
        if(await realpath(directory.path)!==directory.path)throw Error('changed_path')
        const marker=await lstat(join(directory.path,'.git')).catch(()=>null)
        if(marker&&(marker.isDirectory()||marker.isFile())&&!marker.isSymbolicLink())directory.unit=directory.path
        const safetyCap=this.#options.directorySafetyCap??20_000
        const passCap=Math.min(safetyCap,20_000-metadataSeen)
        const result=await scanDirectory(directory.path,signal,async entry=>{
          const path=join(directory.path,entry.name)
          seen.add(entry.name)
          if(isAutoHiddenPath(record.view.path,path,record.view.priority_dirs)||excluded.has(entry.name.toLowerCase())||!policy.allows(path)||entry.isSymbolicLink()){record.view.skipped++;return}
          if(entry.isDirectory()){
            if(this.#records.some(r=>r!==record&&within(r.view.path,path))||record.view.priority_dirs.includes(path))return
            enqueue(path,directory.unit)
          }else if(entry.isFile()){
            record.view.scanned++
            if(!supported.has(extname(path).toLowerCase())||generatedFile(path)){record.view.skipped++;return}
            if(pendingPaths.has(path))return
            if(walk.pending.length>=16||admitted>=4&&walk.queue.length)throw Error('directory_yield')
            const stat=await lstat(path)
            statCalls++
            if(!stat.isFile()||stat.isSymbolicLink())return
            const prior=knownFiles.get(path)
            if(prior?.size===stat.size&&prior.mtime===stat.mtimeMs)return
            walk.pending.push({path,size:stat.size,mtime:stat.mtimeMs,unit:directory.unit??computerUnit(record.view.path,path)})
            pendingPaths.add(path);admitted++
          }
        },{hardSafetyCap:passCap})
        metadataSeen+=result.seen
        if(result.complete&&(!item.identity||item.identity.dev===result.identity.dev&&item.identity.ino===result.identity.ino)){
          // A complete, same-filesystem parent pass is the sole deletion authority.
          if(item.identity){
            for(const file of [...record.files])if(within(directory.path,file.path)&&file.path!==directory.path&&!seen.has(relative(directory.path,file.path).split(sep)[0]!))await this.#removeFile(record,file)
            const removed=new Set<string>()
            for(const path of ledger.keys())if(path!==directory.path&&within(directory.path,path)&&!seen.has(relative(directory.path,path).split(sep)[0]!)){ledger.delete(path);queuedPaths.delete(path);removed.add(path)}
            if(removed.size)walk.queue=walk.queue.filter(entry=>!removed.has(entry.path))
          }
          item.status='done';item.identity=result.identity;item.attempts=0;item.eligible_at=Date.now()+(record.view.priority_dirs.some(path=>within(path,directory.path))||!!workspace&&within(workspace,directory.path)?300_000:86_400_000)
        }else if(result.capped&&passCap<safetyCap){
          walk.queue.push(directory);queuedPaths.add(directory.path)
        }else{
          const changedFilesystem=!!item.identity&&(item.identity.dev!==result.identity.dev||item.identity.ino!==result.identity.ino)
          item.status='partial';item.eligible_at=Date.now()+(result.capped||changedFilesystem?86_400_000:60_000)
          record.view.reasons.directory_partial=(record.view.reasons.directory_partial??0)+1
        }
      }catch(error){
        if(signal.aborted){walk.queue.push(directory);queuedPaths.add(directory.path);signal.throwIfAborted()}
        if(error instanceof Error&&error.message==='directory_yield'){walk.queue.push(directory);queuedPaths.add(directory.path);yielded.add(directory.path);continue}
        item.status='partial';item.attempts++;item.eligible_at=Date.now()+Math.min(6*60*60_000,60_000*2**Math.min(item.attempts-1,8))
        record.view.reasons.directory_unavailable=(record.view.reasons.directory_unavailable??0)+1
        if(record.view.failures.length<50)record.view.failures.push({path:directory.path,code:error instanceof Error&&'code' in error?String(error.code):'directory_unavailable'})
      }
    }
    }finally{
    walk.ledger=[...ledger.values()]
    record.view.scan_pending=walk.queue.length>0||walk.pending.length>0||walk.deferred.length>0||walk.ledger.some(item=>item.status==='partial')
    await this.#save()
    }
    return walk.pending.filter(item=>(item.eligible_at??0)<=Date.now())
  }
  async #poll(): Promise<void> {
    if (this.#closed || this.#active) return
    for (const record of this.#records) {
      if (this.#closed) return
      if (record.view.state === 'connected' || record.view.state === 'error') await this.#sync(record)
    }
  }
  async #sync(record: SourceRecord,force=false): Promise<void> {
    if (this.#closed || this.#active) return
    const abort = new AbortController()
    const done=this.#scan(record,abort.signal,force).finally(()=>{this.#active=undefined;if(record.view.scope==='computer'&&record.view.scan_pending&&!this.#closed&&['connected','error'].includes(record.view.state)){const walk=record.walk;const now=Date.now();const duePending=!!walk?.pending.some(item=>(item.eligible_at??0)<=now);const canDiscover=!!walk?.queue.length&&walk.pending.length<16;const immediate=duePending||canDiscover;const pendingDue=walk?.pending.filter(item=>(item.eligible_at??0)>now).map(item=>item.eligible_at!)??[];const deferredDue=walk&&walk.pending.length<200?walk.deferred.map(item=>item.eligible_at):[];const directoryDue=walk&&!walk.queue.length&&!walk.pending.length&&!walk.deferred.length?walk.ledger.filter(item=>item.status==='partial'&&item.eligible_at!==undefined).map(item=>item.eligible_at!):[];const due=Math.min(...pendingDue,...deferredDue,...directoryDue,Infinity);const delay=immediate?(record.view.state==='error'?30000:1000):Number.isFinite(due)?Math.min(Math.max(1,due-now),6*60*60_000):30000;const timer=setTimeout(()=>{if(!this.#closed&&!this.#active&&['connected','error'].includes(record.view.state))void this.#sync(record).catch(()=>undefined)},delay);timer.unref()}})
    this.#active = {id: record.view.id, abort, done}
    await done
  }
  async #scan(record: SourceRecord, signal: AbortSignal, force=false): Promise<void> {
    const view = record.view
    const beforeEvidence = record.files.filter(file => file.valid).map(refFor).sort().join()
    const beforeObservation = record.observation
    view.read=0; if(view.scope!=='computer'||record.walk===null){view.scanned=0;view.skipped=0;view.reasons={};view.failures=[]}
    const skip = (reason: string) => {view.skipped++; view.reasons[reason] = (view.reasons[reason] ?? 0) + 1}
    const files: {path: string; size: number; mtime: number; unit: string; attempts?:number}[] = []
    const seen = new Set<string>(), excluded = new Set([...SOURCE_EXCLUDES, ...view.excludes].map(name => name.toLowerCase()))
    const directories = [{path: view.path, depth: 0, project: null as string | null}]
    const projectEntries = new Map<string, number>()
    const projects = new Set<string>()
    let complete = true, visited = 0
    let currentReadFailure=false
    try {
      if (view.scope!=='computer'&&await realpath(view.path) !== view.path) throw new Error('path_denied')
      if(view.scope==='computer'){
        for(const previous of [...record.files].filter(file=>isComputerExcludedPath(view,file.path))){
          signal.throwIfAborted()
          if(previous.valid){previous.valid=false;await this.#save()}
          await this.#removeFile(record,previous)
        }
        if(record.walk){record.walk.pending=record.walk.pending.filter(file=>!isComputerExcludedPath(view,file.path));record.walk.deferred=record.walk.deferred.filter(file=>!isComputerExcludedPath(view,file.path))}
      }
      if(view.scope==='computer'){files.push(...await this.#computerBatch(record,signal,force));directories.length=0;complete=false}
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
        if (previous?.valid && previous.mtime === file.mtime && previous.size === file.size && known.has(file.path) && (!representativeDocument(file.path) || previous.excerpt !== null)) {settlePending(record,file.path);continue}
        if (previous?.valid) {
          previous.valid = false
          await this.#save()
        }
        if (previous) {
          // Retry propagation after interruption before accepting a replacement version.
          await this.#invalidateFile(previous)
          if (previous.owned) {await this.#options.knowledge.handle('knowledge.remove', {id: previous.id}); known.delete(file.path)}
        }
        if (file.size > 10 * 1024 * 1024 || file.size === 0) {skip('file_size');settlePending(record,file.path);continue}
        if(file.size>view.max_bytes){skip('body_budget');settlePending(record,file.path);continue}
        if (view.read >= view.max_files || bytes + file.size > view.max_bytes) {skip('body_budget');deferPending(record,file,'body_budget',Date.now()+60_000);continue}
        if (record.files.length >= 20000 && !previous) {skip('index_limit');settlePending(record,file.path);continue}
        try {
          if (await realpath(file.path) !== file.path) {skip('changed_path');settlePending(record,file.path);continue}
          record.pending = {path: file.path, size: file.size, mtime: file.mtime, owned: previous?.owned ?? !known.has(file.path), previous_updated_at: known.get(file.path)?.updated_at ?? null}
          await this.#save()
          const result = await this.#options.knowledge.syncFile(file.path, view.path, signal, previous?.id,record.processing_consent)
          const indexed = (await this.#options.knowledge.listSources()).find(item => item.id === result.id)
          if (!indexed) throw new Error('ingest_failed')
          const tracked = {...file, id: result.id, fingerprint: indexed.fingerprint, owned: previous?.owned ?? !known.has(file.path), valid: true, excerpt: result.excerpt, observed: false, observation_ref: result.evidence_ids?.length ? `knowledge:${result.id}` : randomUUID(), ...(result.evidence_ids?.length ? {evidence_ids: result.evidence_ids} : {})}
          record.files = record.files.filter(old => old.path !== file.path); record.files.push(tracked); record.pending = null
          settlePending(record,file.path)
          bytes += file.size; view.read++
          await this.#save()
        } catch (error) {
          await this.#recoverPending(record)
          signal.throwIfAborted()
          settlePending(record,file.path)
          skip('read_failed')
          const code=errorCode(error)
          currentReadFailure=true
          if (view.failures.length < 50) view.failures.push({path: relative(view.path, file.path), code})
          if(record.walk&&['knowledge_busy','source_busy','ingest_failed','source_unavailable'].includes(code)&&(file.attempts??0)<5){const attempts=(file.attempts??0)+1;deferPending(record,file,'retry',Date.now()+Math.min(6*60*60_000,30_000*2**attempts))}
          if (code === 'knowledge_busy') break
        }
      }
      signal.throwIfAborted()
      if(view.state!=='paused'&&view.state!=='disconnected')view.state='connected'
      const partial=[record.walk?.queue.length,record.walk?.pending.length,record.walk?.deferred.length].some(count=>!!count)||!!record.walk?.ledger.some(item=>item.status==='partial')||Object.entries(view.reasons).some(([reason,count])=>count>0&&['body_budget','index_limit','metadata_limit','project_metadata_limit','depth_limit','directory_capacity'].includes(reason))
      view.health=partial||currentReadFailure?'degraded':'healthy'
      view.coverage=partial||currentReadFailure?'partial':'complete'
      view.last_sync = new Date().toISOString()
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
      if (!signal.aborted) {view.state = 'error';view.health='error';view.coverage='partial';view.failures.splice(0,Math.max(0,view.failures.length-49));view.failures.push({path: '', code: errorCode(error)})}
    }
    view.indexed=record.files.filter(f=>f.valid).length
    if(record.walk){view.scan_pending=!!(record.walk.queue.length||record.walk.pending.length||record.walk.deferred.length||record.walk.ledger.some(item=>item.status==='partial')||record.files.some(f=>f.valid&&!f.observed&&f.excerpt&&representativeDocument(f.path)&&this.#options.onObserve));if(!view.scan_pending&&view.scope!=='computer')record.walk=null}
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
    for(const record of this.#records)record.view.failures=record.view.failures.slice(-50)
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
