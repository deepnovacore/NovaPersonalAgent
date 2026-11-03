import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {z} from 'zod'
import type {MemoryLedgerClient} from '../memory-ledger/store-client.js'
import {engineSnapshotSchema} from '../memory-substrate/engine-outbox.js'
import type {PersonalMemoryEmbeddingConfig} from '../voicemem/store-client.js'
import type {MemoryRecallEngine} from './ledger-recall-engine.js'
import type {PersonalMemoryRecallResult} from './personal-memory.js'

export interface EngineConfig {
  readonly engine:'mem0'|'voicemem'
  readonly styles:boolean
  readonly path:string
  readonly userId:string
  readonly embedding:PersonalMemoryEmbeddingConfig
  readonly extraction:{baseUrl:string;apiKey:string}
  readonly extractionModel:string
}

/** SDK code and SQLite handles have a bounded lifetime, including SDK calls without AbortSignal. */
export class ProductionMemoryEngine implements MemoryRecallEngine {
  readonly recallEngine:'mem0'|'voicemem'
  readonly key:string
  #worker:Worker|undefined
  #sequence=0
  #pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  #sync:Promise<void>|undefined
  #timer:ReturnType<typeof setInterval>|undefined
  #closed=false
  #ticket:{scope:string;engine:string;owner:string;generation:number;cleanup:boolean}|undefined
  lastIndexError:string|null=null
  constructor(readonly config:EngineConfig,private readonly client:MemoryLedgerClient,readonly prefix:string,private readonly embeddingFingerprint:string,private readonly extractionFingerprint:string,private readonly retiredKey?:string) {
    this.recallEngine=config.engine
    this.key=retiredKey??createHash('sha256').update(JSON.stringify([config.path,config.engine,config.styles,config.embedding.baseUrl,config.embedding.model,config.embedding.dimensions,config.extraction.baseUrl,config.extractionModel])).digest('hex')
  }
  async open():Promise<void> {
    this.#closed=false
    this.lastIndexError='memory_engine_index_pending'
    if(!this.retiredKey)await this.client.memory('engine_outbox',{action:'register',scope:this.prefix,engine:this.key,descriptor:{engine:this.config.engine,path:this.config.path,userId:this.config.userId,...(this.config.embedding.dimensions?{dimensions:this.config.embedding.dimensions}:{})}})
    this.#start()
    this.#timer=setInterval(()=>{void this.flush().catch(()=>{/* Durable outbox retains the job; status is exposed in lastIndexError. */})},1000)
    this.#timer.unref()
  }
  #start():Worker {
    if(this.#closed)throw Error('memory_engine_closed')
    if(this.#worker)return this.#worker
    const worker=new Worker(new URL('./engine-worker.js',import.meta.url),{stdout:true,stderr:true,workerData:{...this.config,retired:!!this.retiredKey,path:join(this.config.path,createHash('sha256').update(this.prefix).digest('hex'),this.key)},env:{...process.env,MEM0_TELEMETRY:'false'}})
    worker.stdout.resume();worker.stderr.resume()
    this.#worker=worker
    worker.on('message',(q:{id:number;ok:boolean;result:unknown;authorize?:number})=>{
      if(q.authorize!==undefined){const request=q.authorize;void (this.#ticket?this.client.memory('engine_outbox',{action:'check',...this.#ticket}):Promise.resolve(false)).then(allowed=>{worker.postMessage({authorized:request,allowed})},()=>worker.postMessage({authorized:request,allowed:false}));return}
      const pending=this.#pending.get(q.id);if(!pending)return;this.#pending.delete(q.id);clearTimeout(pending.timer);if(q.ok)pending.resolve(q.result);else pending.reject(Error('memory_engine_operation_failed'))})
    worker.on('error',()=>this.#fail(worker))
    worker.on('exit',()=>this.#fail(worker))
    return worker
  }
  #fail(worker:Worker):void {
    if(this.#worker!==worker)return
    this.#worker=undefined
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(Error('memory_engine_unavailable'))}
    this.#pending.clear()
  }
  async #call(operation:string,input:unknown,signal?:AbortSignal):Promise<unknown> {
    signal?.throwIfAborted()
    const worker=this.#start(),id=++this.#sequence
    const stop=()=>{this.#fail(worker);void worker.terminate()}
    signal?.addEventListener('abort',stop,{once:true})
    try{return await new Promise((resolve,reject)=>{
      const timer=setTimeout(stop,30_000)
      this.#pending.set(id,{resolve,reject,timer})
      worker.postMessage({id,operation,input})
    })}finally{signal?.removeEventListener('abort',stop)}
  }
  flush():Promise<void> {
    if(this.#sync)return this.#sync
    this.#sync=this.#drain().then(async()=>{const complete=await this.client.memory('engine_outbox',{action:'status',scope:this.prefix,engine:this.key});if(complete!==true)throw Error('memory_engine_index_pending');this.lastIndexError=null}).catch((error:unknown)=>{this.lastIndexError='memory_engine_index_pending';throw error}).finally(()=>{this.#sync=undefined})
    return this.#sync
  }
  async #drain():Promise<void> {
    for(let n=0;n<8&&!this.#closed;n++) {
      const raw=await this.client.memory('engine_outbox',{action:'claim',scope:this.prefix,engine:this.key,embedding:this.embeddingFingerprint,extraction:this.extractionFingerprint,styles:this.config.styles,cleanup:!!this.retiredKey})
      if(raw===null)return
      const job=z.object({owner:z.string(),generation:z.number().int(),snapshot:engineSnapshotSchema}).parse(raw)
      const ticket={scope:this.prefix,engine:this.key,owner:job.owner,generation:job.generation,cleanup:!!this.retiredKey}
      try {
        if(!await this.client.memory('engine_outbox',{action:'check',...ticket})){await this.client.memory('engine_outbox',{action:'release',...ticket});continue}
        this.#ticket=ticket
        await this.#call('sync',job.snapshot)
        this.#ticket=undefined
        await this.client.memory('engine_outbox',{action:'ack',...ticket})
      }catch(error){this.#ticket=undefined;await this.client.memory('engine_outbox',{action:'release',...ticket});throw error}
    }
  }
  async recall(query:string,options:Parameters<MemoryRecallEngine['recall']>[1]={}):Promise<PersonalMemoryRecallResult> {
    const signal=options.signal??AbortSignal.timeout(8000)
    signal.throwIfAborted()
    // Query never silently falls back to the ledger or treats an incomplete index as a healthy empty result.
    const result=await this.#call('recall',{query,limit:Math.min(options.limit??8,20)},signal) as PersonalMemoryRecallResult
    const current=await this.client.memory('engine_outbox',{action:'status',scope:this.prefix,engine:this.key})
    signal.throwIfAborted()
    return {...result,scope:options.scope??'any',degraded:result.degraded||this.lastIndexError!==null||current!==true}
  }
  async close():Promise<void> {
    this.#closed=true;clearInterval(this.#timer)
    const worker=this.#worker
    if(worker){this.#fail(worker);await worker.terminate()}
    await this.#sync?.catch(()=>undefined)
  }
}
