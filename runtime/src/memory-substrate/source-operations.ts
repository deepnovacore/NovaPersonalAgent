import {z} from 'zod'
import type {GraphDatabase} from '../workspace-graph/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {EvidenceRecordSchema,type MemoryOperation} from './store.js'
import {connectionSchema,readConnection,sourceObjectSchema,sourceIdSchema,revisionSchema,fenceSchema,connectorSourceId,sha256,readProcessingGrant,processingGrantSchema,type SourceConnection,type Activation} from './source-state.js'

type Run=(operation:MemoryOperation,input:unknown)=>unknown
const changeSchema=z.object({object_key:sourceIdSchema,source_id:sourceIdSchema,semantic_hash:sourceIdSchema,metadata:z.record(z.string(),z.json()),evidence:z.array(z.lazy(()=>EvidenceRecordSchema)).max(256),status:z.enum(['current','coverage_removed','provider_deleted'])}).strict()
export const applyPageSchema=z.object({fence:fenceSchema,batch_id:z.string().regex(/^[1-9][0-9]{0,14}$/u),page_id:sourceIdSchema,changes:z.array(changeSchema).max(200),pending_ids:z.array(sourceIdSchema).max(200),continuation:z.json(),checkpoint:z.json(),complete:z.boolean()}).strict()
export type ApplyPage=z.infer<typeof applyPageSchema>
export type PageResult={revision:number;applied:boolean;activations:Activation[]}
export function sourceRevision(db:GraphDatabase):number{return Number(db.prepare('SELECT revision FROM source_clock WHERE id=1').get()!.revision)}
export function advanceSourceRevision(db:GraphDatabase):number{db.exec('UPDATE source_clock SET revision=revision+1 WHERE id=1');return sourceRevision(db)}
function save(db:GraphDatabase,c:SourceConnection):void{db.prepare('INSERT INTO source_connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(c.fence.connection_id,canonicalJson(connectionSchema.parse(c)))}
export function sourceOperation(db:GraphDatabase,operation:string,input:unknown,run:Run):unknown{
 const v=z.record(z.string(),z.unknown()).parse(input)
 if(operation==='source_revision')return sourceRevision(db)
 if(operation==='source_grant'){
  const q=z.object({source_id:z.string().min(1).max(512),action:z.literal('get').optional(),expected_revision:revisionSchema.optional(),grant:processingGrantSchema.optional()}).strict().parse(v)
  const old=readProcessingGrant(db,q.source_id)
  if(q.action==='get')return old
  if(!q.grant||q.expected_revision!==(old?.revision??0)||q.grant.revision<=q.expected_revision)throw Error('STORE_STALE_REVISION')
  db.prepare('INSERT INTO source_grants VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json').run(q.source_id,canonicalJson(q.grant))
  db.prepare("DELETE FROM memory_vectors WHERE entry_id IN (SELECT r.entry_id FROM memory_revisions r,json_each(r.payload_json,'$.evidence_refs') refs JOIN memory_evidence e ON e.id=refs.value WHERE e.source_id=?)").run(q.source_id)
  return q.grant
 }
 if(operation==='source_connection'){
  const id=sourceIdSchema.parse(v.id),c=readConnection(db,id)
  if(v.action==='get')return c
  if(v.action==='create'){
   const q=z.object({action:z.literal('create'),id:sourceIdSchema,namespace:sourceIdSchema}).strict().parse(v)
   if(c){if(c.namespace!==q.namespace)throw Error('STORE_IDEMPOTENCY_CONFLICT');return c}
   const fresh:SourceConnection={fence:{connection_id:id,generation:0,epoch:0,scope_revision:0},namespace:q.namespace,state:'paused',scope:null,checkpoint:null,continuation:null,pending_ids:[],batch:0,completed_batch:0,deleting:[]}
   save(db,fresh);return fresh
  }
  if(!c)throw Error('STORE_NOT_FOUND')
  if(v.action==='fence'){
   const q=z.object({action:z.literal('fence'),id:sourceIdSchema,state:z.enum(['connected','paused','disconnected']),expected_epoch:revisionSchema}).strict().parse(v)
   if(q.expected_epoch!==c.fence.epoch)throw Error('STORE_STALE_REVISION')
   c.fence.epoch++;c.state=q.state;save(db,c);return c
  }
  throw Error('STORE_INVALID_OPERATION')
 }
 if(operation==='source_pending'){
  const q=z.object({id:sourceIdSchema,after:sourceIdSchema.optional(),object_key:sourceIdSchema.optional(),limit:z.number().int().min(1).max(200).default(200)}).strict().parse(v)
  const c=readConnection(db,q.id);if(!c)throw Error('STORE_NOT_FOUND')
  const objects=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key>? ORDER BY object_key LIMIT ?').all(q.id,c.fence.generation,q.after??'',q.limit+1).map(row=>sourceObjectSchema.parse(JSON.parse(String(row.payload_json))))
  return {connection:c,objects:objects.slice(0,q.limit).filter(o=>!q.object_key||o.object_key===q.object_key),next:objects.length>q.limit?objects[q.limit-1]!.object_key:null}
 }
 if(operation==='source_apply_page'){
  if(Buffer.byteLength(JSON.stringify(v))>5*1024*1024)throw Error('STORE_INVALID_OPERATION')
  const q=applyPageSchema.parse(v),c=readConnection(db,q.fence.connection_id)
  if(!c||c.state!=='connected'||canonicalJson(c.fence)!==canonicalJson(q.fence))throw Error('STORE_STALE_REVISION')
  const hash=sha256(canonicalJson(q))
  const receipt=db.prepare('SELECT payload_hash,result_json FROM source_pages WHERE connection_id=? AND batch_id=? AND page_id=?').get(q.fence.connection_id,q.batch_id,q.page_id)
  if(receipt){if(receipt.payload_hash!==hash)throw Error('STORE_IDEMPOTENCY_CONFLICT');return {...JSON.parse(String(receipt.result_json)) as PageResult,applied:false}}
  if(q.complete&&q.pending_ids.length)throw Error('STORE_INVALID_OPERATION')
  const activations:Activation[]=[]
  const seen=new Set<string>()
  for(const change of q.changes){
   if(seen.has(change.object_key))throw Error('STORE_INVALID_OPERATION');seen.add(change.object_key)
   if(change.source_id!==connectorSourceId(c.namespace,c.fence.generation,change.object_key)||change.evidence.some(e=>e.source_id!==change.source_id)||((change.status==='current')!==(change.evidence.length>0)))throw Error('STORE_INVALID_OPERATION')
   const oldRow=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key=?').get(q.fence.connection_id,q.fence.generation,change.object_key)
   const old=oldRow?sourceObjectSchema.parse(JSON.parse(String(oldRow.payload_json))):null
   const changed=!old||old.semantic_hash!==change.semantic_hash||old.status!==change.status
   // Metadata-only updates must not replace the content-addressed current set.
   if(!changed&&canonicalJson(old.current_evidence_ids)!==canonicalJson(change.evidence.map(e=>e.id)))throw Error('STORE_IDEMPOTENCY_CONFLICT')
   for(const evidence of change.evidence)run('append_evidence',evidence)
   const next=sourceObjectSchema.parse({connection_id:q.fence.connection_id,generation:q.fence.generation,object_key:change.object_key,source_id:change.source_id,semantic_hash:change.semantic_hash,metadata:change.metadata,current_evidence_ids:change.evidence.map(e=>e.id),activation_revision:(old?.activation_revision??0)+Number(changed),status:change.status,observed_at:new Date().toISOString()})
   db.prepare('INSERT INTO source_objects VALUES(?,?,?,?) ON CONFLICT(connection_id,generation,object_key) DO UPDATE SET payload_json=excluded.payload_json').run(next.connection_id,next.generation,next.object_key,canonicalJson(next))
   if(changed){
    activations.push({object_key:next.object_key,revision:next.activation_revision})
    run('invalidate_evidence',{ids:old?.current_evidence_ids??[]})
    for(const id of next.current_evidence_ids)db.prepare('DELETE FROM memory_extractions WHERE evidence_id=?').run(id)
   }
  }
  c.pending_ids=q.pending_ids;c.continuation=q.continuation;c.batch=Number(q.batch_id)
  if(q.complete){c.checkpoint=q.checkpoint;c.completed_batch=c.batch}
  save(db,c)
  const result:PageResult={revision:advanceSourceRevision(db),applied:true,activations}
  db.prepare('INSERT INTO source_pages VALUES(?,?,?,?,?)').run(q.fence.connection_id,q.batch_id,q.page_id,hash,canonicalJson(result))
  return result
 }
 throw Error('STORE_INVALID_OPERATION')
}
