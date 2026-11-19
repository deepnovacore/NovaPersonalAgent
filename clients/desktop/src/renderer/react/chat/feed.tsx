import React,{useRef,useState} from 'react'
import {Clock3,Target} from 'lucide-react'
import {t} from '../../locale.mjs'
import {refusalText} from '../../host-refusals.mjs'
import {Markdown} from './markdown'

/**
 * A proactive feed item rendered inside the main conversation. The host mirrors every feed item as
 * a `feed:<id>` assistant message; the card adds the item's own structure and actions on top of that
 * message instead of leaving it as a bare Markdown paragraph.
 */
type FeedCardProps={feed:any,message:any,c:any,openLink?:(url:string)=>unknown,focusReference?:(references:any[],extra?:string)=>Promise<any>}
type Tag={label:string,tone:'context'|'time'|'waiting'|'progress'|'attention'}
const GOAL_CADENCE_LABEL:Record<string,string>={daily:'每天陪你练一点',progress:'有新进展时再问问你',off:'不主动提醒'}
/** Kind and lifecycle labels mirror the legacy feed card (feed-card.mjs) so both surfaces read the same. */
const FEED_KIND_LABEL:Record<string,string>={question:'待回应'}
const FEED_LIFECYCLE_LABEL:Record<string,string>={resolved:'已有结果',invalidated:'已失效'}
export function feedActionLabel(feed:any){
 if(typeof feed?.action_label==='string'&&feed.action_label.trim())return feed.action_label.trim()
 return feed?.kind==='task_result'?'查看任务结果':feed?.task_ref?'查看任务进展':feed?.kind==='question'?'回复这个问题':feed?.kind==='change'?'查看变化':'讨论这个建议'
}
const isDismissed=(feed:any)=>feed?.user_state==='dismissed'||feed?.user_state==='dismiss'
const isExpired=(feed:any)=>Boolean(feed?.expires_at&&Number.isFinite(Date.parse(feed.expires_at))&&Date.parse(feed.expires_at)<=Date.now())
const isSnoozed=(feed:any)=>feed?.user_state==='snoozed'&&Boolean(feed.snooze_until&&Number.isFinite(Date.parse(feed.snooze_until))&&Date.parse(feed.snooze_until)>Date.now())
const lifecycleOf=(feed:any)=>['active','resolved','invalidated'].includes(feed?.lifecycle)?feed.lifecycle:'active'
const anchorId=(feed:any)=>`feed-card-${String(feed?.id??'item').replace(/[^A-Za-z0-9_-]/gu,'-')}`
function goalProposalOf(feed:any){const goal=feed?.goal_proposal;return goal&&typeof goal.title==='string'&&goal.title.trim()?goal:null}
function checkinItemsOf(feed:any){const items=feed?.goal_checkin?.items;return Array.isArray(items)?items.filter((line:any)=>line&&typeof line.text==='string'&&line.text.trim()):null}
function text(value:any){return typeof value==='string'&&value.trim()?value.trim():''}

function FeedTags({feed}:{feed:any}){
 const lifecycle=lifecycleOf(feed),dismissed=isDismissed(feed),expired=isExpired(feed),tags:Tag[]=[]
 if(goalProposalOf(feed)){
  if(lifecycle==='resolved')tags.push({label:'已设为目标',tone:'progress'})
  else if(lifecycle==='invalidated')tags.push({label:'已失效',tone:'attention'})
  else if(!expired)tags.push({label:FEED_KIND_LABEL.question,tone:'waiting'})
 }else{
  const kind=FEED_KIND_LABEL[feed.kind]
  if(kind)tags.push({label:kind,tone:feed.kind==='question'?'waiting':'context'})
  const lifecycleLabel=FEED_LIFECYCLE_LABEL[lifecycle]
  if(lifecycleLabel)tags.push({label:lifecycleLabel,tone:lifecycle==='resolved'?'progress':'attention'})
 }
 if(feed.task_ref)tags.push({label:'关联任务',tone:'context'})
 if(dismissed)tags.push({label:'已忽略',tone:'context'})
 else if(isSnoozed(feed))tags.push({label:'稍后提醒',tone:'time'})
 return tags.length?<div className="feed-tags">{tags.map((tag,index)=><span className="feed-tag" data-tone={tag.tone} key={`${tag.label}:${index}`}>{t(tag.label)}</span>)}</div>:null
}
function FeedButton({variant='ghost',disabled=false,busy=false,onClick,title,describedBy,children}:any){
 return <button type="button" className={variant} disabled={disabled} aria-busy={busy||undefined} title={title} aria-describedby={describedBy} onClick={onClick}>{children}</button>
}

function GoalProposalBody({feed,goal,busy,c,run,hintId}:any){
 const success=text(goal.success_criteria),cadence=text(goal.cadence)?t(GOAL_CADENCE_LABEL[goal.cadence]??goal.cadence):''
 const resolved=lifecycleOf(feed)==='resolved',note=!c.connected?t('连接后可继续讨论。'):resolved?t('已设为目标。'):isDismissed(feed)?t('已忽略。'):lifecycleOf(feed)!=='active'||isExpired(feed)?t('这条建议已过期，请核对当前情况。'):''
 return <>
  <p className="feed-overline"><Target size={13} aria-hidden="true"/>{t('新目标建议')}</p>
  <h3 id={anchorId(feed)}>{text(feed.title)||goal.title}</h3>
  <dl className="feed-rows">
   <div className="feed-row"><dt>{t('目标')}</dt><dd>{goal.title}</dd></div>
   {success&&<div className="feed-row"><dt>{t('怎样算达成')}</dt><dd>{success}</dd></div>}
   {cadence&&<div className="feed-row"><dt>{t('建议节奏')}</dt><dd>{cadence}</dd></div>}
  </dl>
  <FeedTags feed={feed}/>
  {note?<p className="feed-unavailable" id={hintId}>{note}</p>:<div className="feed-actions">
   <FeedButton variant="soft" busy={busy==='adopt'} disabled={Boolean(busy)} onClick={()=>run('adopt',()=>c.command('feed.action',{id:feed.id,action:'adopt_goal',goal_revision:goal.revision}))}>{t('设为目标')}</FeedButton>
   <FeedButton busy={busy==='decline'} disabled={Boolean(busy)} onClick={()=>run('decline',()=>c.command('feed.action',{id:feed.id,action:'decline_goal'}))}>{t('不用了')}</FeedButton>
  </div>}
 </>
}

function GoalCheckinBody({feed,items,busy,c,run,focusReference}:any){
 const dismissed=isDismissed(feed),goals=c.snapshot?.life?.goals,expired=lifecycleOf(feed)!=='active'||isExpired(feed)
 const reply=(line:any,goal:any)=>run(`reply:${line.goal_id}`,()=>focusReference?.([{kind:'goal',id:line.goal_id,version:goal?.version??line.goal_version}]))
 return <>
  <p className="feed-overline"><Clock3 size={13} aria-hidden="true"/>{t('目标问候')}</p>
  <h3 id={anchorId(feed)}>{text(feed.title)||t('问问你的目标')}</h3>
  {text(feed.why_now)&&<p className="feed-why">{text(feed.why_now)}</p>}
  {items.map((line:any,index:number)=>{
   const goal=Array.isArray(goals)?goals.find((item:any)=>item.id===line.goal_id):undefined,deleted=Array.isArray(goals)&&!goal
   return <div className="feed-checkin" key={`${line.goal_id}:${index}`} data-goal-id={line.goal_id}>
    <p className="feed-checkin-text">{line.text}</p>
    {text(line.recalled)&&<p className="feed-recalled">{t('上次：{0}',text(line.recalled))}</p>}
    {dismissed||!c.connected?null:deleted?<p className="feed-hint">{t('这个目标已删除。')}</p>:<div className="feed-actions">
     <FeedButton variant="soft" busy={busy===`reply:${line.goal_id}`} disabled={Boolean(busy)||!focusReference} title={t('在主对话输入框引用这个目标；发送后 Nova 据此更新进展')} onClick={()=>reply(line,goal)}>{t('回复进展')}</FeedButton>
     {goal?.cadence==='off'?<small className="feed-hint">{t('已不再提醒')}</small>:<FeedButton busy={busy===`mute:${line.goal_id}`} disabled={Boolean(busy)} title={t('这个目标以后不再主动问候；可在目标卡片里改回提醒节奏')} onClick={()=>run(`mute:${line.goal_id}`,()=>c.command('feed.action',{id:feed.id,action:'goal_checkin_mute',goal_id:line.goal_id}))}>{t('不再提醒')}</FeedButton>}
    </div>}
   </div>
  })}
  {!dismissed&&!c.connected&&<p className="feed-unavailable">{t('连接后可继续讨论。')}</p>}
  {!dismissed&&c.connected&&expired&&<p className="feed-unavailable">{t('这条问候已过期。')}</p>}
 </>
}

function GenericFeedBody({feed,busy,c,run,openLink,message,hintId}:any){
 const dismissed=isDismissed(feed),expired=isExpired(feed),lifecycle=lifecycleOf(feed),label=feedActionLabel(feed),why=text(feed.why_now)
 const prepared=text(feed.prepared?.text)&&text(feed.prepared.text)!==why?text(feed.prepared.text):''
 const unavailable=!c.connected?t('连接后可继续讨论。'):!feed.task_ref&&(lifecycle!=='active'||expired)?lifecycle==='invalidated'?t('依据已变化，这条建议已失效。'):expired?t('这条建议已过期，请核对当前情况。'):t('这条建议已有结果。'):''
 return <>
  {text(feed.title)?<h3 id={anchorId(feed)}>{text(feed.title)}</h3>:null}
  {why&&<p className="feed-why">{why}</p>}
  {prepared&&<div className="feed-body-text"><Markdown text={prepared} openLink={openLink}/></div>}
  {!prepared&&<div className="feed-body-text"><Markdown text={text(message?.text)||why} openLink={openLink}/></div>}
  <FeedTags feed={feed}/>
  {unavailable&&<p className="feed-unavailable" id={hintId}>{unavailable}</p>}
  {!dismissed&&<div className="feed-actions">
   <FeedButton variant="soft" busy={busy==='open'} disabled={Boolean(busy)||Boolean(unavailable)} title={unavailable||undefined} describedBy={unavailable?hintId:undefined} onClick={()=>run('open',()=>c.openFeed?.(feed.id,label))}>{t(label)}</FeedButton>
   {lifecycle==='active'&&!expired&&c.connected&&<>
    <FeedButton busy={busy==='snooze'} disabled={Boolean(busy)} onClick={()=>run('snooze',()=>c.command('feed.action',{id:feed.id,action:'snooze',snooze_until:new Date(Date.now()+3600000).toISOString()}))}>{t('稍后')}</FeedButton>
    <FeedButton busy={busy==='dismiss'} disabled={Boolean(busy)} onClick={()=>run('dismiss',()=>c.command('feed.action',{id:feed.id,action:'dismiss'}))}>{t('忽略')}</FeedButton>
   </>}
  </div>}
 </>
}

export function FeedCard({feed,message,c,openLink,focusReference}:FeedCardProps){
 const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),lock=useRef(false)
 const goal=goalProposalOf(feed),items=checkinItemsOf(feed),kind=goal?'goal_proposal':items?`goal_checkin`:'generic',hintId=anchorId(feed)+'-hint'
 const run=async(key:string,action:()=>any)=>{
  if(lock.current)return
  lock.current=true;setBusy(key);setError('')
  try{await action?.()}catch(cause:any){setError(refusalText(cause?.message??cause))}finally{lock.current=false;setBusy(null)}
 }
 const labelled=goal||items||text(feed.title)
 return <section className="feed-card" data-feed-id={feed.id} data-kind={kind} data-dismissed={isDismissed(feed)?'true':undefined} aria-busy={busy?'true':undefined} aria-labelledby={labelled?anchorId(feed):undefined}>
  {goal?<GoalProposalBody feed={feed} goal={goal} busy={busy} c={c} run={run} hintId={hintId}/>:items?<GoalCheckinBody feed={feed} items={items} busy={busy} c={c} run={run} focusReference={focusReference}/>:<GenericFeedBody feed={feed} busy={busy} c={c} run={run} openLink={openLink} message={message} hintId={hintId}/>}
  {error&&<p className="feed-error" role="alert">{error}</p>}
 </section>
}
