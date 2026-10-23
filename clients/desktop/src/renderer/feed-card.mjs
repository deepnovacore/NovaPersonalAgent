import {attachFeedEvidence} from './feed-evidence.mjs'
import {renderCardTags} from './card-tags.mjs'
import {t} from './locale.mjs'
// A feed item rendered inside the main conversation. The host mirrors every
// feed_item as a `feed:<id>` assistant message; the card adds the item's actions
// on top of that message instead of a separate 动态 page.
export const FEED_KIND_LABEL={question:'待回应'}
export const FEED_LIFECYCLE_LABEL={active:'',resolved:'已有结果',invalidated:'已失效'}
export function feedActionLabel(item){return item.kind==='task_result'?'查看任务结果':item.task_ref?'查看任务进展':item.kind==='question'?'回复这个问题':item.kind==='change'?'查看变化':'讨论这个建议'}
export const GOAL_CADENCE_LABEL={daily:'每天陪你练一点',progress:'有新进展时再问问你',off:'不主动提醒'}
export const isDismissed=item=>item.user_state==='dismissed'||item.user_state==='dismiss'
/** Sends the presented receipt once per item; a failure clears the marker so the next visibility check retries. */
export function sendPresented(item,{presented,command}){
 if(!presented||!item||item.delivery?.presented_at||presented.has(item.id))return false
 presented.add(item.id)
 try{void Promise.resolve(command('feed.action',{id:item.id,action:'presented'})).catch(()=>presented.delete(item.id))}catch{presented.delete(item.id)}
 return true
}
/**
 * Renders one feed card into `parent`. `presented` is a shared Set so the
 * `presented` receipt is sent once per item and can be retried when it fails.
 */
export function renderFeedCard(parent,item,{el,button,chips,command,openFeed,visible=true,presented,body,memory,connected=true,currentItem,goals,reference}){
 const card=el('article',undefined,'feed-card');card.dataset.feedId=item.id
 const dismissed=isDismissed(item);if(dismissed)card.dataset.dismissed='true'
 if(item.goal_checkin)return renderGoalCheckin(parent,card,item,{el,button,command,visible,presented,connected,dismissed,goals,reference})
 card.append(el('h3',item.title))
 // Briefings carry their substance in prepared.text (mirrored into the message); why_now alone would drop it.
 const goal=item.goal_proposal
 // A goal proposal shows the goal and its cadence in the viewer's language instead of the runtime's why_now line.
 if(goal){card.append(el('p',t('目标：{0}',goal.title),'feed-why'));if(goal.success_criteria)card.append(el('p',t('怎样算达成：{0}',goal.success_criteria),'feed-body'));card.append(el('p',t('建议节奏：{0}',t(GOAL_CADENCE_LABEL[goal.cadence]??goal.cadence)),'feed-body'))}
 const why=!goal&&typeof item.why_now==='string'?item.why_now.trim():''
 const prepared=typeof item.prepared?.text==='string'&&item.prepared.text.trim()&&item.prepared.text.trim()!==why?item.prepared.text:null
 if(why)card.append(el('p',why,'feed-why'))
 if(prepared&&body)card.append(body(prepared))
 else if(prepared)card.append(el('p',prepared,'feed-body'))
 renderCardTags(card,[{label:FEED_KIND_LABEL[item.kind]??(item.kind==='task_result'?'任务回执':null),tone:item.kind==='question'?'waiting':'context'},{label:FEED_LIFECYCLE_LABEL[item.lifecycle]??item.lifecycle,tone:item.lifecycle==='resolved'?'progress':item.lifecycle==='invalidated'?'attention':'context'},...(item.task_ref?[{label:'关联任务',tone:'context'}]:[]),...(dismissed?[{label:'已忽略',tone:'context'}]:item.user_state==='snoozed'&&Date.parse(item.snooze_until)>Date.now()?[{label:'稍后提醒',tone:'time'}]:[])],{el})
 attachFeedEvidence(card,item,{el,button,command,memory,connected,currentItem})
 if(visible&&connected)sendPresented(item,{presented,command})
 if(!dismissed){
  const expired=Boolean(item.expires_at&&Date.parse(item.expires_at)<=Date.now())
  if(goal){
   const note=!connected?'连接后可继续讨论。':item.lifecycle==='resolved'?'已设为目标。':item.lifecycle!=='active'||expired?'这条建议已过期，请核对当前情况。':null
   if(note)card.append(el('p',t(note),'feed-unavailable'))
   else{const actions=el('div',undefined,'feed-actions');card.append(actions);button(t('设为目标'),()=>command('feed.action',{id:item.id,action:'adopt_goal',goal_revision:goal.revision}),actions).className='soft';button(t('不用了'),()=>command('feed.action',{id:item.id,action:'decline_goal'}),actions)}
   parent.append(card);return card
  }
  const unavailable=!connected?'连接后可继续讨论。':!item.task_ref&&(item.lifecycle!=='active'||expired)?item.lifecycle==='invalidated'?'依据已变化，这条建议已失效。':expired?'这条建议已过期，请核对当前情况。':'这条建议已有结果。':null
  if(unavailable)card.append(el('p',t(unavailable),'feed-unavailable'))
  const actions=el('div',undefined,'feed-actions');card.append(actions)
  const label=feedActionLabel(item);const primary=button(t(label),()=>openFeed(item.id,label),actions);primary.className='soft';primary.disabled=Boolean(unavailable);if(unavailable)primary.title=t(unavailable)
  if(item.lifecycle==='active'&&!expired&&connected){button(t('稍后'),()=>command('feed.action',{id:item.id,action:'snooze',snooze_until:new Date(Date.now()+3600000).toISOString()}),actions);button(t('忽略'),()=>command('feed.action',{id:item.id,action:'dismiss'}),actions)}
 }
 parent.append(card);return card
}
/**
 * A goal check-in summary: one line per goal, each with "reply with progress" (puts the goal's current
 * version into the main-chat composer as a reference) and "stop reminding" (turns that goal's cadence off).
 */
function renderGoalCheckin(parent,card,item,{el,button,command,visible,presented,connected,dismissed,goals,reference}){
 card.append(el('h3',t('问问你的目标')))
 const expired=item.lifecycle!=='active'||Boolean(item.expires_at&&Date.parse(item.expires_at)<=Date.now())
 for(const line of item.goal_checkin.items){
  const row=el('div',undefined,'feed-checkin');row.dataset.goalId=line.goal_id;card.append(row)
  row.append(el('p',line.text,'feed-body'))
  if(line.recalled)row.append(el('p',t('上次：{0}',line.recalled),'feed-why'))
  if(dismissed||!connected)continue
  const goal=goals?.find(g=>g.id===line.goal_id)
  if(goals&&!goal){row.append(el('p',t('这个目标已删除。'),'feed-unavailable'));continue}
  const actions=el('div',undefined,'feed-actions');row.append(actions)
  const reply=button(t('回复进展'),()=>reference([{kind:'goal',id:line.goal_id,version:goal?.version??line.goal_version}]),actions);reply.className='soft';reply.title=t('在主对话输入框引用这个目标；发送后 Nova 据此更新进展')
  if(goal?.cadence==='off')actions.append(el('small',t('已不再提醒'),'hint'))
  else button(t('不再提醒'),()=>command('feed.action',{id:item.id,action:'goal_checkin_mute',goal_id:line.goal_id}),actions).title=t('这个目标以后不再主动问候；可在目标卡片里改回提醒节奏')
 }
 if(!connected&&!dismissed)card.append(el('p',t('连接后可继续讨论。'),'feed-unavailable'))
 else if(expired&&!dismissed)card.append(el('p',t('这条问候已过期。'),'feed-unavailable'))
 if(visible&&connected)sendPresented(item,{presented,command})
 parent.append(card);return card
}
