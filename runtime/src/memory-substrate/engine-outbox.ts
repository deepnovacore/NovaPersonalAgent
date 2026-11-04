import {ledgerMemoryScope} from '../memory/entry.js'
import {createHash, randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {EntryRevisionSchema, EvidenceRecordSchema, effectiveEvidence, processingStamp, fileDerivedInference} from './store.js'

export const engineSnapshotSchema = z.object({entries: z.array(z.object({entry: z.lazy(()=>EntryRevisionSchema), stamp: z.string()})), sources: z.array(z.object({evidence: z.lazy(()=>EvidenceRecordSchema), stamp: z.string()}))})
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>

/** Content-free transactional outbox. Triggers also cover purge, hand edits and consent changes. */
export function initializeEngineOutbox(db: LedgerDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_engine_outbox(scope TEXT NOT NULL, engine TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, completed INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, descriptor TEXT, retired INTEGER NOT NULL DEFAULT 0, next_expiry INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,engine))`)
  const columns=db.prepare('PRAGMA table_info(memory_engine_outbox)').all().map(row=>row.name)
  if(!columns.includes('descriptor'))db.exec('ALTER TABLE memory_engine_outbox ADD COLUMN descriptor TEXT')
  if(!columns.includes('retired'))db.exec('ALTER TABLE memory_engine_outbox ADD COLUMN retired INTEGER NOT NULL DEFAULT 0')
  if(!columns.includes('next_expiry'))db.exec('ALTER TABLE memory_engine_outbox ADD COLUMN next_expiry INTEGER NOT NULL DEFAULT 0')
  for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS engine_dirty_session_${action} AFTER ${action} ON temp.source_session_consents BEGIN UPDATE memory_engine_outbox SET generation=generation+1; END`)
  for (const table of ['memory_revisions','memory_evidence','memory_suppressed','memory_deleted_sources','memory_legacy_suppressed','source_grants','source_connections','source_objects','memory_message_heads','memory_purged_ids']) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
    for (const action of ['INSERT','UPDATE','DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS engine_dirty_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE memory_engine_outbox SET generation=generation+1; END`)
  }
}

export function engineOutboxOperation(db: LedgerDatabase, input: unknown): unknown {
  const q = z.object({action: z.enum(['register','status','list','retire','claim','ack','release','check']), scope: z.string().startsWith('personal:').endsWith(':'), engine: z.string().min(1).max(256), owner: z.string().optional(), generation: z.number().int().optional(), embedding: z.string().optional(), extraction: z.string().optional(), styles: z.boolean().optional(), cleanup:z.boolean().optional(), descriptor:z.object({engine:z.enum(['mem0','voicemem']),path:z.string().min(1),userId:z.string().min(1),dimensions:z.number().int().positive().optional()}).optional()}).strict().parse(input)
  if (q.action === 'register') {
    db.prepare('INSERT OR IGNORE INTO memory_engine_outbox(scope,engine) VALUES(?,?)').run(q.scope,q.engine)
    db.prepare('UPDATE memory_engine_outbox SET descriptor=?, generation=generation+1, retired=0 WHERE scope=? AND engine=?').run(JSON.stringify(q.descriptor??null),q.scope,q.engine)
    return null
  }
  if(q.action==='list')return db.prepare('SELECT engine,descriptor FROM memory_engine_outbox WHERE scope=? AND descriptor IS NOT NULL').all(q.scope).map(row=>({key:row.engine,descriptor:JSON.parse(String(row.descriptor)) as unknown}))
  if(q.action==='retire'){db.prepare('UPDATE memory_engine_outbox SET retired=1,generation=generation+1 WHERE scope=? AND engine=? AND retired=0').run(q.scope,q.engine);return null}
  if(q.action==='claim')db.prepare('UPDATE memory_engine_outbox SET generation=generation+1,next_expiry=0 WHERE scope=? AND engine=? AND next_expiry>0 AND next_expiry<=?').run(q.scope,q.engine,Date.now())
  const row = db.prepare('SELECT * FROM memory_engine_outbox WHERE scope=? AND engine=?').get(q.scope,q.engine)
  if (!row) throw Error('STORE_INVALID_OPERATION')
  if (q.action === 'status')return row.completed===row.generation&&(!Number(row.next_expiry)||Number(row.next_expiry)>Date.now())
  const authorized=Boolean(row.retired)===Boolean(q.cleanup)&&row.owner===q.owner&&Number(row.lease_until)>Date.now()&&row.generation===q.generation&&(!Number(row.next_expiry)||Number(row.next_expiry)>Date.now())
  if (q.action === 'check') return authorized
  if (q.action === 'ack' || q.action === 'release') {
    if (q.action === 'ack'&&authorized) db.prepare('UPDATE memory_engine_outbox SET completed=? WHERE scope=? AND engine=? AND owner=? AND generation=?').run(q.generation!,q.scope,q.engine,q.owner!,q.generation!)
    db.prepare('UPDATE memory_engine_outbox SET owner=NULL,lease_until=0 WHERE scope=? AND engine=? AND owner=?').run(q.scope,q.engine,q.owner!)
    return null
  }
  if(Boolean(row.retired)!==Boolean(q.cleanup))return null
  if (Number(row.lease_until) > Date.now() || row.completed === row.generation) return null
  if (!q.embedding || !q.extraction) throw Error('STORE_INVALID_OPERATION')
  const owner = randomUUID(), generation = Number(row.generation)
  db.prepare('UPDATE memory_engine_outbox SET owner=?,lease_until=? WHERE scope=? AND engine=?').run(owner,Date.now()+120_000,q.scope,q.engine)
  if(q.cleanup)return {owner,generation,snapshot:{entries:[],sources:[]}}
  const entries: EngineSnapshot['entries'] = [], sources: EngineSnapshot['sources'] = [], expiries:number[]=[]
  const rows = db.prepare(`SELECT r.payload_json FROM memory_revisions r JOIN (SELECT entry_id,MAX(revision) revision FROM memory_revisions WHERE entry_id>=? AND entry_id<? GROUP BY entry_id) latest USING(entry_id,revision)`).all(q.scope,q.scope+'\u{10ffff}')
  const generalEvidence=new Set<string>()
  for(const raw of rows){const entry=EntryRevisionSchema.parse(JSON.parse(String(raw.payload_json)));if(entry.content.memory_scope==='general')for(const id of entry.evidence_refs)generalEvidence.add(id)}
  for (const raw of rows) {
    const entry = EntryRevisionSchema.parse(JSON.parse(String(raw.payload_json)))
    if (typeof entry.content.text!=='string'||!entry.content.text.trim()||entry.op === 'tombstone' || ledgerMemoryScope(entry.content.memory_scope) !== 'user' || ['soul','diary','memory_summary','profile'].includes(entry.kind) || fileDerivedInference(db,entry) || (entry.valid_until !== null && Date.parse(entry.valid_until) <= Date.now())) continue
    const stamp = processingStamp(db,entry.evidence_refs,'embedding',q.embedding)
    if (stamp) {
      const evidence=entry.evidence_refs.map(ref=>effectiveEvidence(db,ref,{purpose:'embedding',provider:q.embedding!}))
      if(evidence.some(row=>row===null))continue
      entries.push({entry,stamp})
      if(entry.valid_until!==null)expiries.push(Date.parse(entry.valid_until))
      for(const row of evidence)if(row!.retention_until!==null)expiries.push(Date.parse(row!.retention_until))
    }
  }
  if (q.styles) for (const raw of db.prepare('SELECT payload_json FROM memory_evidence WHERE source_id>=? AND source_id<?').all(q.scope,q.scope+'\u{10ffff}')) {
    const evidence = EvidenceRecordSchema.parse(JSON.parse(String(raw.payload_json)))
    // Only the user's recent conversation, never project/files/assistant content, feeds style extraction.
    if (generalEvidence.has(evidence.id) || evidence.source_kind !== 'conversation' || !evidence.raw_text || Date.parse(evidence.observed_at) < Date.now()-600_000 || Date.parse(evidence.observed_at) > Date.now()) continue
    if (!effectiveEvidence(db,evidence.id,{purpose:'extraction',provider:q.extraction})) continue
    const embedding = processingStamp(db,[evidence.id],'embedding',q.embedding), extraction = processingStamp(db,[evidence.id],'extraction',q.extraction)
    if (embedding && extraction) sources.push({evidence,stamp:createHash('sha256').update(canonicalJson([embedding,extraction])).digest('hex')})
  }
  expiries.push(...sources.map(item=>Math.min(Date.parse(item.evidence.observed_at)+600_000,item.evidence.retention_until?Date.parse(item.evidence.retention_until):Infinity)))
  db.prepare('UPDATE memory_engine_outbox SET next_expiry=? WHERE scope=? AND engine=?').run(expiries.length?Math.min(...expiries):0,q.scope,q.engine)
  return {owner,generation,snapshot:{entries,sources}}
}
