import type {TimelineInput} from '../personal-agent/timeline-brief.js'

/** A topic's inputs, ordered by source time; ties break on id so anchor choice is deterministic. */
const byTime=(a:TimelineInput,b:TimelineInput):number=>a.observed_at.localeCompare(b.observed_at)||a.id.localeCompare(b.id)

/** Old messages that name a state change are the ones a current card still has to explain. */
const STATE_WORDS=/(?:取消|完成|已完成|延期|推迟|恢复|撤回|截止|上线|发布|失败|阻塞|结束|关闭|卡住|cancelled|completed|postponed|resumed|reopened|blocked|failed|closed)/iu

/** How many messages directly before the newest one are always worth keeping. */
const NEIGHBOUR_WINDOW=6
/** Old evidence may not exceed half of the new evidence, and never drops below this floor. */
const MIN_BUDGET_CHARS=8000

export interface TimelineAnchorOptions {
 readonly budgetChars?:number
 readonly neighbourWindow?:number
}

/**
 * Trim the old half of a dirty topic to anchors while keeping every new message whole.
 *
 * Anchors, in priority order: originals the previous card was built from, the topic's first
 * message, old messages that name a state change, and the messages just before the newest one.
 * Trimming never splits a message; when anything is dropped the topic reports `history_complete:false`.
 */
export function withTimelineAnchors(
 topic:{readonly title:string;readonly inputs:readonly TimelineInput[];readonly history_complete?:boolean},
 newIds:ReadonlySet<string>,
 anchorIds:ReadonlySet<string>,
 options:TimelineAnchorOptions={},
):{title:string;inputs:TimelineInput[];history_complete?:boolean}{
 const inputs=[...topic.inputs].sort(byTime),fresh=inputs.filter(input=>newIds.has(input.id))
 if(!fresh.length)return {...{title:topic.title,inputs},...(topic.history_complete===undefined?{}:{history_complete:topic.history_complete})}
 const stale=inputs.filter(input=>!newIds.has(input.id))
 const firstIndex=inputs.findIndex(input=>newIds.has(input.id))
 const window=options.neighbourWindow??NEIGHBOUR_WINDOW
 const neighbours:TimelineInput[]=[]
 for(let index=Math.max(0,firstIndex-window);index<firstIndex;index+=1){const input=inputs[index]!;if(!newIds.has(input.id))neighbours.push(input)}
 const budget=options.budgetChars??Math.max(MIN_BUDGET_CHARS,Math.ceil(fresh.reduce((sum,input)=>sum+input.text.length,0)*0.5))
 const kept:TimelineInput[]=[],seen=new Set<string>()
 let used=0
 const keep=(input:TimelineInput,mandatory:boolean):void=>{
  if(seen.has(input.id))return
  if(!mandatory&&used+input.text.length>budget)return
  seen.add(input.id);kept.push(input);used+=input.text.length
 }
 for(const input of stale)if(anchorIds.has(input.id)||input===stale[0]||STATE_WORDS.test(input.text))keep(input,true)
 for(const input of neighbours)keep(input,false)
 const ordered=[...kept,...fresh].sort(byTime)
 const omitted=inputs.length-ordered.length
 return omitted>0
  ?{title:topic.title,inputs:ordered,history_complete:false}
  :{title:topic.title,inputs:ordered,...(topic.history_complete===undefined?{}:{history_complete:topic.history_complete})}
}
