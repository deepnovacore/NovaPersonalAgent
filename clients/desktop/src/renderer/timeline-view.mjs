import {attachSources,attachSourceTags} from './source-popover.mjs'
import {t,currentLanguage} from './locale.mjs'
import {renderCardTags} from './card-tags.mjs'
const LABEL={overdue:'已过截止',current:'今天到期',soon:'接下来 7 天',later:'之后',waiting:'等待中 · 未设期限',unscheduled:'尚未安排',completed:'已完成'}
const STATUS={open:'待开始',doing:'进行中',waiting:'等待回复'}
export function timelineDate(snapshot,now=new Date()){return now.toLocaleDateString('en-CA',{timeZone:snapshot?.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone})}
export function timelineGroups(snapshot,now=new Date()){
 const currentDate=timelineDate(snapshot,now),week=new Date(Date.parse(currentDate+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)
 const grouped=new Map(Object.keys(LABEL).map(id=>[id,[]]))
 for(const todo of snapshot?.life?.todos??[]){
  if(todo.status==='cancelled')continue
  const date=todo.due??null,id=todo.status==='done'?'completed':date?(date<currentDate?'overdue':date===currentDate?'current':date<=week?'soon':'later'):todo.status==='waiting'?'waiting':'unscheduled'
  grouped.get(id).push({...todo,date,reference:{kind:'todo',id:todo.id,version:todo.version},goal:snapshot.life?.goals?.find(goal=>goal.id===todo.goal_id)?.title??null})
 }
 return [...grouped].filter(([,items])=>items.length).map(([id,items])=>({id,label:LABEL[id],items:items.sort((a,b)=>(a.date??'').localeCompare(b.date??'')||a.title.localeCompare(b.title))}))
}
export function renderTimeline(parent,{snapshot,el,button,discuss,openTodos,openArticle,command,expanded=new Set(),compact=false,connected=true,now=new Date()}){
 const root=el('section',undefined,`timeline-content${compact?' timeline-compact':''}`);parent.append(root)
 const groups=timelineGroups(snapshot,now).filter(group=>!compact||group.id!=='completed'),currentDate=timelineDate(snapshot,now)
 const formatDate=date=>new Date(date+'T12:00:00Z').toLocaleDateString(currentLanguage(),{...(date.slice(0,4)!==currentDate.slice(0,4)?{year:'numeric'}:{}),month:'short',day:'numeric',timeZone:'UTC'})
 if(!snapshot?.life){const status=el('p',t(connected?'正在读取事项…':'连接后可查看安排。'),'hint');status.setAttribute('role','status');root.append(status);return}
 if(!compact){
  const active=groups.flatMap(group=>group.items).filter(item=>item.status!=='done'),overview=el('header',undefined,'timeline-overview')
  overview.append(el('p',t('安排与进展'),'timeline-overline'),el('h2',new Date(currentDate+'T12:00:00Z').toLocaleDateString(currentLanguage(),{month:'long',day:'numeric',weekday:'short',timeZone:'UTC'})))
  const summary=el('div',undefined,'timeline-overview-summary');summary.append(el('span',t('{0} 项有截止日期',active.filter(item=>item.date).length)))
  const waiting=active.filter(item=>item.status==='waiting').length;if(waiting)summary.append(el('span',t('{0} 项等待回复',waiting)))
  overview.append(summary);root.append(overview)
 }
 if(!groups.length&&compact){const empty=el('div',undefined,'timeline-empty');empty.append(el('h3',t('安排留有余地')),el('p',t('给待办设置截止日期后，会出现在这里。'),'hint'));button(t('查看待办'),openTodos,empty);root.append(empty)}
 let displayGroups=groups,axis,pastAxis
 if(!compact){
  const dates=new Map([[currentDate,{id:'current',date:currentDate,items:[]}]])
  for(const group of groups)if(['overdue','current','soon','later'].includes(group.id))for(const item of group.items){
   if(!dates.has(item.date))dates.set(item.date,{id:group.id,date:item.date,items:[]})
   dates.get(item.date).items.push(item)
  }
  const dateGroups=[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date))
  displayGroups=[...dateGroups,...groups.filter(group=>['waiting','unscheduled','completed'].includes(group.id))]
  const overdue=groups.find(group=>group.id==='overdue')
  if(overdue){
   const past=el('details',undefined,'timeline-past');past.open=expanded.has('timeline:past-due');past.addEventListener('toggle',()=>{past.open?expanded.add('timeline:past-due'):expanded.delete('timeline:past-due')})
   past.append(el('summary',`${t(overdue.label)} · ${overdue.items.length}`,'timeline-past-title'));pastAxis=el('div',undefined,'timeline-axis');past.append(pastAxis);root.append(past)
  }
  axis=el('div',undefined,'timeline-axis');axis.setAttribute('aria-label',t('待办截止日期'));root.append(axis)
 }
 for(const group of displayGroups){
  const section=el('section',undefined,`timeline-group${group.date?' timeline-date-group'+(group.id==='current'?' timeline-current':''):compact?'':' timeline-undated'}`);section.dataset.group=group.id
  let cards=section
  if(group.date){
   section.dataset.date=group.date
   const marker=el('h3',undefined,'timeline-date-marker'),time=el('time',formatDate(group.date));time.dateTime=group.date
   if(group.id==='current')marker.append(el('span','Today','timeline-current-label'))
   marker.append(time,el('span',new Date(group.date+'T12:00:00Z').toLocaleDateString(currentLanguage(),{weekday:'short',timeZone:'UTC'}),'timeline-weekday'))
   if(group.items.length===1)marker.append(el('span',t('{0} 项到期',group.items.length),'timeline-date-count'))
   cards=el('div',undefined,`timeline-day-cards${group.items.length>1?' timeline-shared-date':''}`);if(group.items.length>1)cards.append(el('p',t('{0} 项在同一天到期',group.items.length),'timeline-day-summary'));section.append(marker,cards);(group.id==='overdue'?pastAxis:axis).append(section)
   if(!group.items.length){
    cards.append(el('p',t('今天没有到期事项'),'timeline-day-empty'))
    if(!groups.length){cards.append(el('p',t('给待办设置截止日期后，会出现在这里。'),'hint'));button(t('查看待办'),openTodos,cards)}
   }
  }else{section.append(el('h3',`${t(group.label)} · ${group.items.length}`,'timeline-group-title'));root.append(section)}
  for(const item of group.items){
   const card=el('article',undefined,'timeline-card');card.dataset.objectId=item.id;cards.append(card)
   const days=item.date?Math.round((Date.parse(item.date)-Date.parse(currentDate))/86400000):null
   const pressure=item.status==='done'?t('已完成'):days===null?t(item.status==='waiting'?'等待回复 · 未设期限':'尚未安排'):days<0?t('已过截止 {0} 天',-days):days===0?t('今天到期'):days===1?t('明天到期'):t('还有 {0} 天',days)
   card.dataset.tone=item.status==='done'?'progress':days!==null&&days<0?'attention':days!==null&&days<=1?'time':days===null&&item.status==='waiting'?'waiting':'context';card.dataset.period=days!==null&&days<=1&&item.status!=='done'?'near':'later'
   const meta=el('div',pressure,'timeline-meta');card.append(meta)
   const dateLabel=item.date?formatDate(item.date):null
   const title=button(item.title,()=>item.status==='done'?openTodos(item.id):discuss([item.reference]),card,`timeline-discuss:${item.id}`);title.className='timeline-title'
   if(item.source_changed)card.append(el('p',t('来源内容已变化，请先核对。'),'timeline-caution'))
   const excerpt=item.note||item.sources?.find(source=>typeof source?.summary==='string'&&source.summary.trim())?.summary
   if(excerpt){const context=el('div',undefined,'timeline-context');context.append(el('span',t(item.note?'当前记录':'来源摘录'),'timeline-context-label'),el('p',excerpt,'timeline-note'));card.append(context)}
   if(compact&&item.date&&days!==0&&item.status!=='done'){
    const range=el('div',undefined,'timeline-time-range'),endpoints=days<0?[[item.date,'原截止'],[currentDate,'现在']]:[[currentDate,'现在'],[item.date,'截止日期']]
    for(const [date,label]of endpoints){const point=el('div',undefined,'timeline-time-point'),time=el('time',formatDate(date));time.dateTime=date;point.append(el('span',t(label)),time);range.append(point)}
    card.append(range)
   }
   const tags=[]
   if(item.date&&item.status==='done')tags.push({label:t('原截止 {0}',dateLabel),tone:'context'})
   if(item.importance==='high')tags.push({label:'重要',tone:'importance'})
   tags.push({label:item.status==='done'?'已完成':STATUS[item.status]??item.status,tone:item.status==='done'?'progress':item.status==='waiting'?'waiting':item.status==='doing'?'progress':'context'})
   if(item.goal)tags.push({label:item.goal,tone:'project'})
   renderCardTags(card,tags,{el});const sourceDetails=attachSourceTags(card,item.sources,{autoRecorded:item.auto_recorded,sourceChanged:false,openArticle,title:compact?undefined:t('事项依据')})
   const actions=el('div',undefined,'timeline-actions');card.append(actions)
   const action=item.source_changed?'核对来源':item.status==='waiting'?'起草跟进':item.status==='doing'?'整理下一步':'拆成行动步骤'
   const prompt=item.source_changed?'请针对「{0}」核对已记录的来源内容，说明哪些已知、哪些需要进一步确认，再整理下一步行动。':item.status==='waiting'?'请针对「{0}」起草一条跟进消息，先给我草稿。':item.status==='doing'?'请针对「{0}」结合当前记录和真实截止日期，整理下一步行动和需要确认的问题。':'请针对「{0}」拆成可执行的行动步骤，结合真实截止日期，说明建议顺序。'
   const primary=item.status==='done'?null:button(t(action),()=>discuss([item.reference],t(prompt,item.title)),actions,`timeline-plan:${item.id}`);if(primary)primary.className='soft'
   button(t('查看事项'),()=>openTodos(item.id),actions).className='ghost'
   if(!compact&&command&&item.status!=='done'){
    const label=t(item.importance==='high'?'取消重要标记':'标为重要'),star=button(label,()=>command('life.mutate',{op:'update',kind:'todo',id:item.id,expected_version:item.version,importance:item.importance==='high'?'normal':'high'}),card,`life:${item.id}`)
    star.className='timeline-importance';star.textContent=item.importance==='high'?'★':'☆';star.title=label;star.setAttribute('aria-label',label);star.setAttribute('aria-pressed',String(item.importance==='high'))
   }
   if(!compact){
    const version=t('来自待办 · 版本 {0}',item.version),details=sourceDetails?.popover?sourceDetails:attachSources(card,[t('来自你的待办'),t('尚未关联外部来源'),version],{title:t('事项依据')})
    if(sourceDetails?.popover)details.popover.append(el('p',version,'hint'))
    if(item.source_changed)details.popover.append(el('p',t('来源内容已变化，请核对事项。'),'hint'))
    details.info.title=t('事项依据')
   }
  }
 }
 root.append(el('p',t('这里只展示已记录的事项，不代表完整日程。'),'timeline-source-note'))
 for(const node of root.querySelectorAll('button'))if(!connected&&node.className!=='source-info')node.disabled=true
}
