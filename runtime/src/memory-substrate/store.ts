import {initializeRetrieval,memoryRetrieval} from './retrieval.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {canonicalJson} from '../text/canonical-json.js'
import {trustSchema} from '../core/events.js'
import type {GraphDatabase} from '../workspace-graph/store.js'
import {initializeSourceState,isCurrentEvidence,allowsProcessing,readProcessingGrant,sourceObjectFor,readConnection,sha256} from './source-state.js'
import {sourceOperation} from './source-operations.js'
import {SensitiveContentPolicy} from '../memory/sensitivity.js'

const id = z.string().min(1).max(512)
const date = z.iso.datetime({offset:true})
const object = z.record(z.string(), z.json())
export const EvidenceRecordSchema = z.object({
  id, source_id:id, source_kind:z.enum(['conversation','file','mail','calendar','im','task_result','user_correction']),
  consent:z.object({provider_fingerprint:id}).optional(),
  source_metadata:z.object({sender_id:id,account_id:id,provider:id.optional()}).optional(),
  locator:z.string().max(4096), cursor:z.string().max(4096).nullable().default(null),
  observed_at:date, recorded_at:date, raw_text:z.string().max(100_000).nullable(),
  extracted:object.default({}), hash:z.string().min(1).max(128),
  sensitivity:z.object({policy_version:z.string(),redactions:z.array(z.string())}).default({policy_version:'1',redactions:[]}),
  retention_until:date.nullable().default(null), trust:trustSchema,
}).strict()
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>
export const CandidateSchema = z.object({
  entry_id:id, expected_revision:z.number().int().nonnegative().optional(),
  kind:z.enum(['fact','preference','plan','concern','commitment','entity','topic','LogicalWorkspace','WorkspaceInstance','RelationCard']),
  origin:z.enum(['stated','inferred']), written_by:z.enum(['merge','user_correction']),
  evidence_refs:z.array(id).min(1).max(256), entity_refs:z.array(id).max(256).default([]),
  content:object, valid_until:date.nullable().default(null),
  op:z.enum(['add','update','tombstone']).optional(), recorded_at:date,
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'commitment' && value.op !== 'tombstone') {
    if ((typeof value.content.direction!=='string'||!['owed_by_me','owed_to_me'].includes(value.content.direction)) || (typeof value.content.status!=='string'||!['open','done','dropped'].includes(value.content.status)) || !(value.content.due === null || date.safeParse(value.content.due).success)) ctx.addIssue({code:'custom',message:'invalid commitment'})
  }
  if (value.written_by === 'user_correction' && value.origin !== 'stated') ctx.addIssue({code:'custom',message:'corrections must be stated'})
})
export type Candidate = z.infer<typeof CandidateSchema>
export const EntryRevisionSchema = z.object({
  entry_id:id,revision:z.number().int().positive(),supersedes:z.number().int().positive().nullable(),
  kind:z.string(),origin:z.enum(['stated','inferred']),written_by:z.enum(['merge','user_correction']),
  evidence_refs:z.array(id).min(1),entity_refs:z.array(id),content:object,valid_until:date.nullable(),
  op:z.enum(['add','update','tombstone']),recorded_at:date,
}).strict()
export type EntryRevision = z.infer<typeof EntryRevisionSchema>
export function contentHash(text:string):string {return createHash('sha256').update(text.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()).digest('hex')}

function normalized(value:unknown):unknown {
  if(typeof value==='string')return value.normalize('NFKC').trim().replace(/\s+/gu,' ')
  if(Array.isArray(value))return value.map(normalized)
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalized(item)]))
  return value
}

/** The sole revision decision; caller supplies persisted suppression and deletion state. */
export function merge(current:EntryRevision|null,candidate:Candidate,policy:{suppressed?:boolean;evidenceDeleted?:boolean}={}):EntryRevision|null {
  if (candidate.expected_revision !== undefined && candidate.expected_revision !== (current?.revision ?? 0)) throw new Error('STORE_STALE_REVISION')
  if (policy.suppressed && candidate.written_by !== 'user_correction') return null
  if (current?.origin==='stated' && candidate.origin==='inferred' && !policy.evidenceDeleted) return null
  if (current?.written_by === 'user_correction' && candidate.written_by !== 'user_correction' && !policy.evidenceDeleted) return null
  if (current?.op === 'tombstone' && candidate.op === 'tombstone') return null
  if (current && current.op !== 'tombstone' && candidate.op !== 'tombstone' && current.kind === candidate.kind && canonicalJson(normalized(current.content)) === canonicalJson(normalized(candidate.content)) && current.origin === candidate.origin && current.valid_until === candidate.valid_until && canonicalJson(current.evidence_refs) === canonicalJson(candidate.evidence_refs) && canonicalJson(current.entity_refs) === canonicalJson(candidate.entity_refs)) return null
  const fields={...candidate};delete fields.expected_revision
  return EntryRevisionSchema.parse({...fields,revision:(current?.revision??0)+1,supersedes:current?.revision??null,op:candidate.op === 'tombstone'?'tombstone':current?'update':'add'})
}

export function initializeMemory(database:GraphDatabase):void {
  initializeSourceState(database)
  initializeRetrieval(database)
  database.exec(`CREATE TABLE IF NOT EXISTS memory_evidence(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,hash TEXT NOT NULL,payload_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_evidence_source ON memory_evidence(source_id);
    CREATE TABLE IF NOT EXISTS memory_revisions(entry_id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(entry_id,revision));
    CREATE TABLE IF NOT EXISTS memory_suppressed(hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_deleted_sources(source_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_legacy_suppressed(scope TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(scope,hash));
    CREATE TABLE IF NOT EXISTS memory_extractions(evidence_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(evidence_id,attempt_id));`)
}
const scrubber = new SensitiveContentPolicy()
function scrub(value:unknown, redactions:string[],path='content'):unknown {
  if (typeof value === 'string') {const result=scrubber.scrub(path,value);if(result.kind==='clean')return value;redactions.push(path);return result.kind==='redacted'?result.value:null}
  if (Array.isArray(value))return value.map((item,index)=>scrub(item,redactions,`${path}.${index}`))
  if (value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item,redactions,`${path}.${key}`)]))
  return value
}
function rows(db:GraphDatabase,sql:string,...args:string[]):unknown[] {return db.prepare(sql).all(...args).map(row=>JSON.parse(String(row.payload_json)) as unknown)}
function current(db:GraphDatabase,entryId:string):EntryRevision|null {const row=db.prepare('SELECT payload_json FROM memory_revisions WHERE entry_id=? ORDER BY revision DESC LIMIT 1').get(entryId);return row?EntryRevisionSchema.parse(JSON.parse(String(row.payload_json))):null}
function all(db:GraphDatabase):EntryRevision[]{return rows(db,'SELECT r.payload_json FROM memory_revisions r JOIN (SELECT entry_id,MAX(revision) revision FROM memory_revisions GROUP BY entry_id) latest USING(entry_id,revision) ORDER BY r.entry_id').map(row=>EntryRevisionSchema.parse(row))}
function evidence(db:GraphDatabase,evidenceId:string):EvidenceRecord|null {const row=db.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get(evidenceId);return row?EvidenceRecordSchema.parse(JSON.parse(String(row.payload_json))):null}
export function effectiveEvidence(db:GraphDatabase,evidenceId:string,options:{purpose:'local'|'extraction'|'embedding';provider?:string}={purpose:'local'}):EvidenceRecord|null {
  const ref=evidence(db,evidenceId);if(!ref)return null
  if(!isCurrentEvidence(db,ref.id,ref.source_id))return null
  if(ref.retention_until!==null&&Date.parse(ref.retention_until)<=Date.now())return null
  if(options.purpose!=='local'&&(!options.provider||!allowsProcessing(db,ref.source_id,options.purpose,options.provider)))return null
  if(db.prepare('SELECT hash FROM memory_suppressed WHERE hash=?').get(ref.hash))return null
  if(ref.raw_text!==null&&db.prepare('SELECT hash FROM memory_legacy_suppressed WHERE hash=? AND substr(?,1,length(scope))=scope').get(createHash('sha256').update(ref.raw_text.normalize('NFKC').trim().toLowerCase()).digest('hex'),ref.source_id))return null
  return ref
}
export function processingStamp(db:GraphDatabase,ids:readonly string[],purpose:'extraction'|'embedding',provider:string):string|null{
  const records=ids.map(id=>effectiveEvidence(db,id,{purpose,provider}));if(!records.length||records.some(e=>e===null))return null
  return sha256(canonicalJson(records.map(e=>{const object=sourceObjectFor(db,e!.source_id);return {id:e!.id,grant:readProcessingGrant(db,e!.source_id),activation:object?.activation_revision??null,fence:object?readConnection(db,object.connection_id)?.fence:null}})))
}
export const retrievalEvidence=(db:GraphDatabase,id:string):EvidenceRecord|null=>effectiveEvidence(db,id)
function write(db:GraphDatabase,candidate:Candidate,deleted=false):EntryRevision|null {
  const previous=current(db,candidate.entry_id)
  if(candidate.expected_revision!==undefined&&candidate.expected_revision!==(previous?.revision??0))throw Error('STORE_STALE_REVISION')
  const refs=candidate.evidence_refs.map(ref=>evidence(db,ref))
  if(!deleted&&candidate.written_by!=='user_correction'&&refs.some(ref=>ref&&db.prepare('SELECT 1 FROM memory_suppressed WHERE hash=?').get(ref.hash)))return previous
  if(!deleted&&refs.some(ref=>ref!==null&&!retrievalEvidence(db,ref.id)))throw Error('STORE_NOT_FOUND')
  if (!deleted && (refs.every(ref=>ref===null)||refs.some((ref,index)=>ref===null&&!previous?.evidence_refs.includes(candidate.evidence_refs[index]!)))) throw new Error('STORE_NOT_FOUND')
  if (candidate.origin==='stated' && refs.every(ref=>ref?.trust!=='trusted_user')) throw new Error('STORE_INVALID_OPERATION')
  const redactions:string[]=[]
  candidate=CandidateSchema.parse({...candidate,content:scrub(candidate.content,redactions)})
  const next=merge(previous,candidate,{suppressed:refs.some(ref=>ref && (db.prepare('SELECT hash FROM memory_suppressed WHERE hash=?').get(ref.hash)!==undefined || (ref.raw_text!==null && db.prepare('SELECT hash FROM memory_legacy_suppressed WHERE hash=? AND substr(?,1,length(scope))=scope').get(createHash('sha256').update(ref.raw_text.normalize('NFKC').trim().toLowerCase()).digest('hex'),ref.source_id)!==undefined))),evidenceDeleted:deleted})
  if(next){
    db.prepare('INSERT INTO memory_revisions VALUES(?,?,?)').run(next.entry_id,next.revision,canonicalJson(next))
    db.prepare('DELETE FROM memory_vectors WHERE entry_id=?').run(next.entry_id)
    if(previous && candidate.written_by==='user_correction'){
      for(const ref of previous.evidence_refs){const old=evidence(db,ref);if(old)db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES(?)').run(old.hash)}
      db.exec("DELETE FROM memory_vectors WHERE entry_id IN (SELECT r.entry_id FROM memory_revisions r,json_each(r.payload_json,'$.evidence_refs') refs JOIN memory_evidence e ON e.id=refs.value JOIN memory_suppressed s ON s.hash=e.hash)")
    }
  }
  return next??current(db,candidate.entry_id)
}
export type MemoryOperation = 'append_evidence'|'merge'|'list'|'history'|'evidence'|'delete_source'|'expire'|'forget'|'record_extraction'|'migrate_legacy'|'pending_evidence'|'extraction_done'|'pending_vectors'|'write_vectors'|'search'|'retrieval_evidence'|'source_connection'|'source_apply_page'|'source_pending'|'source_revision'|'invalidate_evidence'|'source_grant'|'processing_evidence'|'extraction_ticket'|'commit_extraction'|'processing_stamp'|'source_events'
export function memoryOperation(db:GraphDatabase,operation:MemoryOperation,input:unknown,transaction=true):unknown {
  const value=z.record(z.string(),z.unknown()).parse(input)
  if(transaction)db.exec('BEGIN IMMEDIATE')
  try {
    let result:unknown=null
    switch(operation){
      case 'source_connection':case 'source_apply_page':case 'source_pending':case 'source_revision':case 'source_grant':case 'extraction_ticket':case 'commit_extraction':case 'source_events':result=sourceOperation(db,operation,input,(op,v)=>memoryOperation(db,op,v,false));break
      case 'processing_stamp':result=processingStamp(db,z.array(id).min(1).max(256).parse(value.ids),z.enum(['extraction','embedding']).parse(value.purpose),id.parse(value.provider));break
      case 'processing_evidence':result=effectiveEvidence(db,id.parse(value.id),{purpose:z.enum(['extraction','embedding']).parse(value.purpose),provider:id.parse(value.provider)});break
      case 'invalidate_evidence': {
        const ids=z.array(id).max(256).parse(value.ids)
        for(const entry of all(db))if(entry.op!=='tombstone'&&entry.origin==='inferred'&&entry.evidence_refs.some(ref=>ids.includes(ref))){
          const fields={...entry};Reflect.deleteProperty(fields,'revision');Reflect.deleteProperty(fields,'supersedes')
          write(db,CandidateSchema.parse({...fields,op:'tombstone',content:{reason:'evidence_superseded'},recorded_at:new Date().toISOString()}),true)
          for(const ref of entry.evidence_refs)if(retrievalEvidence(db,ref)){db.prepare('DELETE FROM memory_extractions WHERE evidence_id=?').run(ref);db.prepare("DELETE FROM source_extractions WHERE json_extract(payload_json,'$.ticket.evidence_id')=?").run(ref)}
        }
        break
      }
      case 'pending_vectors':case 'write_vectors':case 'search':result=memoryRetrieval(db,operation,input);break
      case 'append_evidence': {
        const parsed=EvidenceRecordSchema.parse(value)
        if(db.prepare('SELECT source_id FROM memory_deleted_sources WHERE source_id=?').get(parsed.source_id))throw new Error('STORE_INVALID_OPERATION')
        if (['file','mail','calendar','im'].includes(parsed.source_kind) && parsed.trust!=='untrusted_external')throw new Error('STORE_INVALID_OPERATION')
        const redactions=[...parsed.sensitivity.redactions]
        const safe=EvidenceRecordSchema.parse({...parsed,raw_text:scrub(parsed.raw_text,redactions,'raw_text'),locator:scrub(parsed.locator,redactions,'locator')??'[redacted]',extracted:scrub(parsed.extracted,redactions,'extracted'),sensitivity:{policy_version:'1',redactions},retention_until:parsed.retention_until??(parsed.source_kind==='im'?new Date(Date.parse(parsed.recorded_at)+30*86400000).toISOString():null)})
        const existing=evidence(db,safe.id)
        if(existing && (existing.hash!==safe.hash || existing.source_id!==safe.source_id || existing.locator!==safe.locator))throw new Error('STORE_IDEMPOTENCY_CONFLICT')
        if(!existing)db.prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)').run(safe.id,safe.source_id,safe.hash,canonicalJson(safe))
        result=existing??safe;break
      }
      case 'merge':result=write(db,CandidateSchema.parse(value));break
      case 'list': {
        const now=date.parse(value.now??new Date().toISOString());const includeHistory=z.boolean().parse(value.include_history??false)
        result=all(db).filter(entry=>includeHistory || (entry.op!=='tombstone' && (entry.valid_until===null || Date.parse(entry.valid_until)>Date.parse(now))));break
      }
      case 'history':result=rows(db,'SELECT payload_json FROM memory_revisions WHERE entry_id=? ORDER BY revision',id.parse(value.entry_id));break
      case 'evidence':result=evidence(db,id.parse(value.id));break
      case 'retrieval_evidence':result=retrievalEvidence(db,id.parse(value.id));break
      case 'extraction_done':result=db.prepare('SELECT 1 FROM memory_extractions WHERE evidence_id=? LIMIT 1').get(id.parse(value.id))!==undefined;break
      case 'pending_evidence': {
        const prefix=id.parse(value.source_prefix);const provider=value.provider===undefined?'':id.parse(value.provider);const limit=z.number().int().min(1).max(100).parse(value.limit??100)
        result=rows(db,`SELECT e.payload_json FROM memory_evidence e WHERE substr(e.source_id,1,length(?))=?
          AND json_extract(e.payload_json,'$.raw_text') IS NOT NULL AND json_extract(e.payload_json,'$.source_kind') <> 'user_correction'
          AND (json_extract(e.payload_json,'$.retention_until') IS NULL OR julianday(json_extract(e.payload_json,'$.retention_until'))>julianday('now'))
          AND (?='' OR EXISTS (SELECT 1 FROM source_grants g WHERE g.source_id=e.source_id AND json_extract(g.payload_json,'$.extraction_provider')=?))
          AND (?='' OR NOT EXISTS (SELECT 1 FROM source_objects o JOIN source_connections c ON c.id=o.connection_id JOIN source_grants g ON g.source_id=e.source_id WHERE json_extract(o.payload_json,'$.source_id')=e.source_id AND (json_extract(c.payload_json,'$.state')<>'connected' OR json_extract(c.payload_json,'$.fence.scope_revision')<>json_extract(g.payload_json,'$.scope_revision'))))
          AND NOT EXISTS (SELECT 1 FROM memory_suppressed s WHERE s.hash=e.hash)
          AND NOT EXISTS (SELECT 1 FROM memory_extractions x WHERE x.evidence_id=e.id)
          AND NOT EXISTS (SELECT 1 FROM source_objects o JOIN source_connections c ON c.id=o.connection_id WHERE json_extract(o.payload_json,'$.source_id')=e.source_id AND
            (o.generation<>json_extract(c.payload_json,'$.fence.generation') OR NOT EXISTS (SELECT 1 FROM json_each(o.payload_json,'$.current_evidence_ids') r WHERE r.value=e.id)))
          ORDER BY e.id LIMIT ?`,prefix,prefix,provider,provider,provider,String(limit)).map(row=>EvidenceRecordSchema.parse(row)).filter(row=>retrievalEvidence(db,row.id)!==null);break
      }
      case 'record_extraction': {
        const evidenceId=id.parse(value.evidence_id);if(!evidence(db,evidenceId))throw new Error('STORE_NOT_FOUND')
        const attempt=id.parse(value.attempt_id);const redactions:string[]=[];const payload=canonicalJson(scrub(object.parse(value.extracted),redactions))
        db.prepare('INSERT OR IGNORE INTO memory_extractions VALUES(?,?,?)').run(evidenceId,attempt,payload);break
      }
      case 'forget': {
        const entry=current(db,id.parse(value.entry_id));if(!entry)throw new Error('STORE_NOT_FOUND')
        const correction=CandidateSchema.parse(value.candidate)
        if(correction.entry_id!==entry.entry_id || correction.written_by!=='user_correction' || correction.op!=='tombstone')throw new Error('STORE_INVALID_OPERATION')
        result=write(db,correction)
        for(const ref of entry.evidence_refs){const source=evidence(db,ref);if(source)db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES(?)').run(source.hash)}
        break
      }
      case 'delete_source': {
        const source=id.parse(value.source_id);const affected=rows(db,'SELECT payload_json FROM memory_evidence WHERE source_id=?',source).map(row=>EvidenceRecordSchema.parse(row).id)
        for(const ref of affected){db.prepare('DELETE FROM memory_extractions WHERE evidence_id=?').run(ref);db.prepare("DELETE FROM source_extractions WHERE json_extract(payload_json,'$.ticket.evidence_id')=?").run(ref)}
        for(const entry of all(db))if(entry.evidence_refs.some(ref=>affected.includes(ref)))db.prepare('DELETE FROM memory_vectors WHERE entry_id=?').run(entry.entry_id)
        db.prepare('INSERT OR IGNORE INTO memory_deleted_sources VALUES(?)').run(source)
        db.prepare('DELETE FROM memory_evidence WHERE source_id=?').run(source)
        result=[]
        for(const entry of all(db)){if(entry.op!=='tombstone' && entry.evidence_refs.every(ref=>evidence(db,ref)===null)){
          const fields={...entry};Reflect.deleteProperty(fields,'revision');Reflect.deleteProperty(fields,'supersedes')
          const candidate=CandidateSchema.parse({...fields,op:'tombstone',origin:'inferred',written_by:'merge',content:{reason:'evidence_deleted'},recorded_at:new Date().toISOString()})
          ;(result as EntryRevision[]).push(write(db,candidate,true)!)
        }}break
      }
      case 'expire': {
        const now=Date.parse(date.parse(value.now??new Date().toISOString()));let count=0
        for(const raw of rows(db,'SELECT payload_json FROM memory_evidence')){const record=EvidenceRecordSchema.parse(raw);if(record.raw_text!==null && record.retention_until!==null && Date.parse(record.retention_until)<=now){db.prepare('UPDATE memory_evidence SET payload_json=? WHERE id=?').run(canonicalJson({...record,raw_text:null}),record.id);count++}}
        result=count;break
      }
      default:throw new Error('STORE_INVALID_OPERATION')
    }
    if(transaction)db.exec('COMMIT');return result
  }catch(error){if(transaction)db.exec('ROLLBACK');throw error}
}
