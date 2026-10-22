import {understandingProductsSchema,projectCorrectionSchema} from '../personal-agent/understanding-products.js'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {sha256} from './source-state.js'
import {effectiveEvidence,processingStamp,type EvidenceRecord} from './store.js'
import {profileDraftSchema,PROFILE_GENERATION_VERSION} from '../personal-agent/profile-warmup.js'

const id=z.string().min(1).max(512)
const cursorSchema=z.object({seq:z.number().int().nonnegative(),offset:z.number().int().nonnegative()}).strict()
export const processingRefSchema=z.object({evidence_id:id,stamp:id,start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict().refine(r=>r.end>r.start&&r.end-r.start<=4000)
export type ProcessingRef=z.infer<typeof processingRefSchema>
export const processingObservationSchema=z.object({kind:z.enum(['people','work','style']),text:z.string().trim().min(1).max(400),refs:z.array(processingRefSchema).min(1).max(8)}).strict()
export type ProcessingObservation=z.infer<typeof processingObservationSchema>

const profileCacheSchema=z.object({about_parts:z.array(profileDraftSchema.shape.about.unwrap()).optional(),draft:profileDraftSchema,refs:z.array(processingRefSchema),products:understandingProductsSchema.optional(),generated_at:z.string().optional()}).extend({generation_version:z.string().optional(),fact_scopes:z.record(z.string(),z.array(processingRefSchema)).optional(),publication_key:z.string().optional(),synthesis_key:z.string().optional(),profile_pending:z.boolean().optional()})
const storedIdentitySchema=z.object({id:z.string(),kind:z.string(),title:z.string(),project_id:z.string().nullable(),source_key:z.string()})
export const processingTopicSchema=z.object({title:z.string().trim().min(1).max(120),summary:z.string().trim().min(1).max(1500),refs:z.array(processingRefSchema).min(1).max(8)}).strict()
const batchSchema=z.object({profile_only:z.boolean().optional(),priority:z.boolean().optional(),correction_version:z.string().optional(),id,prefix:id,provider:id,items:z.array(processingRefSchema).min(1).max(8),end:cursorSchema,status:z.enum(['claimed','bound','completed','failed','invalidated']),task_id:id.nullable(),run_id:id.nullable(),created_at:z.string(),result_hash:id.nullable()}).strict()
export type ProcessingBatch=z.infer<typeof batchSchema>
const stateSchema=z.object({cursor:cursorSchema,completed_batches:z.number().int().nonnegative(),processed_chars:z.number().int().nonnegative(),last_success:z.string().nullable()}).strict()
export const SOURCE_PROCESSING_VERSION='source-processing-v5'
const base=z.object({prefix:z.string().regex(/^personal:[^:]+:$/u),provider:id,recipe:id.default(SOURCE_PROCESSING_VERSION),participants:z.boolean().default(false)})
const owner={batch_id:id,task_id:id,run_id:id}
export const processingRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('claim')}).strict(),
 z.object({action:z.literal('status')}).strict(),
 z.object({action:z.literal('batch'),batch_id:id}).strict(),
 z.object({action:z.literal('bind'),...owner}).strict(),
 z.object({action:z.literal('read'),batch_id:id}).strict(),
 z.object({action:z.literal('commit'),...owner,topics:z.array(processingTopicSchema).max(8)}).strict(),
 z.object({action:z.literal('fail'),...owner}).strict(),
 // Host reconciliation only: caller must first verify the Task/Run ledger, never infer termination from a timeout.
 z.object({action:z.literal('retire'),batch_id:id,task_id:id.nullable(),run_id:id.nullable(),reason:z.enum(['task_terminal','no_task_dispatched'])}).strict(),
 z.object({action:z.literal('topics'),batch_id:id.optional(),after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(20),query:z.string().trim().max(200).default('')}).strict(),
 z.object({action:z.literal('evidence'),...owner,refs:z.array(processingRefSchema).min(1).max(8).refine(refs=>refs.reduce((sum,ref)=>sum+ref.end-ref.start,0)<=16000)}).strict(),
 z.object({action:z.literal('profile'),batch_id:id.optional()}).strict(),
 z.object({action:z.literal('observe'),...owner,refs:z.array(processingRefSchema).min(1).max(8),observations:z.array(processingObservationSchema).max(24)}).strict(),
 z.object({action:z.literal('profile_context'),...owner}).strict(),
 z.object({action:z.literal('identities'),...owner,refs:z.array(processingRefSchema).min(1).max(8)}).strict(),
 z.object({action:z.literal('products'),include_dismissed:z.boolean().optional(),presentation:z.boolean().optional(),account_scope:id.optional()}).strict(),
 z.object({action:z.literal('confirm_cleanup')}).strict(),
 z.object({action:z.literal('dismiss'),id}).strict(),
 z.object({action:z.literal('correct_project'),id,value:projectCorrectionSchema}).strict(),
 z.object({action:z.literal('refresh')}).strict(),
 z.object({action:z.literal('project_state'),ids:z.array(id).min(1).max(512),fingerprint:id}).strict(),
 z.object({action:z.literal('publish'),...owner,expected_revision:z.number().int().nonnegative(),draft:profileDraftSchema,refs:z.array(processingRefSchema).max(128),profile_context_key:id.optional(),defer_profile:z.boolean().optional(),product_refs:z.array(processingRefSchema).max(8).optional(),products:understandingProductsSchema.optional()}).strict(),
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
 db.exec(`CREATE TABLE IF NOT EXISTS processing_observations(prefix TEXT NOT NULL,provider TEXT NOT NULL,key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,provider,key));
 CREATE TABLE IF NOT EXISTS processing_identities(prefix TEXT NOT NULL,id TEXT NOT NULL,evidence_id TEXT NOT NULL,source_key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,id));
 CREATE TABLE IF NOT EXISTS processing_decisions(prefix TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(prefix,kind,id));
 CREATE TABLE IF NOT EXISTS processing_heads(key TEXT PRIMARY KEY,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS processing_profiles(prefix TEXT NOT NULL,provider TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,provider));
 CREATE TABLE IF NOT EXISTS processing_publications(prefix TEXT NOT NULL,provider TEXT NOT NULL,publication_key TEXT NOT NULL,scope_json TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(prefix,provider,publication_key));
 CREATE TABLE IF NOT EXISTS processing_reads(batch_id TEXT NOT NULL,ref_key TEXT NOT NULL,PRIMARY KEY(batch_id,ref_key));
 CREATE TRIGGER IF NOT EXISTS processing_head_insert AFTER INSERT ON memory_message_heads BEGIN
 INSERT INTO processing_heads VALUES(NEW.key,1) ON CONFLICT(key) DO UPDATE SET revision=revision+1; END;
 CREATE TRIGGER IF NOT EXISTS processing_head_update AFTER UPDATE ON memory_message_heads WHEN OLD.evidence_id<>NEW.evidence_id BEGIN
 INSERT INTO processing_heads VALUES(NEW.key,1) ON CONFLICT(key) DO UPDATE SET revision=revision+1;
 INSERT INTO processing_events(prefix,evidence_id) SELECT substr(source_id,1,9+instr(substr(source_id,10),':')),id FROM memory_evidence WHERE id=NEW.evidence_id; END;`)
 if(!db.prepare('PRAGMA table_info(processing_reads)').all().some(column=>column.name==='payload_json'))db.exec('ALTER TABLE processing_reads ADD COLUMN payload_json TEXT')
 // Pre-release ledgers without evidence-linked receipts must conservatively reprocess their affected input.
 if(!db.prepare('PRAGMA table_info(processing_receipts)').all().some(column=>column.name==='evidence_id')){
  db.exec("ALTER TABLE processing_receipts ADD COLUMN evidence_id TEXT NOT NULL DEFAULT ''; DELETE FROM processing_receipts; DELETE FROM processing_state;")
 }
 for(const row of db.prepare("SELECT prefix,provider,payload_json FROM processing_profiles ORDER BY coalesce(json_extract(payload_json,'$.generated_at'),''),rowid").all())archivePublication(db,String(row.prefix),String(row.provider),String(row.payload_json))
 const affected=`SELECT json_extract(r.value,'$.evidence_id') FROM processing_topics t,json_each(t.payload_json,'$.refs') r WHERE EXISTS(SELECT 1 FROM json_each(t.payload_json,'$.refs') removed WHERE json_extract(removed.value,'$.evidence_id')=OLD.id)
 UNION SELECT json_extract(r.value,'$.evidence_id') FROM processing_profiles p,json_each(p.payload_json,'$.refs') r WHERE EXISTS(SELECT 1 FROM json_each(p.payload_json,'$.refs') removed WHERE json_extract(removed.value,'$.evidence_id')=OLD.id)`
 // Erase revoked clauses, retain unrelated profile clauses, and requeue surviving mixed-topic inputs.
 db.exec(`DROP TRIGGER IF EXISTS processing_erase_derived;
 CREATE TRIGGER processing_erase_derived AFTER DELETE ON memory_evidence BEGIN
 INSERT INTO processing_decisions(prefix,kind,id,value)
 SELECT prefix,'policy','cleanup','pending' FROM processing_profiles p WHERE EXISTS(
 SELECT 1 FROM json_each(p.payload_json,'$.draft.interests') interest,json_each(interest.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id)
 ON CONFLICT(prefix,kind,id) DO UPDATE SET value='pending';
 DELETE FROM processing_identities WHERE evidence_id=OLD.id;
 DELETE FROM processing_observations WHERE EXISTS(SELECT 1 FROM json_each(payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')=OLD.id);
 INSERT INTO processing_events(prefix,evidence_id) SELECT substr(source_id,1,9+instr(substr(source_id,10),':')),id FROM memory_evidence WHERE id IN (${affected}) AND id<>OLD.id;
 DELETE FROM processing_receipts WHERE evidence_id=OLD.id OR evidence_id IN (${affected});
 DELETE FROM processing_topics WHERE EXISTS(SELECT 1 FROM json_each(processing_topics.payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')=OLD.id);
 UPDATE processing_profiles SET revision=revision+1,payload_json=json_set(payload_json,'$.draft',json_object(
 'about',CASE WHEN EXISTS(SELECT 1 FROM json_each(payload_json,'$.draft.about.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id) THEN NULL ELSE json_extract(payload_json,'$.draft.about') END,
 'work',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.draft.work') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id))),
 'interests',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.draft.interests') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id)))),
 '$.refs',json((SELECT json_group_array(json(r.value)) FROM json_each(payload_json,'$.refs') r WHERE json_extract(r.value,'$.evidence_id')<>OLD.id)),
 '$.about_parts',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.about_parts') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id))),
 '$.products.projects',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.products.projects') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id))),
 '$.products.suggestions',json((SELECT json_group_array(json(item.value)) FROM json_each(payload_json,'$.products.suggestions') item WHERE NOT EXISTS(SELECT 1 FROM json_each(item.value,'$.refs') r WHERE json_extract(r.value,'$.entry_id')=OLD.id))))
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
 db.exec(`CREATE TRIGGER IF NOT EXISTS processing_correction_insert AFTER INSERT ON memory_revisions WHEN json_extract(NEW.payload_json,'$.written_by')='user_correction' BEGIN INSERT INTO processing_events(prefix,evidence_id) SELECT substr(e.source_id,1,9+instr(substr(e.source_id,10),':')),e.id FROM memory_evidence e,json_each(NEW.payload_json,'$.evidence_refs') refs WHERE e.id=refs.value AND json_extract(e.payload_json,'$.source_kind')='user_correction'; END;`)
 // Ledger initialization runs in a transaction. Existing evidence is bootstrapped once.
 db.exec(`INSERT INTO processing_events(prefix,evidence_id) SELECT ${scope('source_id')},id FROM memory_evidence WHERE NOT EXISTS(SELECT 1 FROM processing_meta WHERE id=1);
 INSERT OR IGNORE INTO processing_meta VALUES(1);`)
 db.exec('RELEASE processing_initialize')
 }catch(error){db.exec('ROLLBACK TO processing_initialize; RELEASE processing_initialize');throw error}
}


/** Published prose belongs to the user independently of its original evidence.
 * This table never contains raw evidence and never feeds model input or adoption.
 * Legacy imports require every cited source's identity to still be provable. */
function archivePublication(db:LedgerDatabase,prefix:string,provider:string,payload:string){
 const parsed=profileCacheSchema.safeParse(JSON.parse(payload));if(!parsed.success)return
 const content=parsed.data;if(content.profile_pending||!content.draft.about&&!content.draft.work.length&&!content.draft.interests.length)return
 const key=content.publication_key??sha256(payload)
 if(db.prepare('SELECT 1 FROM processing_publications WHERE prefix=? AND provider=? AND publication_key=?').get(prefix,provider,key))return
 const refs=[...(content.draft.about?.refs??[]),...content.draft.work.flatMap(f=>f.refs),...content.draft.interests.flatMap(f=>f.refs),...(content.products?.projects.flatMap(f=>f.refs)??[]),...(content.products?.suggestions.flatMap(f=>f.refs)??[])],accounts=new Set<string>(),sources=[]
 for(const ref of [...new Map(refs.map(ref=>[ref.entry_id,ref])).values()]){
  if(!ref.entry_id.startsWith(prefix))return
  const row=db.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get(ref.entry_id);if(!row)return
  const record=JSON.parse(String(row.payload_json)) as EvidenceRecord
  if(record.hash!==ref.version||!record.source_id.startsWith(prefix))return
  if(['im','mail'].includes(record.source_kind)){const account=record.source_metadata?.account_id;if(typeof account!=='string'||!account)return;accounts.add(account)}
  sources.push({id:ref.entry_id,version:String(ref.version),label:record.locator,observed_at:record.observed_at,type:record.source_kind})
 }
 if(!sources.length)return
 const published={draft:content.draft,projects:content.products?.projects??[],suggestions:(content.products?.suggestions??[]).map(suggestion=>{const item={...suggestion};delete item.anchor;delete item.date_evidence;return item}),generation_version:content.generation_version??null,generated_at:content.generated_at??null,sources}
 db.prepare('INSERT OR IGNORE INTO processing_publications VALUES(?,?,?,?,?)').run(prefix,provider,key,canonicalJson([...accounts].sort()),canonicalJson(published))
}
function lastPublication(db:LedgerDatabase,prefix:string,consumer:string,accountScope:string|undefined){
 const rows=db.prepare("SELECT scope_json,payload_json FROM processing_publications WHERE prefix=? ORDER BY EXISTS(SELECT 1 FROM json_each(payload_json,'$.sources') WHERE json_extract(value,'$.type')='im') DESC,rowid DESC").all(prefix)
 const savedAccounts=new Set(rows.flatMap(row=>JSON.parse(String(row.scope_json)) as string[]))
 for(const row of rows){
  const accounts=JSON.parse(String(row.scope_json)) as string[]
  // Offline history is unambiguous only for one saved account; explicit account switches remain fenced.
  if(accounts.length&&(accountScope===undefined?savedAccounts.size!==1:accounts.some(account=>account!==accountScope)))continue
  const saved=JSON.parse(String(row.payload_json)) as {draft:z.infer<typeof profileDraftSchema>;projects:unknown[];suggestions:unknown[];generation_version:string|null;generated_at:string|null;sources:{id:string;version:string;label:string;observed_at:string;type:string}[]}
  const sources=saved.sources.map(item=>{const record=effectiveEvidence(db,item.id,{purpose:'extraction',provider:consumer});return {...item,available:!!record&&record.hash===item.version}})
  return {...saved,sources,read_only:true as const,unavailable_sources:sources.filter(source=>!source.available).length}
 }
 return null
}

function joinAbout(parts:z.infer<typeof profileDraftSchema>['about'][]){
 const selected:NonNullable<z.infer<typeof profileDraftSchema>['about']>[]=[];let length=0
 for(const part of parts){if(!part||length+part.text.length+2>2600)continue;selected.push(part);length+=part.text.length+2}
 return selected.length?{text:selected.map(p=>p.text).join('\n\n'),refs:[...new Map(selected.flatMap(p=>p.refs).map(ref=>[ref.entry_id,ref])).values()].slice(0,64)}:null
}
function source(db:LedgerDatabase,prefix:string,provider:string,evidenceId:string,recipe:string,participants=false):{record:EvidenceRecord;stamp:string}|null{
 const record=effectiveEvidence(db,evidenceId,{purpose:'extraction',provider})
 if(!record?.raw_text||!record.id.startsWith(prefix)||!record.source_id.startsWith(prefix)||!['file','mail','im','conversation','user_correction'].includes(record.source_kind))return null
 if(record.source_kind==='user_correction'&&!db.prepare("SELECT 1 FROM memory_revisions r,json_each(r.payload_json,'$.evidence_refs') refs WHERE refs.value=? AND r.revision=(SELECT max(v.revision) FROM memory_revisions v WHERE v.entry_id=r.entry_id) AND json_extract(r.payload_json,'$.op')<>'tombstone' AND json_extract(r.payload_json,'$.kind') NOT IN ('todo','idea','goal','profile') LIMIT 1").get(record.id))return null
 // Content-addressed message versions retain history; only their current head is eligible.
 if(['mail','im'].includes(record.source_kind)){
  const head=db.prepare('SELECT evidence_id FROM memory_message_heads WHERE key=?').get(sha256(canonicalJson([record.source_id,record.locator])))
  if(head?.evidence_id!==undefined&&head.evidence_id!==record.id)return null
  if(!head&&db.prepare("SELECT 1 FROM memory_evidence WHERE source_id=? AND json_extract(payload_json,'$.locator')=? AND rowid>(SELECT rowid FROM memory_evidence WHERE id=?) LIMIT 1").get(record.source_id,record.locator,record.id))return null
  const m=record.source_metadata
  if(!m||(record.source_kind==='im'?m.sender_id!==m.recipient_id&&m.mention!=='direct'&&!participants:m.sender_id!==m.account_id))return null
 }
 const grant=processingStamp(db,[record.id],'extraction',provider)
 const headRevision=db.prepare('SELECT revision FROM processing_heads WHERE key=?').get(sha256(canonicalJson([record.source_id,record.locator])))?.revision??0
 const project=db.prepare("SELECT value FROM processing_decisions WHERE prefix=? AND kind='git' AND id=?").get(prefix,evidenceId)?.value??null
 return grant?{record,stamp:sha256(canonicalJson({record,grant,headRevision,recipe,project,algorithm:SOURCE_PROCESSING_VERSION}))}:null
}
function readRefs(db:LedgerDatabase,prefix:string,provider:string,refs:ProcessingRef[],recipe:string,participants=false){
 const items=[]
 for(const ref of refs){const current=source(db,prefix,provider,ref.evidence_id,recipe,participants)
  if(current?.stamp!==ref.stamp||ref.end>current.record.raw_text!.length)return null
  items.push({...ref,source_key:sha256(canonicalJson([current.record.source_id,current.record.locator])),text:current.record.raw_text!.slice(ref.start,ref.end),version:current.record.hash,source_kind:current.record.source_kind,observed_at:current.record.observed_at,source_metadata:current.record.source_metadata??null,locator:current.record.locator})
 }
 return {items}
}
function saveBatch(db:LedgerDatabase,batch:ProcessingBatch){db.prepare('INSERT INTO processing_batches VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json').run(batch.id,batch.prefix,batch.provider,batch.status,canonicalJson(batch))}
function saveState(db:LedgerDatabase,prefix:string,provider:string,state:z.infer<typeof stateSchema>){db.prepare('INSERT INTO processing_state VALUES(?,?,?) ON CONFLICT(prefix,provider) DO UPDATE SET payload_json=excluded.payload_json').run(prefix,provider,canonicalJson(state))}

/** Runs exclusively inside the memory worker transaction. No timers or model calls. */
export function sourceProcessingOperation(db:LedgerDatabase,input:unknown):unknown{
 const fields=z.record(z.string(),z.unknown()).parse(input),{prefix,provider:consumer,recipe,participants}=base.parse(fields)
 const provider=sha256(canonicalJson({consumer,recipe,participants,algorithm:SOURCE_PROCESSING_VERSION}))
 const {prefix:ignoredPrefix,provider:ignoredProvider,recipe:ignoredRecipe,participants:ignoredParticipants,...request}=fields
 void ignoredPrefix;void ignoredProvider;void ignoredRecipe;void ignoredParticipants
 const q=processingRequestSchema.parse(request)
 const decision=(kind:string,key:string,value:string)=>db.prepare('INSERT INTO processing_decisions VALUES(?,?,?,?) ON CONFLICT(prefix,kind,id) DO UPDATE SET value=excluded.value').run(prefix,kind,key,value)
 const priorRecipe=db.prepare("SELECT value FROM processing_decisions WHERE prefix=? AND kind='policy' AND id='active_recipe'").get(prefix)
 if(priorRecipe?priorRecipe.value!==provider:!!db.prepare('SELECT 1 FROM processing_profiles WHERE prefix=? AND provider<>? LIMIT 1').get(prefix,provider))decision('policy','cleanup','pending')
 decision('policy','active_recipe',provider)
 const priorPolicy=db.prepare("SELECT value FROM processing_decisions WHERE prefix=? AND kind='policy' AND id='participants'").get(prefix)
 if(priorPolicy?.value==='true'&&!participants){
  decision('policy','cleanup','pending')
  db.prepare('DELETE FROM processing_profiles WHERE prefix=?').run(prefix)
  db.prepare('DELETE FROM processing_observations WHERE prefix=?').run(prefix)
 }
 decision('policy','participants',String(participants))
 if(q.action==='project_state'){
  for(const id of q.ids){if(!source(db,prefix,consumer,id,recipe,participants))continue;const prior=db.prepare("SELECT value FROM processing_decisions WHERE prefix=? AND kind='git' AND id=?").get(prefix,id);if(prior?.value===q.fingerprint)continue;decision('git',id,q.fingerprint);db.prepare('INSERT INTO processing_events(prefix,evidence_id) VALUES(?,?)').run(prefix,id)}
  return {ok:true}
 }
 if(q.action==='confirm_cleanup'){decision('policy','cleanup','done');return {ok:true}}

 const saved=db.prepare('SELECT payload_json FROM processing_state WHERE prefix=? AND provider=?').get(prefix,provider)
 let state=saved?stateSchema.parse(JSON.parse(String(saved.payload_json))):{cursor:{seq:0,offset:0},completed_batches:0,processed_chars:0,last_success:null}
 const correctionVersion=()=>sha256(canonicalJson(db.prepare("SELECT id,value FROM processing_decisions WHERE prefix=? AND kind='project' ORDER BY id").all(prefix)))
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
  return {...state,recipe:provider,active_batch:blocking,reconciliation_required:!!blocking&&blocking.provider!==provider,pending_changes:Number(row.count),high_watermark:Number(row.high??state.cursor.seq)}
 }
 if(q.action==='claim'){
  const existing=active();if(existing)return existing
  if(db.prepare("SELECT 1 FROM processing_decisions WHERE prefix=? AND kind='refresh' AND id=? AND value='pending'").get(prefix,provider)){
   db.prepare('DELETE FROM processing_receipts WHERE prefix=? AND provider=?').run(prefix,provider);db.prepare('DELETE FROM processing_state WHERE prefix=? AND provider=?').run(prefix,provider)
   state={cursor:{seq:0,offset:0},completed_batches:0,processed_chars:0,last_success:null};decision('refresh',provider,'done');decision('warmup',provider,'pending')
  }
  if(db.prepare("SELECT 1 FROM processing_batches WHERE prefix=? AND status IN ('claimed','bound')").get(prefix))throw Error('STORE_OPERATION_CONFLICT')
  // A first/explicit refresh starts with recent authorized statements. Its cursor stays
  // put: ordinary receipts then deduplicate these slices without skipping older files.
  if(!db.prepare("SELECT 1 FROM processing_decisions WHERE prefix=? AND kind='warmup' AND id=? AND value='done'").get(prefix,provider)){
   const rows=db.prepare("SELECT id FROM memory_evidence WHERE substr(source_id,1,?)=? AND json_extract(payload_json,'$.source_kind') IN ('conversation','user_correction','im','mail') ORDER BY json_extract(payload_json,'$.observed_at') DESC,id DESC LIMIT 64").all(prefix.length,prefix)
   const items:ProcessingRef[]=[];let size=0
   for(const row of rows){const current=source(db,prefix,consumer,String(row.id),recipe,participants);if(!current)continue;const end=Math.min(4000,current.record.raw_text!.length),ref={evidence_id:current.record.id,stamp:current.stamp,start:0,end};if(!end||db.prepare('SELECT 1 FROM processing_receipts WHERE prefix=? AND provider=? AND ref_key=?').get(prefix,provider,sha256(canonicalJson(ref))))continue;if(items.length>=8||size+end>16000)break;items.push(ref);size+=end}
   if(items.length){const batch:ProcessingBatch={priority:true,correction_version:correctionVersion(),id:randomUUID(),prefix,provider,items,end:{...state.cursor},status:'claimed',task_id:null,run_id:null,created_at:new Date().toISOString(),result_hash:null};saveBatch(db,batch);return batch}
   decision('warmup',provider,'done')
  }
  // A generation-rule change is work even when the source event queue is empty.
  // Keep observation receipts; one authorized seed batch rehydrates the whole selection.
  const stored=db.prepare('SELECT payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider),cached=stored?profileCacheSchema.parse(JSON.parse(String(stored.payload_json))):null
  if(cached?.synthesis_key&&cached.generation_version!==PROFILE_GENERATION_VERSION){
   const items:ProcessingRef[]=[];let chars=0
   for(const ref of cached.refs){if(!readRefs(db,prefix,consumer,[ref],recipe,participants))continue;if(items.length>=8||chars+ref.end-ref.start>16000)break;items.push(ref);chars+=ref.end-ref.start}
   if(items.length){const batch:ProcessingBatch={profile_only:true,correction_version:correctionVersion(),id:randomUUID(),prefix,provider,items,end:{...state.cursor},status:'claimed',task_id:null,run_id:null,created_at:new Date().toISOString(),result_hash:null};saveBatch(db,batch);return batch}
  }
  const events=db.prepare('SELECT seq,evidence_id FROM processing_events WHERE prefix=? AND seq>=? ORDER BY seq LIMIT 200').all(prefix,state.cursor.seq+Number(state.cursor.offset===0))
  if(!events.length)return null
  const end={...state.cursor},items:ProcessingRef[]=[],seen=new Set<string>();let chars=0
  for(const event of events){
   const seq=Number(event.seq),current=source(db,prefix,consumer,String(event.evidence_id),recipe,participants)
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
  const batch:ProcessingBatch={correction_version:correctionVersion(),id:randomUUID(),prefix,provider,items,end,status:'claimed',task_id:null,run_id:null,created_at:new Date().toISOString(),result_hash:null}
  saveBatch(db,batch);return batch
 }
 const track=(batchId:string,refs:ProcessingRef[])=>{for(const ref of refs)db.prepare('INSERT INTO processing_reads(batch_id,ref_key,payload_json) VALUES(?,?,?) ON CONFLICT(batch_id,ref_key) DO UPDATE SET payload_json=excluded.payload_json').run(batchId,sha256(canonicalJson(ref)),canonicalJson(ref))}
 if(q.action==='topics'){
  const rows=db.prepare("SELECT seq,payload_json FROM processing_topics WHERE prefix=? AND provider=? AND seq>? AND (?='' OR instr(lower(json_extract(payload_json,'$.title')||' '||json_extract(payload_json,'$.summary')),lower(?))>0) ORDER BY seq LIMIT ?").all(prefix,provider,q.after,q.query,q.query,q.limit+1)
  const page=rows.slice(0,q.limit)
  return {items:page.flatMap(row=>{const topic=processingTopicSchema.parse(JSON.parse(String(row.payload_json)));if(!readRefs(db,prefix,consumer,topic.refs,recipe,participants))return [];if(q.batch_id)track(q.batch_id,topic.refs);return [{id:Number(row.seq),...topic}]}),next:rows.length>q.limit?Number(page.at(-1)!.seq):null}
 }
 if(q.action==='dismiss'||q.action==='correct_project'){
  const kind=q.action==='dismiss'?'dismiss':'project',value=q.action==='dismiss'?'dismissed':q.value
  db.prepare('INSERT INTO processing_decisions VALUES(?,?,?,?) ON CONFLICT(prefix,kind,id) DO UPDATE SET value=excluded.value').run(prefix,kind,q.id,value)
  return {ok:true}
 }
 if(q.action==='refresh'){
  decision('refresh',provider,'pending')
  return {queued:true}
 }
 if(q.action==='profile'||q.action==='products'){
  const saved=db.prepare('SELECT revision,payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider)
  if(!saved&&q.action==='profile')return {revision:0,draft:null}
  const content=profileCacheSchema.parse(saved?JSON.parse(String(saved.payload_json)):{draft:{about:null,work:[],interests:[]},refs:[]})
  const valid=(fact:{refs:{entry_id:string;version:unknown}[]})=>fact.refs.every(ref=>{
   const refs=content.refs.filter(item=>item.evidence_id===ref.entry_id)
   return refs.length>0&&readRefs(db,prefix,consumer,refs,recipe,participants)!==null
  })
  const invalidInterests=content.draft.interests.filter(fact=>!valid(fact))
  if(invalidInterests.length){
   const invalidKey=sha256(canonicalJson({invalidInterests,refs:content.refs}))
   if(db.prepare("SELECT value FROM processing_decisions WHERE prefix=? AND kind='policy' AND id='invalid_interests'").get(prefix)?.value!==invalidKey){decision('policy','cleanup','pending');decision('policy','invalid_interests',invalidKey)}
  }
  if(q.action==='profile'&&q.batch_id)track(q.batch_id,content.refs.filter(ref=>readRefs(db,prefix,consumer,[ref],recipe,participants)!==null))
  const draft={...content.draft,about:content.about_parts?joinAbout(content.about_parts.filter(valid)):content.draft.about&&valid(content.draft.about)?content.draft.about:null,work:content.draft.work.filter(valid),interests:content.draft.interests.filter(valid)}
  const result={revision:Number(saved?.revision??0),draft:draft.about||draft.work.length||draft.interests.length?draft:null}
  if(q.action==='profile')return result
  const decisions=db.prepare('SELECT kind,id,value FROM processing_decisions WHERE prefix=?').all(prefix)
  const corrections=Object.fromEntries(decisions.filter(row=>row.kind==='project').map(row=>[String(row.id),String(row.value)]))
  const dismissed=new Set(decisions.filter(row=>row.kind==='dismiss').map(row=>row.id))
  const projects=(content.products?.projects??[]).filter(valid).map(project=>({...project,...(corrections[project.id]==='reference'?{relation:'reference' as const}:corrections[project.id]==='historical'?{status:'historical' as const}:corrections[project.id]==='participating'?{relation:'participating' as const,status:'current' as const}:{})}))
  const changedProjects=(content.products?.projects??[]).filter(p=>corrections[p.id]&&corrections[p.id]!=='automatic'&&canonicalJson(projects.find(current=>current.id===p.id))!==canonicalJson(p)),changedIds=new Set(changedProjects.flatMap(p=>p.refs.map(r=>r.entry_id)))
  const unchanged=(fact:{refs:{entry_id:string}[]})=>!fact.refs.some(r=>changedIds.has(r.entry_id))
  if(result.draft){result.draft={...result.draft,about:result.draft.about&&unchanged(result.draft.about)?result.draft.about:null,work:result.draft.work.filter(unchanged),interests:result.draft.interests.filter(unchanged)}}
  const suggestions=(content.products?.suggestions??[]).filter(item=>valid(item)&&(q.include_dismissed===true||!dismissed.has(item.id))&&(!item.project_id||projects.some(project=>project.id===item.project_id&&project.relation==='participating'&&project.status==='current')))
  const originals=content.refs.flatMap(ref=>readRefs(db,prefix,consumer,[ref],recipe,participants)?.items??[])
  const profile_needs_update=!result.draft&&!!db.prepare("SELECT 1 FROM processing_profiles WHERE prefix=? AND provider<>? AND (json_type(payload_json,'$.draft.about')='object' OR json_array_length(payload_json,'$.draft.work')>0 OR json_array_length(payload_json,'$.draft.interests')>0) LIMIT 1").get(prefix,provider)
  return {...result,projects,suggestions,corrections,...(q.presentation?{last_success:lastPublication(db,prefix,consumer,q.account_scope)}:{}),profile_needs_update,profile_pending:content.profile_pending===true,news_cleanup_pending:decisions.some(row=>row.kind==='policy'&&row.id==='cleanup'&&row.value==='pending'),generated_at:content.generated_at??null,sources:[...new Map(originals.map(item=>[item.evidence_id,{id:item.evidence_id,version:item.version,label:item.locator,observed_at:item.observed_at,type:item.source_kind==='user_correction'?'conversation':item.source_kind==='task_result'?'task':item.source_kind,...(item.source_metadata?.provider?{provider:item.source_metadata.provider.slice(0,80)}:{}),...(item.source_metadata?.source_url?{url:item.source_metadata.source_url}:{})}])).values()]}

 }
 const row=db.prepare('SELECT payload_json FROM processing_batches WHERE id=? AND prefix=? AND provider=?').get(q.batch_id,prefix,provider)
 if(!row)throw Error('STORE_NOT_FOUND')
 const batch=batchSchema.parse(JSON.parse(String(row.payload_json)))
 const read=(refs:ProcessingRef[])=>{
  const result=readRefs(db,prefix,consumer,refs,recipe,participants)
  if(result)track(batch.id,refs)
  return result
 }
 const profileContext=()=>{
  const rows=db.prepare(`WITH ranked AS (
   SELECT payload_json,row_number() OVER(PARTITION BY json_extract(payload_json,'$.kind') ORDER BY rowid) n,
   count(*) OVER(PARTITION BY json_extract(payload_json,'$.kind')) total FROM processing_observations WHERE prefix=? AND provider=?
  ) SELECT payload_json FROM ranked WHERE n=1 OR n=total OR (n-1)%max(1,CAST((total+127)/128 AS INTEGER))=0`).all(prefix,provider)
  const available=rows.flatMap(row=>{const observation=processingObservationSchema.parse(JSON.parse(String(row.payload_json))),originals=readRefs(db,prefix,consumer,observation.refs,recipe,participants);return originals?[{observation,originals,at:originals.items.map(i=>i.observed_at).sort()[0]??''}]:[]}).sort((a,b)=>a.at.localeCompare(b.at)||canonicalJson(a.observation).localeCompare(canonicalJson(b.observation)))
  // Every prefix samples the entire history, with separate lanes for relationships,
  // recurring work and working style. A high-volume recent topic cannot take all slots.
  const spread=(n:number,count:number)=>{let value=0;for(let width=1;width<count;width*=2){value=value*2+n%2;n=Math.floor(n/2)}return value}
  const lanes=(['people','style','work'] as const).map(kind=>{const lane=available.filter(item=>item.observation.kind===kind);return lane.map((item,index)=>({item,order:spread(index,lane.length)})).sort((a,b)=>a.order-b.order).map(row=>row.item)})
  const refs:ProcessingRef[]=[],observations:ProcessingObservation[]=[],items:NonNullable<ReturnType<typeof readRefs>>['items']=[],chosen=new Set<string>(),texts=new Set<string>();let chars=0
  for(let round=0;round<Math.max(0,...lanes.map(lane=>lane.length));round++)for(const lane of lanes){
   const item=lane[round];if(!item)continue
   const textKey=item.observation.kind+':'+item.observation.text.normalize('NFKC').replace(/\s+/gu,' ')
   if(texts.has(textKey))continue
   const additions=item.originals.items.filter(i=>!chosen.has(canonicalJson({evidence_id:i.evidence_id,stamp:i.stamp,start:i.start,end:i.end})))
   if(refs.length+additions.length>120||chars+additions.reduce((n,i)=>n+i.text.length,0)>48000)continue
   for(const original of additions){const ref={evidence_id:original.evidence_id,stamp:original.stamp,start:original.start,end:original.end};refs.push(ref);items.push(original);chosen.add(canonicalJson(ref));chars+=original.text.length}
   observations.push(item.observation);texts.add(textKey)
  }
  const key=sha256(canonicalJson({provider,generation_version:PROFILE_GENERATION_VERSION,corrections:correctionVersion(),observations,refs}))
  const current=new Set(batch.items.map(ref=>canonicalJson(ref)))
  const pending=batch.priority?db.prepare("SELECT id FROM memory_evidence WHERE substr(source_id,1,?)=? AND json_extract(payload_json,'$.source_kind') IN ('conversation','user_correction','im','mail') ORDER BY json_extract(payload_json,'$.observed_at') DESC,id DESC LIMIT 64").all(prefix.length,prefix).some(row=>{
   const value=source(db,prefix,consumer,String(row.id),recipe,participants);if(!value)return false
   const ref={evidence_id:value.record.id,stamp:value.stamp,start:0,end:Math.min(4000,value.record.raw_text!.length)}
   return ref.end>0&&!current.has(canonicalJson(ref))&&!db.prepare('SELECT 1 FROM processing_receipts WHERE prefix=? AND provider=? AND ref_key=?').get(prefix,provider,sha256(canonicalJson(ref)))
  }):false
  const prior=db.prepare('SELECT payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider),cached=prior?profileCacheSchema.parse(JSON.parse(String(prior.payload_json))):null
  return {refs,items,observations,key,ready:!pending,unchanged:cached?.generation_version===PROFILE_GENERATION_VERSION&&cached.synthesis_key===key}

 }
 if(q.action==='observe'){
  if(batch.status!=='bound'||!read(q.refs))throw Error('STORE_STALE_REVISION')
  const supplied=new Set(q.refs.map(ref=>canonicalJson(ref)))
  if(batch.items.some(ref=>!supplied.has(canonicalJson(ref))))throw Error('STORE_INVALID_OPERATION')
  if(q.observations.some(observation=>observation.refs.some(ref=>!supplied.has(canonicalJson(ref)))))throw Error('STORE_INVALID_OPERATION')
  // Re-observing a slice replaces even an empty result, rather than retaining a stale inference.
  for(const row of db.prepare('SELECT key,payload_json FROM processing_observations WHERE prefix=? AND provider=?').all(prefix,provider)){
   const prior=processingObservationSchema.parse(JSON.parse(String(row.payload_json)))
   if(prior.refs.some(ref=>q.refs.some(next=>next.evidence_id===ref.evidence_id&&next.start<ref.end&&ref.start<next.end)))db.prepare('DELETE FROM processing_observations WHERE prefix=? AND provider=? AND key=?').run(prefix,provider,String(row.key))
  }
  for(const observation of q.observations){const payload=canonicalJson(observation);db.prepare('INSERT OR REPLACE INTO processing_observations VALUES(?,?,?,?)').run(prefix,provider,sha256(payload),payload)}
  decision('observed',batch.id,'done')
  return {applied:true}
 }
 if(q.action==='profile_context'){
  if(batch.status!=='bound')throw Error('STORE_INVALID_OPERATION')
  const context=profileContext();track(batch.id,context.refs);return context
 }
 if(q.action==='batch'){const reads=db.prepare('SELECT payload_json FROM processing_reads WHERE batch_id=?').all(batch.id);return {batch,published:!!db.prepare("SELECT 1 FROM processing_decisions WHERE prefix=? AND kind='published' AND id=? AND value='done'").get(prefix,batch.id),observed:!!db.prepare("SELECT 1 FROM processing_decisions WHERE prefix=? AND kind='observed' AND id=? AND value='done'").get(prefix,batch.id),valid:(!batch.correction_version||batch.correction_version===correctionVersion())&&readRefs(db,prefix,consumer,batch.items,recipe,participants)!==null&&reads.every(row=>row.payload_json&&readRefs(db,prefix,consumer,[processingRefSchema.parse(JSON.parse(String(row.payload_json)))],recipe,participants)!==null)}}
 if(q.action==='read')return ['claimed','bound'].includes(batch.status)?read(batch.items):null
 if(q.action==='bind'){
  if(batch.task_id===q.task_id&&batch.run_id===q.run_id)return batch
  if(batch.task_id||batch.status!=='claimed')throw Error('STORE_IDEMPOTENCY_CONFLICT')
  batch.task_id=q.task_id;batch.run_id=q.run_id;batch.status='bound';saveBatch(db,batch);return batch
 }
 if(batch.task_id!==q.task_id||batch.run_id!==q.run_id)throw Error('STORE_IDEMPOTENCY_CONFLICT')
 if(q.action==='identities'){
  if(!['bound','completed'].includes(batch.status))throw Error('STORE_INVALID_OPERATION');const current=read(q.refs);if(!current)throw Error('STORE_STALE_REVISION')
  const keys=new Set(current.items.map(item=>item.source_key)),items=db.prepare('SELECT source_key,payload_json FROM processing_identities WHERE prefix=? ORDER BY rowid DESC LIMIT 1000').all(prefix).filter(row=>keys.has(String(row.source_key))).map(row=>storedIdentitySchema.parse(JSON.parse(String(row.payload_json))))
  return {items:items.slice(0,64)}
 }
 if(q.action==='evidence'){
  if(!['bound','completed'].includes(batch.status))throw Error('STORE_INVALID_OPERATION')
  return read(q.refs)
 }
 if(q.action==='publish'){
  if(batch.correction_version&&batch.correction_version!==correctionVersion())throw Error('STORE_STALE_REVISION')
  if(!['bound','completed'].includes(batch.status))throw Error('STORE_INVALID_OPERATION')
  const saved=db.prepare('SELECT revision,payload_json FROM processing_profiles WHERE prefix=? AND provider=?').get(prefix,provider)
  const revision=Number(saved?.revision??0),publicationKey=sha256(canonicalJson(q)),old=saved?profileCacheSchema.parse(JSON.parse(String(saved.payload_json))):null
  if(revision===q.expected_revision+1&&old?.publication_key===publicationKey){decision('published',batch.id,'done');return {applied:true,revision}}
  if(revision!==q.expected_revision)throw Error('STORE_STALE_REVISION')
  if(q.profile_context_key){const context=profileContext();if(context.key!==q.profile_context_key||!context.ready&&!q.defer_profile)throw Error('STORE_STALE_REVISION')}
  if(q.product_refs?.some(ref=>!q.refs.some(value=>canonicalJson(value)===canonicalJson(ref))))throw Error('STORE_INVALID_OPERATION')
  const originals=readRefs(db,prefix,consumer,q.refs,recipe,participants);if(!originals)return {applied:false,revision}
  if(q.refs.some(ref=>!db.prepare('SELECT 1 FROM processing_reads WHERE batch_id=? AND ref_key=?').get(batch.id,sha256(canonicalJson(ref)))))throw Error('STORE_INVALID_OPERATION')
  const cited=[...(q.products?.projects.flatMap(item=>item.refs)??[]),...(q.products?.suggestions.flatMap(item=>item.refs)??[]),...(q.defer_profile?[]:[...(q.draft.about?.refs??[]),...q.draft.work.flatMap(item=>item.refs),...q.draft.interests.flatMap(item=>item.refs)])]
  // Shared explicit corrections may remove every inferred clause; originals remain authorized above.
  if(cited.some(ref=>!originals.items.some(item=>item.evidence_id===ref.entry_id&&item.version===ref.version)))throw Error('STORE_INVALID_OPERATION')
  // A bounded batch revises only its evidence scope. Keep other currently authorized facts.
  const factKey=(fact:unknown)=>sha256(canonicalJson(fact))
  const authorizedFact=(fact:{refs:{entry_id:string;version:unknown}[]})=>fact.refs.every(ref=>{const refs=(old?.refs??[]).filter((r:ProcessingRef)=>r.evidence_id===ref.entry_id);return refs.length>0&&readRefs(db,prefix,consumer,refs,recipe,participants)!==null})
  const retain=(fact:{refs:{entry_id:string;version:unknown}[]})=>!(old?.fact_scopes?.[factKey(fact)]??(old?.refs??[]).filter((r:ProcessingRef)=>fact.refs.some(ref=>ref.entry_id===r.evidence_id))).some((prior:ProcessingRef)=>(q.product_refs??q.refs).some(next=>next.evidence_id===prior.evidence_id&&next.start<prior.end&&prior.start<next.end))&&authorizedFact(fact)
  const merge=<T>(fresh:T[],prior:T[],key:(item:T)=>string,limit:number)=>[...new Map([...fresh,...prior].map(item=>[key(item),item] as const).reverse()).values()].reverse().slice(0,limit)
  const aboutParts=q.defer_profile?(old?.about_parts??(old?.draft.about?[old.draft.about]:[])).filter(authorizedFact):q.profile_context_key?(q.draft.about?[q.draft.about]:[]):[...(q.draft.about?[q.draft.about]:[]),...(old?.about_parts??(old?.draft.about?[old.draft.about]:[])).filter(retain)].slice(0,6)
  const draft=profileDraftSchema.parse(q.defer_profile?{about:joinAbout(aboutParts),work:(old?.draft.work??[]).filter(authorizedFact),interests:(old?.draft.interests??[]).filter(authorizedFact)}:q.profile_context_key?q.draft:{...q.draft,about:joinAbout(aboutParts),work:merge(q.draft.work,(old?.draft.work??[]).filter(retain),(item)=>item.title,6),interests:merge(q.draft.interests,(old?.draft.interests??[]).filter(retain),(item)=>item.text,8)})
  const products=q.products?understandingProductsSchema.parse({projects:merge(q.products.projects,(old?.products?.projects??[]).filter(retain),(item)=>item.id,24),suggestions:merge(q.products.suggestions,(old?.products?.suggestions??[]).filter(retain),(item)=>item.id,24)}):batch.profile_only&&old?.products?{projects:old.products.projects.filter(authorizedFact),suggestions:old.products.suggestions.filter(authorizedFact)}:undefined
  const facts=[...(draft.about?[draft.about]:[]),...draft.work,...draft.interests,...(products?.projects??[]),...(products?.suggestions??[])],ids=new Set(facts.flatMap(f=>f.refs.map(r=>r.entry_id)))
  const refs=[...new Map([...q.refs,...(old?.refs??[])].filter((r:ProcessingRef)=>ids.has(r.evidence_id)&&readRefs(db,prefix,consumer,[r],recipe,participants)!==null).map((r:ProcessingRef)=>[canonicalJson(r),r])).values()]
  const fact_scopes=Object.fromEntries(facts.map(fact=>[factKey(fact),old?.fact_scopes?.[factKey(fact)]??q.refs.filter(ref=>fact.refs.some(r=>r.entry_id===ref.evidence_id))]));for(const part of aboutParts)fact_scopes[factKey(part)]=old?.fact_scopes?.[factKey(part)]??q.refs.filter(ref=>part.refs.some((r:{entry_id:string})=>r.entry_id===ref.evidence_id))
  const payload=canonicalJson({draft,refs,about_parts:aboutParts,fact_scopes,publication_key:publicationKey,profile_pending:q.defer_profile===true,...(q.profile_context_key&&!q.defer_profile?{synthesis_key:q.profile_context_key,generation_version:PROFILE_GENERATION_VERSION}:{}),...(products?{products,generated_at:batch.profile_only?old?.generated_at:batch.created_at}:{})})
  for(const item of products?.suggestions??[]){const original=readRefs(db,prefix,consumer,refs.filter((ref:ProcessingRef)=>item.refs.some(r=>r.entry_id===ref.evidence_id)),recipe,participants)?.items[0];if(!original)continue;const identity={id:item.id,kind:item.kind,title:item.title,project_id:item.project_id,source_key:original.source_key};db.prepare('INSERT INTO processing_identities VALUES(?,?,?,?,?) ON CONFLICT(prefix,id) DO UPDATE SET evidence_id=excluded.evidence_id,source_key=excluded.source_key,payload_json=excluded.payload_json').run(prefix,item.id,original.evidence_id,original.source_key,canonicalJson(identity))}
  db.prepare('DELETE FROM processing_identities WHERE prefix=? AND rowid NOT IN (SELECT rowid FROM processing_identities WHERE prefix=? ORDER BY rowid DESC LIMIT 1000)').run(prefix,prefix)
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?) ON CONFLICT(prefix,provider) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json').run(prefix,provider,revision+1,payload)
  archivePublication(db,prefix,provider,payload)
  decision('published',batch.id,'done')
  if(batch.profile_only&&q.profile_context_key&&!q.defer_profile)decision('observed',batch.id,'done')
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
 if(!readRefs(db,prefix,consumer,batch.items,recipe,participants)){batch.status='invalidated';saveBatch(db,batch);return {applied:false}}
 for(const topic of q.topics)db.prepare('INSERT INTO processing_topics(prefix,provider,batch_id,payload_json) VALUES(?,?,?,?)').run(prefix,provider,batch.id,canonicalJson(topic))
 for(const ref of batch.items)db.prepare('INSERT OR IGNORE INTO processing_receipts VALUES(?,?,?,?)').run(prefix,provider,sha256(canonicalJson(ref)),ref.evidence_id)
 state.cursor=batch.end;state.completed_batches++;state.processed_chars+=batch.items.reduce((sum,ref)=>sum+ref.end-ref.start,0);state.last_success=new Date().toISOString()
 batch.status='completed';batch.result_hash=resultHash;saveBatch(db,batch);saveState(db,prefix,provider,state)
 return {applied:true}
}
