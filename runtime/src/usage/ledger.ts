import {Worker} from 'node:worker_threads'
import {normalizeUsageReport,type UsageReport} from '../realtime/usage.js'
import {accumulate,projectSummary,type UsageRow,type UsageSnapshot} from './summary.js'
/** Storage runs off the event loop; a broken ledger must never prevent model work. */
export class UsageLedger {
 readonly #worker:Worker
 readonly #pending=new Map<number,{resolve:(value:unknown)=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>()
 readonly #rows=new Map<string,UsageRow>();readonly #recent:UsageReport[]=[];readonly #seen=new Set<string>()
 readonly #startedAt=new Date().toISOString();readonly #recentLimit:number
 #sequence=0;#failed=false;#closed=false
 constructor(path:string,options:{recentLimit?:number}={}){
  this.#recentLimit=Math.min(500,Math.max(1,options.recentLimit??200))
  this.#worker=new Worker(new URL('./ledger-worker.js',import.meta.url),{workerData:{path,recentLimit:this.#recentLimit}})
  this.#worker.on('message',(message:{id:number;result?:unknown;error?:string})=>{const pending=this.#pending.get(message.id);if(!pending)return;clearTimeout(pending.timer);this.#pending.delete(message.id);if(message.error)pending.reject();else pending.resolve(message.result)})
  this.#worker.on('error',()=>this.#fail());this.#worker.on('exit',()=>this.#fail())
 }
 add(value:UsageReport):void{
  if(this.#closed)return
  const report=normalizeUsageReport({...value,timestamp:value.timestamp??new Date().toISOString(),feature:value.feature??(value.service==='llm'?'conversation':value.service==='embedding'?'embedding':'voice')});if(!report||this.#seen.has(report.id))return
  this.#seen.add(report.id);accumulate(this.#rows,report);this.#recent.push(report);if(this.#recent.length>this.#recentLimit)this.#recent.shift()
  if(!this.#failed)try{this.#worker.postMessage({method:'add',report})}catch{this.#fail()}
 }
 async snapshot():Promise<UsageSnapshot>{
  try{return await this.#request('snapshot') as UsageSnapshot}catch{
   const view=projectSummary(this.#rows,this.#recent,this.#startedAt)
   return {...view,history:view,persistenceError:'storage_failed',coverage:['nova_models','external_agent_tokens_unavailable']}
  }
 }
 async close():Promise<void>{if(this.#closed)return;this.#closed=true;try{await this.#request('close')}catch{/* worker failed */}finally{await this.#worker.terminate()}}
 #request(method:string):Promise<unknown>{
  if(this.#failed)return Promise.reject(Error('storage_failed'))
  const id=++this.#sequence
  return new Promise((resolve,reject)=>{const fail=()=>reject(Error('storage_failed'));const timer=setTimeout(()=>{this.#pending.delete(id);fail()},5000);this.#pending.set(id,{resolve,reject:fail,timer});this.#worker.postMessage({id,method})})
 }
 #fail(){this.#failed=true;for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject()}this.#pending.clear()}
}
