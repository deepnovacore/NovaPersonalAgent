import {z} from 'zod';
import type {LedgerDatabase} from '../memory-ledger/store.js';
import {canonicalJson} from '../text/canonical-json.js';
import {sha256,readProcessingGrant} from './source-state.js';
import type {MemoryOperation} from './store.js';
const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const spaceSourceInputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('grant'),source_id:id,revision,provider:z.string().min(1).max(256),allow_upload:z.boolean(),allow_processing:z.boolean()}).strict(),
 z.object({kind:z.literal('source_fact'),source_id:id,grant_revision:revision,resource_id:z.string().min(1).max(200),source_version:z.string().min(1).max(100),text:z.string().min(1).max(16000),relation:z.enum(['self','participant','unknown']),occurred_at:z.string().datetime(),fetched_at:z.string().datetime().optional()}).strict(),
 z.object({kind:z.literal('delete_source'),source_id:id}).strict(),
 z.object({kind:z.literal('correction'),key:z.enum(['about','work','interests']),value:z.string().max(4000),provider:z.string().min(1).max(256).optional()}).strict(),
]);
export interface SpaceSourceScope {space:string;sender:string;opId:string}
export function initializeSpaceSources(db:LedgerDatabase){db.exec(`
 CREATE TABLE IF NOT EXISTS space_source_inputs(scope TEXT PRIMARY KEY,prefix TEXT NOT NULL,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS space_source_receipts(scope TEXT NOT NULL,op_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,op_id));
 CREATE TABLE IF NOT EXISTS space_source_corrections(prefix TEXT NOT NULL,provider TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(prefix,provider,key));
 CREATE TABLE IF NOT EXISTS space_source_clock(prefix TEXT PRIMARY KEY,revision INTEGER NOT NULL);`)}
interface Source {revision:number;deleted:boolean;grant:{provider:string;allow_upload:boolean;allow_processing:boolean}|null;active_source:string|null}
type Run=(operation:MemoryOperation,input:unknown)=>unknown;
export function spaceSourceOperation(db:LedgerDatabase,operation:string,input:unknown,run:Run):unknown{
 if(operation==='space_source_snapshot'){
  const q=z.object({prefix:z.string().regex(/^personal:[^:]+:$/),provider:z.string().max(256)}).strict().parse(input);
  return {revision:Number(db.prepare('SELECT revision FROM space_source_clock WHERE prefix=?').get(q.prefix)?.revision??0),corrections:Object.fromEntries(db.prepare('SELECT key,value FROM space_source_corrections WHERE prefix=? AND provider=?').all(q.prefix,q.provider).map(row=>[String(row.key),JSON.parse(String(row.value)) as unknown]))};
 }
 const q=z.object({prefix:z.string().regex(/^personal:[^:]+:$/),space:id,sender:id,op_id:z.string().min(1).max(128),provider:z.string().max(256),consumer:z.string().max(256),input:spaceSourceInputSchema}).strict().parse(input);
 const actor=sha256(canonicalJson([q.prefix,q.space,q.sender])),digest=sha256(canonicalJson(q.input));
 const prior=db.prepare('SELECT hash,result FROM space_source_receipts WHERE scope=? AND op_id=?').get(actor,q.op_id);
 if(prior){if(prior.hash!==digest)throw Error('STORE_IDEMPOTENCY_CONFLICT');return JSON.parse(String(prior.result)) as unknown}
 if(Number(db.prepare('SELECT count(*) n FROM space_source_receipts WHERE scope=?').get(actor)!.n)>=10000)throw Error('STORE_INVALID_OPERATION');
 const value=q.input;let result:Record<string,unknown>;
 if(value.kind==='correction'){
  const correction={value:value.value,event_id:q.op_id,sender:q.sender,...(value.provider?{provider:value.provider}:{})};
  db.prepare('INSERT INTO space_source_corrections VALUES(?,?,?,?) ON CONFLICT(prefix,provider,key) DO UPDATE SET value=excluded.value').run(q.prefix,value.provider??'',value.key,canonicalJson(correction));result={corrected:value.key};
 }else{
  const key=sha256(canonicalJson([actor,value.source_id]));
  const row=db.prepare('SELECT value FROM space_source_inputs WHERE scope=?').get(key);
  const state:Source=row?JSON.parse(String(row.value)) as Source:{revision:0,deleted:false,grant:null,active_source:null};
  if(state.deleted)throw Error('STORE_INVALID_OPERATION');
  if(value.kind==='grant'){
   if(value.revision<=state.revision)throw Error('STORE_STALE_REVISION');
   state.revision=value.revision;state.grant=value;
   if(!value.allow_upload&&state.active_source){run('delete_source',{source_id:state.active_source});state.active_source=null}
   if(value.allow_upload){
    state.active_source??=q.prefix+'space-source:'+key+':'+value.revision;
    const old=readProcessingGrant(db,state.active_source);
    run('source_grant',{source_id:state.active_source,expected_revision:old?.revision??0,grant:{revision:value.revision,scope_revision:0,extraction_provider:value.allow_processing&&value.provider===q.provider?q.consumer:null,embedding_provider:null,conversation_providers:[]}});
   }
   result={source_id:value.source_id,revision:state.revision};
  }else if(value.kind==='delete_source'){
   if(state.active_source)run('delete_source',{source_id:state.active_source});state.deleted=true;state.grant=null;state.active_source=null;result={source_id:value.source_id,deleted:true};
  }else{
   if(!state.grant?.allow_upload||!state.active_source||value.grant_revision!==state.revision)throw Error('STORE_INVALID_OPERATION');
   const occurred=Date.parse(value.occurred_at),access=Date.parse(value.fetched_at??value.occurred_at),now=Date.now();
   if(occurred>now+300000||access>now+300000||access<occurred-300000)throw Error('STORE_INVALID_OPERATION');
   if(access<=now-30*86400000)result={retained:false};else{
    const evidence_id=q.prefix+'e:space:'+sha256(canonicalJson([state.active_source,value.resource_id,value.source_version]));
    run('append_evidence',{id:evidence_id,source_id:state.active_source,source_kind:'im',locator:value.resource_id,observed_at:value.occurred_at,recorded_at:new Date().toISOString(),raw_text:value.text,hash:sha256(canonicalJson([value.resource_id,value.source_version,value.text])),retention_until:new Date(access+30*86400000).toISOString(),trust:'untrusted_external',source_metadata:{sender_id:value.relation==='self'?'self':'external',recipient_id:'self',account_id:actor,message_id:value.resource_id,chat_id:key}});
    result={evidence_id,retained:true};
   }
  }
  db.prepare('INSERT INTO space_source_inputs VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value').run(key,q.prefix,canonicalJson(state));
 }
 db.prepare('INSERT INTO space_source_clock VALUES(?,1) ON CONFLICT(prefix) DO UPDATE SET revision=revision+1').run(q.prefix);
 db.prepare('INSERT INTO space_source_receipts VALUES(?,?,?,?)').run(actor,q.op_id,digest,canonicalJson(result));return result;
}
