import {z} from 'zod'
import {assertAcceptable,type EvidenceSource,type EvaluatedCandidate} from '../understanding/candidates.js'
import type {UnderstandingPipeline} from '../understanding/pipeline.js'
import type {LifeService} from './life.js'
/** Suggestions are disposable projections. Accepted objects are persisted by LifeService. */
export class PersonalUnderstanding{
 #rows:EvaluatedCandidate[]=[];#status='idle';#error:string|null=null;#run:Promise<void>|undefined;#abort=new AbortController();#accepted=new Set<string>();#dismissed=new Set<string>()
 constructor(readonly options:{pipeline?:UnderstandingPipeline;source:()=>EvidenceSource|null;life:LifeService;changed:()=>void}){}
 snapshot(){const source=this.options.source();return {available:!!this.options.pipeline,status:this.#status,error:this.#error,items:this.#rows.filter(r=>r.status==='proposed'&&!this.#accepted.has(r.candidate.id)&&!this.#dismissed.has(r.candidate.id)&&source?.id===r.source.id&&source.version===r.source.version&&source.text===r.source.text).map(r=>({id:r.candidate.id,kind:r.candidate.kind,text:r.candidate.text,quote:r.candidate.span.quote,source_id:r.source.id,importance:r.decision.importance}))}}
 start(){if(!this.options.pipeline)throw Error('understanding_unavailable');if(this.#run)return
  const source=this.options.source();if(!source)throw Error('no_user_message');this.#status='working';this.#error=null;this.options.changed()
  const run=(async()=>{try{const rows=await this.options.pipeline!(source,AbortSignal.any([this.#abort.signal,AbortSignal.timeout(60000)]));if(this.#abort.signal.aborted)return;this.#rows=rows;this.#status='ready'}catch{if(!this.#abort.signal.aborted){this.#error='understanding_failed';this.#status='failed'}}finally{this.#run=undefined;this.options.changed()}})();this.#run=run
 }
 async action(raw:unknown){const p=z.object({id:z.string(),action:z.enum(['accept','dismiss']),text:z.string().trim().min(1).max(1000).optional(),expected_profile_version:z.number().int().optional()}).strict().parse(raw)
  const row=this.#rows.find(r=>r.candidate.id===p.id);if(!row)throw Error('candidate_not_found')
  if(p.action==='dismiss'){this.#dismissed.add(p.id);this.options.changed();return}
  const source=this.options.source();if(!source)throw Error('candidate_stale_source');assertAcceptable(row,source)
  if(this.#accepted.has(p.id))return
  const text=p.text??row.candidate.text,kind=row.candidate.kind
  if(kind==='profile'){const profile=this.options.life.snapshot().profile;if(p.expected_profile_version!==profile.version)throw Error('version_conflict');await this.options.life.mutate({op:'profile',expected_version:profile.version,about:[profile.about,text].filter(Boolean).join('\n')},'candidate:'+p.id)}
  else await this.options.life.mutate({op:'create',kind,title:text.slice(0,200),note:text.length>200?text:''},'candidate:'+p.id)
  this.#accepted.add(p.id);this.options.changed()
 }
 async close(){this.#abort.abort();await this.#run}
 reopen(){this.#abort=new AbortController();this.#rows=[];this.#status='idle';this.#error=null}
}
