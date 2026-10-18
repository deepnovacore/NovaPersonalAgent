import {createHash} from 'node:crypto'
import {interleave} from './sampling.js'
import {digestEligible} from './context-candidates.js'
import type {ContextEntry} from './workbench-context.js'
import type {TimelineInput} from './timeline-brief.js'
import type {MemoryEntry} from '../memory/entry.js'

/** Use Profile's authorized document pool and stated memories; retain original dates. */
export function timelineContextInputs(files:readonly ContextEntry[],memories:readonly MemoryEntry[]):TimelineInput[]{
 const groups=new Map<string,TimelineInput[]>()
 for(const entry of [...files].sort((a,b)=>('mtime_ms' in b?b.mtime_ms:0)-('mtime_ms' in a?a.mtime_ms:0))){
  if(!('kind' in entry)||entry.kind!=='file'||!digestEligible(entry))continue
  const group='project:'+createHash('sha256').update(entry.root).digest('hex'),rows=groups.get(group)??[]
  rows.push({id:entry.id,version:String(entry.version),kind:'file',group,text:entry.content,observed_at:new Date(entry.mtime_ms).toISOString(),source:{evidence_id:entry.id,type:'file',label:entry.rel_path.split(/[\\/]/u).at(-1)!.slice(0,120),observed_at:new Date(entry.mtime_ms).toISOString()}});groups.set(group,rows)
 }
 return [...memories.map(entry=>({id:'memory:'+entry.id,version:String(entry.version),kind:'memory',text:entry.content,observed_at:entry.observed_at,evidence_refs:entry.evidence_refs??[],...(entry.sources?.[0]?{source:entry.sources[0]}:{})})),...interleave(groups.values(),128)]
}

/** Keep the two-week message pool intact; model requests are bounded in the writer. */
export function selectTimelineInputs(inputs:readonly TimelineInput[]):TimelineInput[]{
 const groups=new Map<string,TimelineInput[]>(),seen=new Set<string>()
 for(const input of inputs){if(seen.has(input.id))continue;seen.add(input.id);const key=input.group??input.kind,rows=groups.get(key)??[];rows.push({...input,text:input.text.slice(0,4000)});groups.set(key,rows)}
 return interleave(groups.values(),5200)
}

/** Each input is inspected in exactly one bounded screening request. */
export function timelineBatches(inputs:readonly TimelineInput[]):TimelineInput[][]{
 const batches:TimelineInput[][]=[];let batch:TimelineInput[]=[],size=0
 for(const input of inputs){if(batch.length&&(size+input.text.length>60000||batch.length>=200)){batches.push(batch);batch=[];size=0}batch.push(input);size+=input.text.length}
 if(batch.length)batches.push(batch)
 return batches
}
