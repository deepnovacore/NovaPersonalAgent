import {t,currentLanguage,setLanguage} from '../../locale.mjs'
const LABEL:Record<string,string>={overdue:'已过截止',current:'今天到期',soon:'接下来 7 天',later:'之后',waiting:'等待中 · 未设期限',unscheduled:'尚未安排',completed:'已完成'}
const STATUS={open:'待开始',doing:'进行中',waiting:'等待回复'}
export const TIMELINE_LABELS=LABEL,TIMELINE_STATUS_LABELS=STATUS
export function timelineDate(snapshot:any,now=new Date()){return now.toLocaleDateString('en-CA',{timeZone:snapshot?.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone})}
export function timelineGroups(snapshot:any,now=new Date()){
 const currentDate=timelineDate(snapshot,now),week=new Date(Date.parse(currentDate+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)
 const grouped=new Map<string,any[]>(Object.keys(LABEL).map(id=>[id,[]]))
 const recorded=snapshot?.life?.todos??[],derived=snapshot?.derived_understanding
 const proposed=(derived?.suggestions??[]).filter((item:any)=>(item.kind==='action'||item.kind==='progress')&&!item.todo_id&&!recorded.some((todo:any)=>todo.source_suggestion_id===item.id)).map((item:any)=>({...item,suggested:true,status:'open',note:item.body,sources:item.refs.flatMap((ref:any)=>{const source=derived.sources?.find((source:any)=>source.id===ref.entry_id);return source?.type?[{evidence_id:ref.entry_id,type:source.type,provider:source.provider,url:source.url,label:source.label,observed_at:source.observed_at}]:[]})}))
 for(const todo of [...recorded,...proposed]){
  if(todo.status==='cancelled')continue
  const date=todo.due??null,id=todo.status==='done'?'completed':date?(date<currentDate?'overdue':date===currentDate?'current':date<=week?'soon':'later'):todo.status==='waiting'?'waiting':'unscheduled'
  grouped.get(id)!.push({...todo,date,reference:{kind:'todo',id:todo.id,version:todo.version},goal:snapshot.life?.goals?.find((goal:any)=>goal.id===todo.goal_id)?.title??null})
 }
 return [...grouped].filter(([,items])=>items.length).map(([id,items])=>({id,label:LABEL[id],items:items.sort((a,b)=>(a.date??'').localeCompare(b.date??'')||a.title.localeCompare(b.title))}))
}
const ROLE_LIMIT=1000,INTRO_ROLE_LIMIT=80
const oneLine=(text:any,limit:number)=>{const flat=String(text).replace(/\s+/gu,' ').trim();return flat.length>limit?flat.slice(0,limit)+'…':flat}
const filled=(value:any)=>typeof value==='string'&&value.trim()!==''
/** Spoken description generated from snapshot fields only. It never reaches a model and invents no traits. */
export function soulIntro(soul:any,lang=currentLanguage()){
 const previous=currentLanguage();setLanguage(lang)
 try{
  const parts:string[]=[]
  if(filled(soul?.assistant_name))parts.push(t('我叫{0}。',soul.assistant_name.trim()))
  parts.push(filled(soul?.role)?t('你希望我是——{0}。',oneLine(soul.role,INTRO_ROLE_LIMIT)):t('你还没告诉我希望我是什么样的，想好了在下面写给我就行。'))
  if(filled(soul?.reply_style))parts.push(t('平时说话我会按你说的来：{0}。',oneLine(soul.reply_style,INTRO_ROLE_LIMIT)))
  const contact=soul?.contact
  if(contact){
   if(contact.briefs_on||contact.discovery_on)parts.push(t('我最多每天主动找你 {0} 次，{1} 到 {2} 不打扰你。',contact.daily_cap,contact.quiet_start,contact.quiet_end))
   else parts.push(t('我不会主动来找你，你叫我我再出现。'))
  }
  return parts.join(lang==='en'?' ':'')
 }finally{setLanguage(previous)}
}
export function contactSummary(contact:any){
 if(!contact)return ''
 const lines=[t('每天最多主动找你 {0} 次；{1} 到 {2} 不打扰你。',contact.daily_cap,contact.quiet_start,contact.quiet_end)]
 lines.push(contact.briefs_on?t('简报：已开启'):t('简报：未开启'),contact.discovery_on?t('主动发现：已开启'):t('主动发现：未开启'))
 return lines.join(' · ')
}
const topics=['人工智能','科技产品','设计','科学','文化','商业']
export function initialInterests(news:any,warmup:any){
 // An intentionally empty, previously edited list is also a user choice.
 if(news?.interests?.length||news?.profile_version>0)return (news.interests??[]).map((i:any)=>i.text)
 return warmup?.draft?.interests?.length?warmup.draft.interests.map((i:any)=>i.text):topics.slice(0,3)
}
/** Interests guessed from the profile rank nothing until the user keeps them; this keeps them as they are. */
export function confirmedInterests(news:any){return {enabled:news?.enabled??false,explore:news?.explore??true,interests:(news?.interests??[]).map((i:any)=>i.text),expected_version:news?.profile_version??0}}
export function sourceStatus(sources:any[]=[],status?:string){
 if(sources.some((source:any)=>source.processing_consent_required))return {kind:'consent',text:'部分资料需要授权后才能整理'}
 if(sources.length&&sources.every((source:any)=>['paused','disconnected'].includes(source.state)))return {kind:'paused',text:'资料来源已暂停'}
 if(sources.some((source:any)=>source.state==='error'||['error','degraded'].includes(source.health)))return {kind:'partial',text:'部分来源暂不可用，已有内容仍可查看'}
 if(status==='failed')return {kind:'failed',text:'这次整理未完成，已有内容仍可查看'}
 if(status==='working')return {kind:'working',text:'正在整理资料，已有内容仍可查看'}
 if(sources.some((source:any)=>source.scan_pending))return {kind:'indexing',text:'资料索引仍在更新'}
 return null
}
