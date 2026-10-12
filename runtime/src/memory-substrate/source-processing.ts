import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {sha256} from './source-state.js'
import {effectiveEvidence,processingStamp,type EvidenceRecord} from './store.js'
import {profileDraftSchema} from '../personal-agent/profile-warmup.js'

const id=z.string().min(1).max(512)
const cursorSchema=z.object({seq:z.number().int().nonnegative(),offset:z.number().int().nonnegative()}).strict()
export const processingRefSchema=z.object({evidence_id:id,stamp:id,start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict().refine(r=>r.end>r.start&&r.end-r.start<=4000)
export type ProcessingRef=z.infer<typeof processingRefSchema>
export const processingTopicSchema=z.object({title:z.string().trim().min(1).max(120),summary:z.string().trim().min(1).max(1500),refs:z.array(processingRefSchema).min(1).max(8)}).strict()
const batchSchema=z.object({id,prefix:id,provider:id,items:z.array(processingRefSchema).min(1).max(8),end:cursorSchema,status:z.enum(['claimed','bound','completed','failed','invalidated']),task_id:id.nullable(),run_id:id.nullable(),created_at:z.string(),result_hash:id.nullable()}).strict()
export type ProcessingBatch=z.infer<typeof batchSchema>
const stateSchema=z.object({cursor:cursorSchema,completed_batches:z.number().int().nonnegative(),processed_chars:z.number().int().nonnegative(),last_success:z.string().nullable()}).strict()
export const SOURCE_PROCESSING_VERSION='source-processing-v1'
const base=z.object({prefix:z.string().regex(/^personal:[^:]+:$/u),provider:id,recipe:id.default(SOURCE_PROCESSING_VERSION)})
const owner={batch_id:id,task_id:id,run_id:id}
export const processingRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('claim')}).strict(),
 z.object({action:z.literal('status')}).strict(),
 z.object({action:z.literal('bind'),...owner}).strict(),
 z.object({action:z.literal('read'),batch_id:id}).strict(),
 z.object({action:z.literal('commit'),...owner,topics:z.array(processingTopicSchema).max(8)}).strict(),
 z.object({action:z.literal('fail'),...owner}).strict(),
 // Host reconciliation only: caller must first verify the Task/Run ledger, never infer termination from a timeout.
 z.object({action:z.literal('retire'),batch_id:id,task_id:id.nullable(),run_id:id.nullable(),reason:z.enum(['task_terminal','no_task_dispatched'])}).strict(),
 z.object({action:z.literal('topics'),after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(20),query:z.string().trim().max(200).default('')}).strict(),
 z.object({action:z.literal('evidence'),...owner,refs:z.array(processingRefSchema).min(1).max(8).refine(refs=>refs.reduce((sum,ref)=>sum+ref.end-ref.start,0)<=16000)}).strict(),
 z.object({action:z.literal('profile')}).strict(),
 z.object({action:z.literal('publish'),...owner,expected_revision:z.number().int().nonnegative(),draft:profileDraftSchema,refs:z.array(processingRefSchema).min(1).max(64)}).strict(),
])
export type ProcessingRequest=z.input<typeof processingRequestSchema>

/** Transactional outbox: only identifiers, never another copy of original text. */
export function initializeSourceProcessing(db:LedgerDatabase):void{
 db.exec('SAVEPOINT processing_initialize')
 try{
 db.exec(`CREATE TABLE IF NOT EXISTS processing_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,prefix TEXT NOT NULL,evidence_id TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS processing_events_scope ON processing_events(prefix,seq);
 CREATE TABLE IF NOT EXISTS processing_meta(id INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS processing_state(prefix TEXT NOT NULL,provider TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,provider));
 CREATE TABLE IF NOT EXISTS processing_batches(id TEXT PRIMARY KEY,prefix TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS processing_active ON processing_batches(prefix) WHERE status IN ('claimed','bound');
 CREATE TABLE IF NOT EXISTS processing_receipts(prefix TEXT NOT NULL,provider TEXT NOT NULL,ref_key TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(prefix,provider,ref_key));
 CREATE TABLE IF NOT EXISTS processing_topics(seq INTEGER PRIMARY KEY AUTOINCREMENT,prefix TEXT NOT NULL,provider TEXT NOT NULL,batch_id TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS processing_topics_scope ON processing_topics(prefix,provider,seq);`)
 db.exec(`CREATE TABLE IF NOT EXISTS processing_heads(key TEXT PRIMARY KEY,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS processing_profiles(prefix TEXT NOT NULL,provider TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,provider));
 CREATE TABLE IF NOT EXISTS processing_reads(batch_id TEXT NOT NULL,ref_key TEXT NOT NULL,PRIMARY KEY(batch_id,ref_key));
 CREATE TRIGGER IF NOT EXISTS processing_head_insert AFTER INSERT ON memory_message_heads BEGIN
 INSERT INTO processing_heads VALUES(NEW.key,1) ON CONFLICT(key) DO UPDATE SET revision=revision+1; END;
 CREATE TRIGGER IF NOT EXISTS processing_head_update AFTER UPDATE ON memory_message_heads WHEN OLD.evidence_id<>NEW.evidence_id BEGIN
 INSERT INTO processing_heads VALUES(NEW.key,1) ON CONFLICT(key) DO UPDATE SET revision=revision+1;
 INSERT INTO processing_events(prefix,evidence_id) SELECT substr(source_id,1,9+instr(substr(source_id,10),':')),id FROM memory_evidence WHERE id=NEW.evidence_id; END;`)
 // Pre-release ledgers without evidence-linked receipts must conservatively reprocess their affected input.
 if(!db.prepare('PRAGMA table_info(processing_receipts)').all().some(column=>column.name==='evidence_id')){
  db.exec("ALTER TABLE processing_receipts ADD COLUMN evidence_id TEXT NOT NULL DEFAULT ''; DELETE FROM processing_receipts; DELETE FROM processing_state;")
 }
 const affected=`SELECT json_extract(r.value,'$.evidence_id') FROM processing_topics t,json_each(t.payload_json,'$.refs') r WHERE EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.refs') removed WHERE json_extract(removed.value,'$.evidence_id')=OLD.id)
 UNION SELECT json_extract(r.value,'$.evidence_id') FROM processing_profiles p,json_each(p.payload_json,'$.refs') r WHERE EXISTS(SELECT 1 FROM json_each(p.payload_json,'$.refs') removed WHERE json_extract(removed.value,'$.evidence_id')=OLD.id)`
 // Erase revoked clauses, retain unrelated profile clauses, and requeue surviving mixed-topic inputs.
 db.exec(`DROP TRIGGER IF EXISTS processing_erase_derived;
 CREATE TRIGGER processing_erase_derived AFTER DELETE ON memory_evidence BEGIN
 INSERT INTO processing_events(prefix,evidence_id) SELECT substr(source_id,1,9+instr(substr(source_id,10),':')),id FROM memory_evidence WHERE id IN (${affected}) AND id<>OLD.id;
 DELETE FROM processing_receipts WHERE evidence_id=OLD.id OR evidence_id IN (${affected});
 DELETE FROM processing_topics WHERE EXISTS(SELECT 1 FROM json_each(processing_topics.payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')=OLD.id);
 UPDATE processing_profiles SET revision=revision+1,payload_json=json_object('draft',json_object(
 'about',CASE WHEN EXISTS(SELECT 1 FROM json_each(payload_json,'$.draft.about.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id) THEN NULL ELSE json_extract(payload_json,'$.draft.about') END,
 'work',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.draft.work') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id))),
 'interests',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.draft.interests') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id)))),
 'refs',json((SELECT json_group_array(json(r.value)) FROM json_each(payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')<>OLD.id)))
 WHERE EXISTS(SELECT 1 FROM json_each(processing_profiles.payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')=OLD.id);
 END;`)
 const scope=(source:string)=>`substr(${source},1,9+instr(substr(${source},10),':'))`
 for(const [event,row] of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']] as const){
  db.exec(`CREATE TRIGGER IF NOT EXISTS processing_evidence_${event.toLowerCase()} AFTER ${event} ON memory_evidence
   BEGIN INSERT INTO processing_events(prefix,evidence_id) VALUES(${scope(row+'.source_id')},${row}.id); END;`)
 }
 for(const [event,row] of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']] as const){
  db.exec(`CREATE TRIGGER IF NOT EXISTS processing_grant_${event.toLowerCase()} AFTER ${event} ON source_grants
   BEGIN INSERT INTO processing_events(prefix,evidence_id) SELECT ${scope('e.source_id')},e.id FROM memory_evidence e
   WHERE e.source_id=${row}.source_id OR e.source_id IN (SELECT json_extract(payload_json,'$.source_id') FROM source_objects WHERE connection_id=${row}.source_id); END;`)
 }
 for(const [table,key] of [['source_objects',"json_extract(NEW.payload_json,'$.source_id')"],['source_connections','NEW.id']] as const){
  const where=table==='source_objects'?`e.source_id=${key}`:`e.source_id IN (SELECT json_extract(payload_json,'$.source_id') FROM source_objects WHERE connection_id=${key})`
  const changed=table==='source_objects'?"json_extract(OLD.payload_json,'$.activation_revision') IS NOT json_extract(NEW.payload_json,'$.activation_revision')":"json_extract(OLD.payload_json,'$.fence') IS NOT json_extract(NEW.payload_json,'$.fence') OR json_extract(OLD.payload_json,'$.state') IS NOT json_extract(NEW.payload_json,'$.state')"
  db.exec(`CREATE TRIGGER IF NOT EXISTS processing_${table}_update AFTER UPDATE ON ${table} WHEN ${changed}
   BEGIN INSERT INTO processing_events(prefix,evidence_id) SELECT ${scope('e.source_id')},e.id FROM memory_evidence e WHERE ${where}; END;`)
 }
 // Ledger initialization runs in a transaction. Existing evidence is bootstrapped once.
 db.exec(`INSERT INTO processing_events(prefix,evidence_id) SELECT ${scope('source_id')},id FROM memory_evidence WHERE NOT EXISTS(SELECT 1 FROM processing_meta WHERE id=1);
 INSERT OR IGNORE INTO processing_meta VALUES(1);`)
 db.exec('RELEASE processing_initialize')
 }catch(error){db.exec('ROLLBACK TO processing_initialize; RELEASE processing_initialize');throw error}
}

function source(db:LedgerDatabase,prefix:string,provider:string,evidenceId:string,recipe:string):{record:EvidenceRecord;stamp:string}|null{
 const record=effectiveEvidence(db,evidenceId,{purpose:'extraction',provider})
 if(!record?.raw_text||!record.id.startsWith(prefix)||!record.source_id.startsWith(prefix)||!['file','mail','im'].includes(record.source_kind))return null
 // Content-addressed message versions retain history; only their current head is eligible.
 if(['mail','im'].includes(record.source_kind)){
  const head=db.prepare('SELECT evidence_id FROM memory_message_heads WHERE key=?').get(sha256(canonicalJson([record.source_id,record.locator])))
  if(head?.evidence_id!==undefined&&head.evidence_id!==record.id)return null
  if(!head&&db.prepare("SELECT 1 FROM memory_evidence WHERE source_id=? AND json_extract(payload_json,'$.locator')=? AND rowid>(SELECT rowid FROM memory_evidence WHERE id=?) LIMIT 1").get(record.source_id,record.locator,record.id))return null
  const m=record.source_metadata
  if(!m||(record.source_kind==='im'?m.sender_id!==m.recipient_id&&m.mention!=='direct':m.sender_id!==m.account_id))return null
 }
 const grant=processingStamp(db,[record.id],'extraction',provider)
 const headRevision=db.prepare('SELECT revision FROM processing_heads WHERE key=?').get(sha256(canonicalJson([record.source_id,record.locator])))?.revision??0
 return grant?{record,stamp:sha256(canonicalJson({record,grant,headRevision,recipe,algorithm:SOURCE_PROCESSING_VERSION}))}:null
}
function readRefs(db:LedgerDatabase,prefix:string,provider:string,refs:ProcessingRef[],recipe:string){
 const items=[]
 for(const ref of refs){const current=source(db,prefix,provider,ref.evidence_id,recipe)
  if(current?.stamp!==ref.stamp||ref.end>current.record.raw_text!.length)return null
  items.push({...ref,text:current.record.raw_text!.slice(ref.start,ref.end),version:current.record.hash,source_kind:current.record.source_kind,observed_at:current.record.observed_at,source_metadata:current.record.source_metadata??null,locator:current.record.locator})
 }
 return {items}
}
function saveBatch(db:LedgerDatabase,batch:ProcessingBatch){db.prepare('INSERT INTO processing_batches VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json').run(batch.id,batch.prefix,batch.provider,batch.status,canonicalJson(batch))}
function saveState(db:LedgerDatabase,prefix:string,provider:string,state:z.infer<typeof stateSchema>){db.prepare('INSERT INTO processing_state VALUES(?,?,?) ON CONFLICT(prefix,provider) DO UPDATE SET payload_json=excluded.payload_json').run(prefix,provider,canonicalJson(state))}

/** Runs exclusively inside the memory worker transaction. No timers or model calls. */
export function sourceProcessingOperation(db:LedgerDatabase,input:unknown):unknown{
 const fields=z.record(z.string(),z.unknown()).parse(input),{prefix,provider:consumer,recipe}=base.parse(fields)
 const provider=sha256(canonicalJson({consumer,recipe,algorithm:SOURCE_PROCESSING_VERSION}))
 const {prefix:ignoredPrefix,provider:ignoredProvider,recipe:ignoredRecipe,...request}=fields
 void ignoredPrefix;void ignoredProvider;void ignoredRecipe
 const q=processingRequestSchema.parse(request)
 const saved=db.prepare('SELECT payload_json FROM processing_state WHERE prefix=? AND provider=?').get(prefix,provider)
 const state=saved?stateSchema.parse(JSON.parse(String(saved.payload_json))):{cursor:{seq:0,offset:0},completed_batches:0,processed_chars:0,last_success:null}
 const active=()=>{const row=db.prepare("SELECT payload_json FROM processing_batches WHERE prefix=? AND provider=? AND status IN ('claimed','bound')").get(prefix,provider);return row?batchSchema.parse(JSON.parse(String(row.payload_json))):null}
 if(q.action==='retire'){
  const row=db.prepare('SELECT payload_json FROM processing_batches WHERE id=? AND prefix=?').get(q.batch_id,prefix)
  if(!row)throw Error('STORE_NOT_FOUND')
  const prior=batchSchema.parse(JSON.parse(String(row.payload_json)))
  if(prior.task_id!==q.task_id||prior.run_id!==q.run_id)throw Error('STORE_IDEMPOTENCY_CONFLICT')
  if(q.reason==='no_task_dispatched'?(prior.task_id!==null||prior.run_id!==null):(prior.task_id===null||prior.run_id===null))throw Error('STORE_INVALID_OPERATION')
  if(['claimed','bound'].includes(prior.status)){prior.status='failed';saveBatch(db,prior)}
  return {applied:true}
 }
 if(q.action==='status'){
  const row=db.prepare('SELECT count(*) count,max(seq) high FROM processing_events WHERE prefix=? AND seq>=?').get(prefix,state.cursor.seq+Number(state.cursor.offset===0))!
  const prior=db.prepare("SELECT payload_json FROM processing_batches WHERE prefix=? AND status IN ('claimed','bound')").get(prefix)
  const blocking=prior?batchSchema.parse(JSON.parse(String(prior.payload_json))):null
  return {...state,active_batch:blocking,reconciliation_required:!!blocking&&blocking.provider!==provider,pending_changes:Number(row.count),high_watermark:Number(row.high??state.cursor.seq)}
 }
 if(q.action==='claim'){
  const existing=active();if(existing)return existing
  if(db.prepare("SELECT 1 FROM processing_batches WHERE prefix=? AND status IN ('claimed','bound')").get(prefix))throw Error('STORE_OPERATION_CONFLICT')
  const events=db.prepare('SELECT seq,evidence_id FROM processing_events WHERE prefix=? AND seq>=? ORDER BY seq LIMIT 200').all(prefix,state.cursor.seq+Number(state.cursor.offset===0))
  if(!events.length)return null
  const end={...state.cursor},items:ProcessingRef[]=[],seen=new Set<string>();let chars=0
  for(const event of events){
   const seq=Number(event.seq),current=source(db,prefix,consumer,String(event.evidence_id),recipe)
   if(!current){end.seq=seq;end.offset=0;continue}
   const text=current.record.raw_text!;let start=seq===end.seq?end.offset:0
   while(start<text.length){
    const stop=Math.min(start+4000,text.length),ref={evidence_id:current.record.id,stamp:current.stamp,start,end:stop},key=sha256(canonicalJson(ref))
    if(!seen.has(key)&&!db.prepare('SELECT 1 FROM processing_receipts WHERE prefix=? AND provider=? AND ref_key=?').get(prefix,provider,key)){
     if(items.length>=8||chars+stop-start>16000)break
     items.push(ref);seen.add(key);chars+=stop-start
    }
    start=stop
   }
   if(start===0&&text.length>0&&(items.length>=8||chars+Math.min(4000,text.length)>16000))break
   end.seq=seq;end.offset=start===text.length?0:start
   if(start<text.length)break
  }
  if(!items.length){state.cursor=end;saveState(db,prefix,provider,state);return null}
  const batch:ProcessingBatch={id:randomUUID(),prefix,provider,items,end,status:'claimed',task_id:null,run_id:null,created_at:new Date().toISOString(),result_hash:null}
  saveBatch(db,batch);return batch
 }
 if(q.action==='topics'){
  const rows=db.prepare("SELECT seq,payload_json FROM processing_topics WHERE prefix=? AND provider=? AND seq>? AND (?='' OR instr(lower(json_extract(payload_json,'$.title')||' '||json_extract(payload_json,'$.summary')),lower(?))>0) ORDER BY seq LIMIT ?").all(prefix,provider,q.after,q.query,q.query,q.limit+1)
  const page=rows.slice(0,q.limit)
  return {items:page.flatMap(row=>{const topic=processingTopicSchema.parse(JSON.parse(String(row.payload_json)));return readRefs(db,prefix,consumer,topic.refs,recipe)?[{id:Number(row.seq),...topic}]:[]}),next:rows.length>q.limit?Number(page.at(-1)!.seq):null}
 }
 if(q.action==='profile'){
  const saved=db.prepare('SELECT revision,payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider)
  if(!saved)return {revision:0,draft:null}
  const content=z.object({draft:profileDraftSchema,refs:z.array(processingRefSchema)}).parse(JSON.parse(String(saved.payload_json)))
  const valid=(fact:{refs:{entry_id:string;version:unknown}[]})=>fact.refs.every(ref=>{
   const refs=content.refs.filter(item=>item.evidence_id===ref.entry_id)
   return refs.length>0&&readRefs(db,prefix,consumer,refs,recipe)!==null
  })
  const draft={...content.draft,about:content.draft.about&&valid(content.draft.about)?content.draft.about:null,work:content.draft.work.filter(valid),interests:content.draft.interests.filter(valid)}
  return {revision:Number(saved.revision),draft:draft.about||draft.work.length||draft.interests.length?draft:null}
 }
 const row=db.prepare('SELECT payload_json FROM processing_batches WHERE id=? AND prefix=? AND provider=?').get(q.batch_id,prefix,provider)
 if(!row)throw Error('STORE_NOT_FOUND')
 const batch=batchSchema.parse(JSON.parse(String(row.payload_json)))
 const read=(refs:ProcessingRef[])=>{
  const result=readRefs(db,prefix,consumer,refs,recipe)
  if(result)for(const ref of refs)db.prepare('INSERT OR IGNORE INTO processing_reads VALUES(?,?)').run(batch.id,sha256(canonicalJson(ref)))
  return result
 }
 if(q.action==='read')return ['claimed','bound'].includes(batch.status)?read(batch.items):null
 if(q.action==='bind'){
  if(batch.task_id===q.task_id&&batch.run_id===q.run_id)return batch
  if(batch.task_id||batch.status!=='claimed')throw Error('STORE_IDEMPOTENCY_CONFLICT')
  batch.task_id=q.task_id;batch.run_id=q.run_id;batch.status='bound';saveBatch(db,batch);return batch
 }
 if(batch.task_id!==q.task_id||batch.run_id!==q.run_id)throw Error('STORE_IDEMPOTENCY_CONFLICT')
 if(q.action==='evidence'){
  if(!['bound','completed'].includes(batch.status))throw Error('STORE_INVALID_OPERATION')
  return read(q.refs)
 }
 if(q.action==='publish'){
  if(!['bound','completed'].includes(batch.status))throw Error('STORE_INVALID_OPERATION')
  const saved=db.prepare('SELECT revision,payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider)
  const revision=Number(saved?.revision??0),payload=canonicalJson({draft:q.draft,refs:q.refs})
  if(revision===q.expected_revision+1&&saved?.payload_json===payload)return {applied:true,revision}
  if(revision!==q.expected_revision)throw Error('STORE_STALE_REVISION')
  const originals=readRefs(db,prefix,consumer,q.refs,recipe);if(!originals)return {applied:false,revision}
  if(q.refs.some(ref=>!db.prepare('SELECT 1 FROM processing_reads WHERE batch_id=? AND ref_key=?').get(batch.id,sha256(canonicalJson(ref)))))throw Error('STORE_INVALID_OPERATION')
  const cited=[...(q.draft.about?.refs??[]),...q.draft.work.flatMap(item=>item.refs),...q.draft.interests.flatMap(item=>item.refs)]
  if(!cited.length||cited.some(ref=>!originals.items.some(item=>item.evidence_id===ref.entry_id&&item.version===ref.version)))throw Error('STORE_INVALID_OPERATION')
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?) ON CONFLICT(prefix,provider) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json').run(prefix,provider,revision+1,payload)
  return {applied:true,revision:revision+1}
 }
 if(q.action==='fail'){
  if(batch.status==='failed')return {applied:true}
  if(batch.status!=='bound')throw Error('STORE_INVALID_OPERATION')
  batch.status='failed';saveBatch(db,batch);return {applied:true}
 }
 const resultHash=sha256(canonicalJson(q.topics))
 if(batch.status==='completed'){if(batch.result_hash!==resultHash)throw Error('STORE_IDEMPOTENCY_CONFLICT');return {applied:true}}
 if(batch.status!=='bound')throw Error('STORE_INVALID_OPERATION')
 const available=new Set(batch.items.map(ref=>canonicalJson(ref)))
 if(q.topics.some(topic=>topic.refs.some(ref=>!available.has(canonicalJson(ref)))))throw Error('STORE_INVALID_OPERATION')
 if(!readRefs(db,prefix,consumer,batch.items,recipe)){batch.status='invalidated';saveBatch(db,batch);return {applied:false}}
 for(const topic of q.topics)db.prepare('INSERT INTO processing_topics(prefix,provider,batch_id,payload_json) VALUES(?,?,?,?)').run(prefix,provider,batch.id,canonicalJson(topic))
 for(const ref of batch.items)db.prepare('INSERT OR IGNORE INTO processing_receipts VALUES(?,?,?,?)').run(prefix,provider,sha256(canonicalJson(ref)),ref.evidence_id)
 state.cursor=batch.end;state.completed_batches++;state.processed_chars+=batch.items.reduce((sum,ref)=>sum+ref.end-ref.start,0);state.last_success=new Date().toISOString()
 batch.status='completed';batch.result_hash=resultHash;saveBatch(db,batch);saveState(db,prefix,provider,state)
 return {applied:true}
}
