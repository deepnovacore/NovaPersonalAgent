import {z} from 'zod'
import {assertAcceptable,type EvidenceSource,type EvaluatedCandidate} from '../understanding/candidates.js'
import type {UnderstandingPipeline} from '../understanding/pipeline.js'
import type {LifeService} from './life.js'
/** Background interpretation is disposable; only authorized records enter LifeService. */
export class PersonalUnderstanding{
 #rows:EvaluatedCandidate[]=[];#status='idle';#error:string|null=null;#run:Promise<void>|undefined;#abort=new AbortController();#key='';#seen=new Set<string>();#accepted=new Set<string>();#dismissed=new Set<string>()
 #recorded:{id:string;object_id:string;version:number;text:string;scope:string|null}[]=[]
 constructor(readonly options:{pipeline?:UnderstandingPipeline;source:()=>EvidenceSource|null;scope?:()=>string|null;life:LifeService;changed:()=>void}){}
 #scope(){return this.options.scope?.()??this.options.source()?.id??null}
 #current(source:EvidenceSource){return JSON.stringify(source)===JSON.stringify(this.options.source())}
 snapshot(){const source=this.options.source();return {available:!!this.options.pipeline,status:this.#status,error:this.#error,recorded:this.#recorded.filter(r=>r.scope===this.#scope()).map(r=>({id:r.id,object_id:r.object_id,version:r.version,text:r.text})),items:this.#rows.filter(r=>r.status==='proposed'&&r.decision.capture!=='none'&&!this.#accepted.has(r.candidate.id)&&!this.#dismissed.has(r.candidate.id)&&!!source&&this.#current(r.source)).map(r=>({id:r.candidate.id,kind:r.candidate.kind,text:r.candidate.text,quote:r.candidate.span.quote,source_id:r.source.id,importance:r.decision.importance}))}}
 /** Called after durable host commits. Selection/replay invalidates but never starts extraction. */
 observe(newMessage=false){const source=this.options.source(),key=JSON.stringify(source);if(key!==this.#key){this.#abort.abort();this.#abort=new AbortController();this.#key=key;this.#rows=[];this.#run=undefined;this.#status='idle';this.#error=null}if(newMessage&&source&&this.options.pipeline&&!this.#seen.has(key))this.start(true)}
 start(automatic=false){if(!this.options.pipeline)throw Error('understanding_unavailable');this.observe();if(this.#run)return
  const source=this.options.source();if(!source)throw Error('no_user_message');const controller=this.#abort,scope=this.#scope();this.#seen.add(JSON.stringify(source));for(const key of [...this.#seen].slice(0,-256))this.#seen.delete(key)
  this.#status='working';this.#error=null;this.options.changed()
  const run=(async()=>{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]);let onAbort:()=>void=()=>{/* assigned before listening */};try{
   const rows=await Promise.race([this.options.pipeline!(source,signal),new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason instanceof Error?signal.reason:Error('understanding_aborted'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort()})]);if(signal.aborted||!this.#current(source))return
   this.#rows=rows
   if(automatic)for(const row of rows){if(row.status!=='proposed'||row.candidate.kind!=='todo'||row.decision.capture!=='explicit')continue;const guard=()=>{signal.throwIfAborted();const current=this.options.source();if(!current)throw Error('candidate_stale_source');assertAcceptable(row,current)};guard()
    const text=row.candidate.text,result=await this.options.life.mutate({op:'create',kind:'todo',title:text.slice(0,200),note:text.length>200?text:''},'candidate:'+row.candidate.id,guard)
    this.#accepted.add(row.candidate.id);this.#recorded.push({id:row.candidate.id,object_id:result.id,version:result.version,text,scope});this.#recorded=this.#recorded.slice(-20)
   }
   if(!signal.aborted&&this.#current(source))this.#status='ready'
  }catch{if(!controller.signal.aborted&&this.#current(source)){this.#error='understanding_failed';this.#status='failed'}}finally{signal.removeEventListener('abort',onAbort);if(this.#abort===controller){this.#run=undefined;this.options.changed()}}})();this.#run=run
 }
 async action(raw:unknown){const p=z.object({id:z.string(),action:z.enum(['accept','dismiss','undo']),text:z.string().trim().min(1).max(1000).optional(),expected_profile_version:z.number().int().optional()}).strict().parse(raw)
  if(p.action==='undo'){const record=this.#recorded.find(r=>r.id===p.id&&r.scope===this.#scope());if(!record)throw Error('record_not_found');await this.options.life.mutate({op:'undo_create',id:record.object_id,expected_version:record.version},'undo-candidate:'+p.id);this.#recorded=this.#recorded.filter(r=>r!==record);this.options.changed();return}
  const row=this.#rows.find(r=>r.candidate.id===p.id);if(!row)throw Error('candidate_not_found')
  const source=this.options.source();if(!source)throw Error('candidate_stale_source');assertAcceptable(row,source)
  if(p.action==='dismiss'){this.#dismissed.add(p.id);this.options.changed();return}
  if(this.#accepted.has(p.id))return
  const text=p.text??row.candidate.text,kind=row.candidate.kind
  if(kind==='profile'){const profile=this.options.life.snapshot().profile;if(p.expected_profile_version!==profile.version)throw Error('version_conflict');await this.options.life.mutate({op:'profile',expected_version:profile.version,about:[profile.about,text].filter(Boolean).join('\n')},'candidate:'+p.id)}
  else await this.options.life.mutate({op:'create',kind,title:text.slice(0,200),note:text.length>200?text:''},'candidate:'+p.id)
  this.#accepted.add(p.id);this.options.changed()
 }
 async close(){this.#abort.abort();await this.#run}
 reopen(){this.#abort=new AbortController();this.#rows=[];this.#recorded=[];this.#status='idle';this.#error=null;this.#key='';this.#seen.clear();this.#accepted.clear();this.#dismissed.clear()}
}
