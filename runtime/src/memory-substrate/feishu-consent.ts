import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import type {MemoryOperation} from './store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {processingGrantSchema,type ProcessingGrant} from './source-state.js'

const request=z.object({action:z.literal('feishu_consent'),scope:z.string().regex(/^personal:[^:]+:feishu:$/u),mode:z.enum(['suspend','reconcile','apply','activate']),sources:z.array(z.string().min(1).max(512)).max(10000),grant:processingGrantSchema,pending:z.boolean().default(false)}).strict()
const revoked=(grant:ProcessingGrant):ProcessingGrant=>({...grant,extraction_provider:null,embedding_provider:null,conversation_providers:[]})
const same=(a:ProcessingGrant,b:ProcessingGrant)=>canonicalJson({...a,conversation_providers:[...(a.conversation_providers??[])].sort()})===canonicalJson({...b,conversation_providers:[...(b.conversation_providers??[])].sort()})
const active=(grant:ProcessingGrant)=>grant.extraction_provider!==null||grant.embedding_provider!==null||(grant.conversation_providers??[]).length>0

/** All mutations share the enclosing ledger transaction; the TEMP fence starts closed on every worker open. */
export function feishuConsentOperation(db:LedgerDatabase,input:unknown,run:(operation:MemoryOperation,input:unknown)=>unknown):ProcessingGrant{
 const q=request.parse(input),sources=new Set(q.sources)
 if(q.sources.some(id=>!id.startsWith(q.scope)||id===q.scope))throw Error('STORE_INVALID_OPERATION')
 if(q.mode==='suspend'){db.prepare('DELETE FROM source_session_consents WHERE scope=?').run(q.scope);return q.grant}
 const rows=db.prepare('SELECT source_id,payload_json FROM source_grants WHERE substr(source_id,1,length(?))=?').all(q.scope,q.scope)
 const existing=new Map(rows.map(row=>[String(row.source_id),processingGrantSchema.parse(JSON.parse(String(row.payload_json)))]))
 // syncChat records a selected source before fetching; an empty chat has neither a grant nor evidence.
 const consistent=[...sources].every(id=>{const grant=existing.get(id);return grant?same(grant,q.grant):!active(q.grant)||!db.prepare('SELECT 1 FROM memory_evidence WHERE source_id=? LIMIT 1').get(id)})&&[...existing].every(([id,grant])=>sources.has(id)||!active(grant))
 if(q.mode==='activate'){
  if(!consistent||q.pending)throw Error('STORE_STALE_REVISION')
  db.prepare('INSERT INTO source_session_consents VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload_json=excluded.payload_json').run(q.scope,canonicalJson(q.grant))
  // A scheduler may have scanned while startup admission was closed. Replay grant events without changing consent.
  db.prepare('UPDATE source_grants SET payload_json=payload_json WHERE substr(source_id,1,length(?))=?').run(q.scope,q.scope)
  return q.grant
 }
 db.prepare('DELETE FROM source_session_consents WHERE scope=?').run(q.scope)
 if(q.mode==='reconcile'&&!q.pending&&consistent)return q.grant
 let maximum=0;for(const grant of existing.values())maximum=Math.max(maximum,grant.revision)
 const revision=q.mode==='reconcile'?Math.max(q.grant.revision,maximum)+1:Math.max(q.grant.revision,maximum+1)
 const grant=processingGrantSchema.parse({...q.grant,revision,...(q.mode==='reconcile'?{extraction_provider:null,embedding_provider:null,conversation_providers:[]}: {})})
 for(const id of new Set([...existing.keys(),...sources]))run('source_grant',{source_id:id,expected_revision:existing.get(id)?.revision??0,grant:sources.has(id)?grant:revoked(grant)})
 return grant
}
