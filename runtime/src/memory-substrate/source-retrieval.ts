import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {sourceFilterSchema,type SourceRecallResult} from '../memory/source-retrieval.js'
import {effectiveEvidence,type EvidenceRecord} from './store.js'
import {bm25} from './retrieval.js'

/** Discover synced originals without requiring extraction or an embedding service. */
export function searchSourceEvidence(db:LedgerDatabase,input:unknown):SourceRecallResult {
 const q=z.object({source_prefix:z.string().min(1).startsWith('personal:').endsWith(':'),consumer:z.string().min(1).max(256),query:z.string().trim().min(1).max(512),scope:z.enum(['recent','any']),limit:z.number().int().min(1).max(8),filter:sourceFilterSchema.optional()}).strict().parse(input)
 const filter=q.filter??{},cap=q.scope==='recent'?200:5000
 const now=Date.now(),since=filter.last_days===undefined?filter.since:new Date(now-filter.last_days*86400000).toISOString(),before=filter.last_days===undefined?filter.before:new Date(now).toISOString()
 const provider=`coalesce(json_extract(payload_json,'$.source_metadata.provider'),CASE WHEN json_extract(payload_json,'$.locator') LIKE 'feishu://%' THEN 'feishu' ELSE '' END)`
 // Files already have a knowledge index; do not let a large file corpus crowd out communications.
 const rows=db.prepare(`SELECT id FROM memory_evidence WHERE substr(source_id,1,?)=?
  AND (json_extract(payload_json,'$.source_kind') IN ('im','mail','calendar') OR (?='file' AND json_extract(payload_json,'$.source_kind')='file'))
  AND (? IS NULL OR json_extract(payload_json,'$.source_kind')=?)
  AND (? IS NULL OR ${provider}=?)
  AND (? IS NULL OR julianday(json_extract(payload_json,'$.observed_at'))>=julianday(?))
  AND (? IS NULL OR julianday(json_extract(payload_json,'$.observed_at'))<julianday(?))
  ORDER BY julianday(json_extract(payload_json,'$.observed_at')) DESC,id LIMIT ?`).all(q.source_prefix.length,q.source_prefix,filter.kind??null,filter.kind??null,filter.kind??null,filter.provider??null,filter.provider??null,since??null,since??null,before??null,before??null,cap+1)
 const candidates:EvidenceRecord[]=[]
 for(const row of rows.slice(0,cap)){
  const record=effectiveEvidence(db,String(row.id),{purpose:'conversation',provider:q.consumer})
  if(record?.raw_text?.trim())candidates.push(record)
 }
 const scores=bm25(q.query,candidates.map(row=>[row.raw_text,row.source_metadata?.sender_name,row.source_metadata?.provider,row.locator.startsWith('feishu://')?'飞书 Feishu':''].filter(Boolean).join(' ')))
 return {hits:candidates.map((row,index)=>({evidence_id:row.id,score:scores[index]!})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,q.limit),truncated:rows.length>cap}
}
