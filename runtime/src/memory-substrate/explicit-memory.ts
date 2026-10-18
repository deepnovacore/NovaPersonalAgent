import {z} from 'zod'
import {createHash} from 'node:crypto'
import {canonicalJson} from '../text/canonical-json.js'
import {explicitMemoryArguments,explicitMemoryLookup,explicitMemoryTurn,type ExplicitMemoryEntry,type ExplicitMemoryReceipt} from '../memory/explicit-memory.js'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {CandidateSchema,EntryRevisionSchema,EvidenceRecordSchema,type EntryRevision,type MemoryOperation} from './store.js'
import {allowsProcessing,processingGrantSchema} from './source-state.js'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const prefixSchema=z.string().startsWith('personal:').endsWith(':').max(100)
const key=z.string().min(1).max(512)
type Run=(op:MemoryOperation,input:unknown)=>unknown
const rows=(run:Run,prefix:string)=>z.array(EntryRevisionSchema).parse(run('list',{include_history:true})).filter(row=>row.entry_id.startsWith(prefix))
const view=(row:EntryRevision):ExplicitMemoryEntry=>({id:row.entry_id,version:row.revision,kind:row.kind,text:typeof row.content.text==='string'?row.content.text.slice(0,500):'',slot:row.content.memory_slot==='preferred_name'||row.content.memory_slot==='reply_style'?row.content.memory_slot:null,status:'active'})

export function initializeExplicitMemory(db:LedgerDatabase):void{
  db.exec(`CREATE TABLE IF NOT EXISTS memory_explicit_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,prefix TEXT NOT NULL,source_id TEXT NOT NULL,source_hash TEXT NOT NULL,versions TEXT NOT NULL,UNIQUE(prefix,source_id));
    CREATE TABLE IF NOT EXISTS memory_explicit_receipts(prefix TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(prefix,request_id));`)
}

export function explicitMemoryOperation(db:LedgerDatabase,operation:'explicit_begin'|'explicit_write'|'explicit_lookup',input:unknown,run:Run):unknown{
  const raw=z.record(z.string(),z.unknown()).parse(input),prefix=prefixSchema.parse(raw.prefix)
  if(operation==='explicit_begin'){
    const turn=explicitMemoryTurn.parse(raw.turn),digest=hash(canonicalJson(turn))
    const existing=db.prepare('SELECT source_hash FROM memory_explicit_turns WHERE prefix=? AND source_id=?').get(prefix,turn.sourceId)
    if(existing){if(existing.source_hash!==digest)throw Error('STORE_IDEMPOTENCY_CONFLICT');return null}
    const versions=Object.fromEntries(rows(run,prefix).filter(row=>row.kind==='fact'||row.kind==='preference').map(row=>[row.entry_id,row.revision]))
    db.prepare('INSERT INTO memory_explicit_turns(prefix,source_id,source_hash,versions) VALUES(?,?,?,?)').run(prefix,turn.sourceId,digest,canonicalJson(versions))
    // Expired turn snapshots fail closed; receipts remain available for admitted operations.
    db.prepare('DELETE FROM memory_explicit_turns WHERE prefix=? AND seq NOT IN (SELECT seq FROM memory_explicit_turns WHERE prefix=? ORDER BY seq DESC LIMIT 256)').run(prefix,prefix)
    return null
  }
  const consumer=key.parse(raw.consumer)
  const authorized=()=>z.array(EntryRevisionSchema).parse(run('conversation_snapshot',{entry_prefix:prefix,consumer}))
  if(operation==='explicit_lookup'){
    const query=explicitMemoryLookup.parse(raw.query)
    if(query.id&&!query.id.startsWith(prefix))throw Error('STORE_INVALID_OPERATION')
    const entries=authorized().filter(row=>(row.kind==='fact'||row.kind==='preference')&&(!query.id||row.entry_id===query.id)&&(!query.slot||row.content.memory_slot===query.slot)&&(!query.cursor||row.entry_id>query.cursor)).sort((a,b)=>a.entry_id<b.entry_id?-1:a.entry_id>b.entry_id?1:0)
    const page:ExplicitMemoryEntry[]=[]
    for(const row of entries.slice(0,20)){
      const entry=view(row)
      if(JSON.stringify({entries:[...page,entry],next_cursor:entry.id}).length>3500)break
      page.push(entry)
    }
    return {entries:page,next_cursor:entries.length>page.length?page.at(-1)!.id:null}
  }
  const turn=explicitMemoryTurn.parse(raw.turn),args=explicitMemoryArguments.parse(raw.arguments),requestId=key.parse(raw.requestId)
  if(!turn.text.includes(args.quote))throw Error('STORE_INVALID_OPERATION')
  const grant=processingGrantSchema.parse(raw.grant)
  if(!grant.conversation_providers?.includes(consumer))throw Error('STORE_INVALID_OPERATION')
  const receiptKey=hash(turn.sourceId+':'+requestId),digest=hash(canonicalJson({turn,args}))
  const receipt=db.prepare('SELECT digest,entry_id,revision FROM memory_explicit_receipts WHERE prefix=? AND request_id=?').get(prefix,receiptKey)
  const result=(id:string,version:number,replayed:boolean):ExplicitMemoryReceipt=>({state:'committed',id,version,replayed,current:(()=>{const row=authorized().find(row=>row.entry_id===id);return row?view(row):null})()})
  if(receipt){if(receipt.digest!==digest)throw Error('STORE_IDEMPOTENCY_CONFLICT');return result(String(receipt.entry_id),Number(receipt.revision),true)}
  const snapshot=db.prepare('SELECT seq,source_hash,versions FROM memory_explicit_turns WHERE prefix=? AND source_id=?').get(prefix,turn.sourceId)
  if(snapshot?.source_hash!==hash(canonicalJson(turn)))throw Error('STORE_STALE_REVISION')
  const versions=z.record(z.string(),z.number().int().positive()).parse(JSON.parse(String(snapshot.versions)))
  const current=rows(run,prefix),slotRoot=prefix+'explicit:slot:'+args.slot
  const inSlot=(id:string)=>id===slotRoot||id.startsWith(slotRoot+':')
  const slot=args.slot?current.find(row=>inSlot(row.entry_id)):undefined
  // Purge fences an ID forever; a fresh turn may create a new generation, an old snapshot may not.
  if(args.slot&&!slot&&Object.keys(versions).some(inSlot))throw Error('STORE_STALE_REVISION')
  const id=args.slot?slot?.entry_id??slotRoot+':'+receiptKey:args.id??prefix+'explicit:'+receiptKey
  if(!id.startsWith(prefix))throw Error('STORE_INVALID_OPERATION')
  const old=current.find(row=>row.entry_id===id)
  if((old?.revision??0)!==(versions[id]??0)||Number(old?.content.explicit_source_seq??0)>Number(snapshot.seq))throw Error('STORE_STALE_REVISION')
  if(args.id&&(!old||!['fact','preference'].includes(old.kind))||args.action==='forget'&&!old)throw Error('STORE_NOT_FOUND')
  if(old&&old.op!=='tombstone'&&!authorized().some(row=>row.entry_id===id)){
    const suppressed=args.action==='set'&&old.evidence_refs.length>0&&old.evidence_refs.every(ref=>{
      const parsed=EvidenceRecordSchema.safeParse(run('evidence',{id:ref}))
      return parsed.success&&parsed.data.source_id.startsWith(prefix+'explicit:')&&allowsProcessing(db,parsed.data.source_id,'conversation',consumer)&&db.prepare('SELECT 1 FROM memory_suppressed WHERE hash=?').get(parsed.data.hash)!==undefined
    })
    if(!suppressed)throw Error('STORE_INVALID_OPERATION')
  }
  if(old&&args.kind&&args.kind!==old.kind)throw Error('STORE_INVALID_OPERATION')
  const evidence=EvidenceRecordSchema.parse(raw.evidence)
  if(!evidence.id.startsWith(prefix)||!evidence.source_id.startsWith(prefix)||evidence.raw_text!==args.quote||evidence.source_kind!=='user_correction'||evidence.trust!=='trusted_user')throw Error('STORE_INVALID_OPERATION')
  const admitted=EvidenceRecordSchema.parse(run('append_evidence',evidence))
  if(admitted.raw_text!==args.quote)throw Error('STORE_INVALID_OPERATION')
  run('source_grant',{source_id:evidence.source_id,expected_revision:0,grant})
  const candidate=CandidateSchema.parse({entry_id:id,expected_revision:versions[id]??0,kind:old?.kind??args.kind,origin:'stated',written_by:'user_correction',evidence_refs:[evidence.id],entity_refs:old?.entity_refs??[],content:{text:args.text??'',...(args.slot?{memory_slot:args.slot}:old?.content.memory_slot?{memory_slot:old.content.memory_slot}:{}),explicit_source_seq:Number(snapshot.seq)},valid_until:null,recorded_at:evidence.recorded_at,...(args.action==='forget'?{op:'tombstone'}:{})})
  const committed=EntryRevisionSchema.parse(run(args.action==='forget'?'forget':'merge',args.action==='forget'?{entry_id:id,candidate}:candidate))
  // shortcut: this turn uses only explicit entries; add selective extraction before retaining its other implicit facts.
  db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES(?)').run(key.parse(raw.automaticHash))
  db.prepare('INSERT INTO memory_explicit_receipts VALUES(?,?,?,?,?)').run(prefix,receiptKey,digest,id,committed.revision)
  return result(id,committed.revision,false)
}
