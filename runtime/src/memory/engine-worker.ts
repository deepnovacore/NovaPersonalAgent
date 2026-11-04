import {existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {parentPort, workerData} from 'node:worker_threads'
import {Memory} from 'mem0ai/oss'
import type {MemoryRecord} from 'voicemem'
import {loadGroundedVoiceMem} from './grounded-voicemem.js'

const {VoiceMem, OpenAITextModel, OpenAIEmbeddingModel} = await loadGroundedVoiceMem()
import {engineSnapshotSchema, type EngineSnapshot} from '../memory-substrate/engine-outbox.js'
import {preparePrivateDatabasePath} from '../storage/private-database.js'
import type {PersonalMemoryRecallHit} from './personal-memory.js'
import type {EngineConfig} from './production-engine.js'

const config = workerData as EngineConfig & {retired?:boolean}
if (!parentPort) throw Error('memory_engine_worker_required')
const port = parentPort
const file = (name: string) => preparePrivateDatabasePath(join(config.path,name))
const lock = new DatabaseSync(file('lock.sqlite'))
lock.exec('PRAGMA busy_timeout=0')
const state = new DatabaseSync(file('state.sqlite'))
state.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS manifest(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lifecycle(slot INTEGER PRIMARY KEY CHECK(slot=1),incarnation INTEGER NOT NULL,retired INTEGER NOT NULL); INSERT OR IGNORE INTO lifecycle VALUES(1,0,0)')
let activeJob=false,authorizationSequence=0
const authorizations=new Map<number,(allowed:boolean)=>void>()
port.on('message',(q:{authorized?:number;allowed?:boolean})=>{if(q.authorized!==undefined){authorizations.get(q.authorized)?.(q.allowed===true);authorizations.delete(q.authorized)}})
async function authorize():Promise<void>{if(!activeJob)return;const id=++authorizationSequence;const allowed=await new Promise<boolean>(resolve=>{authorizations.set(id,resolve);port.postMessage({authorize:id})});if(!allowed)throw Error('memory_engine_stale_job')}
// VoiceMem providers do not retry HTTP; the fetch hook also fences every batch/request.
const transportFetch=globalThis.fetch
const authorizedFetch:typeof fetch=async(input,init)=>{await authorize();return transportFetch(input,init)}
const providerEmbeddings = new OpenAIEmbeddingModel({...config.embedding,fetch:authorizedFetch,timeoutMs:20_000})
const embeddings={model:providerEmbeddings.model,embed:async(texts:readonly string[],signal?:AbortSignal)=>{await authorize();return providerEmbeddings.embed(texts,signal)}}
const providerModel=new OpenAITextModel({...config.extraction,fetch:authorizedFetch,model:config.extractionModel,timeoutMs:20_000})
const voice = config.engine === 'voicemem' ? new VoiceMem({path:file('voicemem.sqlite'),userId:config.userId,embeddings,model:{complete:async(system:string,prompt:string,signal?:AbortSignal)=>{await authorize();return providerModel.complete(system,prompt,signal)}},mode:'text',leftMinScore:0,rbMinScore:0}) : undefined
if(config.engine==='mem0')file('mem0_entities.db')
const mem0 = config.engine === 'mem0' ? new Memory({disableHistory:true,
  // mem0's public embedding-model integration avoids its OpenAI embedder's unfenced internal retries.
  embedder:{provider:'langchain',config:{model:{
    embedQuery:async(text:string)=>Array.from((await embeddings.embed([text],AbortSignal.timeout(20_000)))[0]!),
    embedDocuments:async(texts:string[])=>(await embeddings.embed(texts,AbortSignal.timeout(20_000))).map(vector=>Array.from(vector)),
  },...(config.embedding.dimensions?{embeddingDims:config.embedding.dimensions}:{})}},
  llm:{provider:'openai',config:{baseURL:config.extraction.baseUrl,apiKey:config.extraction.apiKey,model:config.extractionModel,timeout:20_000}},
  vectorStore:{provider:'memory',config:{dbPath:file('mem0.db'),collectionName:'nova_ledger',...(config.embedding.dimensions?{dimension:config.embedding.dimensions}:{})}}}) : undefined
voice?.store.db.exec('PRAGMA secure_delete=ON')
let tail = Promise.resolve()
port.on('message',(q: {id:number;operation:string;input:unknown}) => {
  if(!q.operation)return
  tail = tail.then(async()=>{
    try {
      const result = q.operation === 'sync' ? await sync(engineSnapshotSchema.parse(q.input)) : q.operation === 'recall' ? await recall(q.input as {query:string;limit:number}) : null
      port.postMessage({id:q.id,ok:true,result})
    } catch {port.postMessage({id:q.id,ok:false})}
  })
})
const entryText = (value:unknown):string => {if(typeof value!=='string'||!value.trim())throw Error('memory_engine_invalid_text');return value}
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const incarnation=()=>Number(state.prepare('SELECT incarnation FROM lifecycle WHERE slot=1').get()?.incarnation??0)
const key = (entry:EngineSnapshot['entries'][number]) => hash([incarnation(),entry.entry.entry_id,entry.entry.revision,entry.stamp])
const sourceKey = (source:EngineSnapshot['sources'][number]) => hash([incarnation(),source.evidence.id,source.stamp])

async function sync(snapshot: EngineSnapshot): Promise<null> {
  // Unlike an expiring lease, this OS-released SQLite lock cannot permit overlapping stale SDK writes.
  lock.exec('BEGIN IMMEDIATE')
  activeJob=true
  try {
    await authorize()
    if(!config.retired)state.exec('UPDATE lifecycle SET incarnation=incarnation+retired,retired=0 WHERE slot=1')
    const desired = new Map(snapshot.entries.map(item=>[key(item),item]))
    if (mem0) {
      const existing = await mem0.getAll({filters:{user_id:config.userId},topK:Number.MAX_SAFE_INTEGER,showExpired:true})
      const retained = new Set<string>()
      for (const row of existing.results) {
        const id = String(row.metadata?.nova_key ?? '')
        if (!desired.has(id) || retained.has(id)) await mem0.delete(row.id)
        else retained.add(id)
      }
      for (const [id,item] of desired) if (!retained.has(id)) {await authorize();await mem0.add(entryText(item.entry.content.text),{userId:config.userId,infer:false,metadata:{nova_key:id,nova_id:item.entry.entry_id,nova_revision:item.entry.revision}})}
    }
    if (voice) {
      const wantedSources = new Map(snapshot.sources.map(item=>[sourceKey(item),item]))
      for (const raw of state.prepare('SELECT * FROM manifest').all()) {
        const id = String(raw.id), kind = String(raw.kind)
        if (kind === 'entry' ? !desired.has(id) : !wantedSources.has(id)) {
          await voice.forget({sourceId:id,scope:kind === 'entry' ? 'ledger' : 'styles'})
          state.prepare('DELETE FROM manifest WHERE id=?').run(id)
        }
      }
      for (const [id,item] of desired) {
        const previous=state.prepare('SELECT payload FROM manifest WHERE id=?').get(id)
        if(previous&&!(JSON.parse(String(previous.payload)) as {pending?:boolean}).pending)continue
        state.prepare('INSERT OR REPLACE INTO manifest VALUES(?,?,?)').run(id,'entry',JSON.stringify({...item,pending:true}))
        const text = entryText(item.entry.content.text)
        if (!text.trim()) continue
        const vectors = await embeddings.embed([text],AbortSignal.timeout(20_000))
        const now = new Date().toISOString()
        const source = voice.store.admit({id,userId:config.userId,scope:'ledger',sessionId:'ledger',text,occurredAt:item.entry.recorded_at,recordedAt:now,authority:'explicit',assistantReply:'',role:'user'})
        const record:MemoryRecord = {id,userId:config.userId,scope:'ledger',kind:'fact',text,subject:config.userId,attribute:'',slots:[],entities:[],emotion:'',authority:'explicit',occurredAt:item.entry.recorded_at,recordedAt:now,revision:1,supersededBy:null,evidenceIds:[id],sourceRole:'user'}
        // A crash after commit is recognized by the SDK's durable admission state.
        if (source.state !== 'learned' && !voice.store.commit(source,[{record,vector:vectors[0]!,model:embeddings.model}],[])) throw Error('engine_commit_failed')
        state.prepare('INSERT OR REPLACE INTO manifest VALUES(?,?,?)').run(id,'entry',JSON.stringify(item))
      }
      for (const [id,item] of wantedSources) {
        if (state.prepare('SELECT id FROM manifest WHERE id=?').get(id)) continue
        // Persist provenance before ingestion so an interrupted admission is removable on retry/revoke.
        state.prepare('INSERT OR REPLACE INTO manifest VALUES(?,?,?)').run(id,'source',JSON.stringify({...item,pending:true}))
        await voice.ingest(item.evidence.raw_text!,{sourceId:id,sessionId:'styles',scope:'styles',role:'user',occurredAt:item.evidence.observed_at,signal:AbortSignal.timeout(20_000)})
        state.prepare('UPDATE manifest SET payload=? WHERE id=?').run(JSON.stringify(item),id)
      }
      // Retry interrupted admissions, not just newly discovered sources.
      for (const raw of state.prepare("SELECT * FROM manifest WHERE kind='source'").all()) if ((JSON.parse(String(raw.payload)) as {pending?:boolean}).pending) {
        await voice.resumeIngest(String(raw.id),{scope:'styles',signal:AbortSignal.timeout(20_000)})
        const item = wantedSources.get(String(raw.id))!
        state.prepare('UPDATE manifest SET payload=? WHERE id=?').run(JSON.stringify(item),String(raw.id))
      }
    }
    if(config.retired)state.exec('UPDATE lifecycle SET retired=1 WHERE slot=1')
    // Never acknowledge erasure until freed pages and WAL copies in every owned store are removed.
    compact(state)
    if(voice)compact(voice.store.db)
    for(const name of ['mem0.db','mem0_entities.db'])if(existsSync(join(config.path,name))){const database=new DatabaseSync(file(name));try{compact(database)}finally{database.close()}}
    lock.exec('COMMIT')
    return null
  } catch(error) {lock.exec('ROLLBACK');throw error}finally{activeJob=false}
}

async function recall(q:{query:string;limit:number}) {
  const hits:PersonalMemoryRecallHit[] = [], contextHits:PersonalMemoryRecallHit[] = []
  if (mem0) {
    const result = await mem0.search(q.query,{topK:q.limit,filters:{user_id:config.userId}})
    for (const row of result.results) if (typeof row.metadata?.nova_id === 'string' && typeof row.metadata.nova_revision === 'number') hits.push({memoryId:row.metadata.nova_id,revision:row.metadata.nova_revision,text:'',evidenceIds:[]})
  }
  if (voice) {
    const result = await voice.search(q.query,{scope:'ledger',subject:config.userId,topK:q.limit,recordUsage:false,signal:AbortSignal.timeout(20_000)})
    for (const row of result.hits) {
      const raw = state.prepare("SELECT payload FROM manifest WHERE id=? AND kind='entry'").get(row.id)
      if (!raw) continue
      const item = JSON.parse(String(raw.payload)) as EngineSnapshot['entries'][number]
      hits.push({memoryId:item.entry.entry_id,revision:item.entry.revision,text:'',evidenceIds:[]})
    }
    if (config.styles) {
      const result = await voice.search(q.query,{scope:'styles',subject:config.userId,topK:q.limit,recordUsage:false,signal:AbortSignal.timeout(20_000)})
      for (const row of result.rbHits) {
        if (row.subject !== config.userId || row.sourceRole === 'assistant' || row.supersededBy !== null) continue
        const sources:EngineSnapshot['sources'] = []
        for (const id of row.evidenceIds) {
          const raw = state.prepare("SELECT payload FROM manifest WHERE id=? AND kind='source'").get(id)
          if (raw) sources.push(JSON.parse(String(raw.payload)) as EngineSnapshot['sources'][number])
        }
        if (sources.length !== row.evidenceIds.length || !sources.length || (row.kind === 'trait' && new Set(sources.map(s=>s.evidence.source_id)).size < 3)) continue
        const recorded = Math.min(...sources.map(s=>Date.parse(s.evidence.observed_at)))
        if (recorded+600_000 <= Date.now()) continue
        contextHits.push({memoryId:row.id,kind:row.kind === 'trait' ? 'trait' : 'experience',text:row.kind==='trait'?row.text:'Temporary emotion: '+row.emotion,evidenceIds:sources.map(s=>s.evidence.id),recordedAt:new Date(recorded).toISOString(),expiresAt:new Date(recorded+600_000).toISOString()})
      }
    }
  }
  return {source:'personal',state:hits.length||contextHits.length?'ok':'empty',scope:'any',hits,contextHits,degraded:false}
}

function compact(database:DatabaseSync):void {
  database.exec('PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000')
  for(const vacuum of [true,false]){
    const result=database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if(result&&Number(result.busy)>0)throw Error('memory_engine_compaction_pending')
    if(vacuum)database.exec('VACUUM')
  }
}
