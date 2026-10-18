import {attachSources,attachSourceTags,disposeSources} from './source-popover.mjs'
import {renderSourceStatus} from './source-status.mjs'
import {t,currentLanguage} from './locale.mjs'
import {renderCardTags} from './card-tags.mjs'
const LABEL={overdue:'已过截止',current:'今天到期',soon:'接下来 7 天',later:'之后',waiting:'等待中 · 未设期限',unscheduled:'尚未安排',completed:'已完成'}
const STATUS={open:'待开始',doing:'进行中',waiting:'等待回复'}
export function timelineDate(snapshot,now=new Date()){return now.toLocaleDateString('en-CA',{timeZone:snapshot?.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone})}
export function timelineGroups(snapshot,now=new Date()){
 const currentDate=timelineDate(snapshot,now),week=new Date(Date.parse(currentDate+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)
 const grouped=new Map(Object.keys(LABEL).map(id=>[id,[]]))
 const recorded=snapshot?.life?.todos??[],derived=snapshot?.derived_understanding
 const proposed=(derived?.suggestions??[]).filter(item=>(item.kind==='action'||item.kind==='progress')&&!item.todo_id&&!recorded.some(todo=>todo.source_suggestion_id===item.id)).map(item=>({...item,suggested:true,status:'open',note:item.body,sources:item.refs.flatMap(ref=>{const source=derived.sources?.find(source=>source.id===ref.entry_id);return source?.type?[{evidence_id:ref.entry_id,type:source.type,provider:source.provider,url:source.url,label:source.label,observed_at:source.observed_at}]:[]})}))
 for(const todo of [...recorded,...proposed]){
  if(todo.status==='cancelled')continue
  const date=todo.due??null,id=todo.status==='done'?'completed':date?(date<currentDate?'overdue':date===currentDate?'current':date<=week?'soon':'later'):todo.status==='waiting'?'waiting':'unscheduled'
  grouped.get(id).push({...todo,date,reference:{kind:'todo',id:todo.id,version:todo.version},goal:snapshot.life?.goals?.find(goal=>goal.id===todo.goal_id)?.title??null})
 }
 return [...grouped].filter(([,items])=>items.length).map(([id,items])=>({id,label:LABEL[id],items:items.sort((a,b)=>(a.date??'').localeCompare(b.date??'')||a.title.localeCompare(b.title))}))
}
export function renderTimeline(parent,{snapshot,el,button,discuss,openTodos,openArticle,openSettings,command,expanded=new Set(),compact=false,connected=true,now=new Date()}){
 const root=el('section',undefined,`timeline-content${compact?' timeline-compact':''}${snapshot?.timeline?' timeline-briefing':''}`);parent.append(root)
 renderSourceStatus(root,{sources:snapshot?.sources??[],status:snapshot?.profile_preparation?.status,processing:snapshot?.profile_preparation?.processing,el,button,openSettings})
 const groups=snapshot?.timeline?[]:timelineGroups(snapshot,now).filter(group=>!compact||group.id!=='completed'),currentDate=timelineDate(snapshot,now)
 const formatDate=date=>new Date(date+'T12:00:00Z').toLocaleDateString(currentLanguage(),{...(date.slice(0,4)!==currentDate.slice(0,4)?{year:'numeric'}:{}),month:'short',day:'numeric',timeZone:'UTC'})
 if(!snapshot?.life){const status=el('p',t(connected?'正在读取事项…':'连接后可查看安排。'),'hint');status.setAttribute('role','status');root.append(status);return}
 if(!compact){
  const active=groups.flatMap(group=>group.items).filter(item=>item.status!=='done'),overview=el('header',undefined,'timeline-overview')
  overview.append(el('p',t(snapshot.timeline?'近期简报':'安排与进展'),'timeline-overline'),el('h2',new Date(currentDate+'T12:00:00Z').toLocaleDateString(currentLanguage(),{month:'long',day:'numeric',weekday:'short',timeZone:'UTC'})))
  const summary=el('div',undefined,'timeline-overview-summary');summary.append(el('span',t('{0} 项有截止日期',active.filter(item=>item.date).length)))
  const waiting=active.filter(item=>item.status==='waiting').length;if(waiting)summary.append(el('span',t('{0} 项等待回复',waiting)))
  if(!snapshot.timeline)overview.append(summary);root.append(overview)
 }
 const separate=(snapshot?.derived_understanding?.suggestions??[]).filter(item=>snapshot.timeline||item.kind==='idea'||item.kind==='goal')
 if(separate.length){
  const section=el('section',undefined,'timeline-suggestions');section.append(el('h3',t('待确认建议'),'timeline-group-title'));root.append(section)
  for(const item of separate){
   const card=el('article',undefined,'timeline-card');card.dataset.objectId=item.id;card.dataset.suggested='true';card.append(el('h3',item.title,'timeline-title'),el('p',item.body,'timeline-note'));section.append(card)
   const sources=item.refs.flatMap(ref=>{const source=snapshot.derived_understanding.sources?.find(source=>source.id===ref.entry_id);return source?.type?[{...source,evidence_id:ref.entry_id}]:[]})
   attachSourceTags(card,sources,{openArticle,title:t('事项依据')})
   const actions=el('div',undefined,'timeline-actions');card.append(actions)
   button(t(item.kind==='progress'?'确认进展':item.kind==='idea'?'加入想法':item.kind==='goal'?'加入目标':'加入待办'),()=>command?.('understanding.adopt',{id:item.id}),actions).className='soft'
   button(t('忽略'),()=>command?.('understanding.dismiss',{id:item.id}),actions).className='ghost'
  }
 }
 const attention=snapshot.timeline
 const briefCards=[]
 const pageKey=`timeline:page:${attention?.generation_id??attention?.updated_at??'pending'}:`
 let pages=1;while(expanded.has(pageKey+pages))pages++
 const visibleCount=compact?3:pages*8
 if(attention){
  const section=el('section',undefined,'timeline-attention');section.setAttribute('aria-label',t('近期简报'));root.append(section)
  const header=el('div',undefined,'timeline-attention-header');header.append(el('p',t(attention.status==='working'?'正在整理近期进展…':'近期进展与值得关注的事'),'timeline-briefing-caption'));section.append(header)
  if(attention.updated_at&&Number.isFinite(Date.parse(attention.updated_at)))section.append(el('p',t('整理于 {0} · 卡片按事项时间排列',new Date(attention.updated_at).toLocaleString(currentLanguage(),{timeZone:snapshot.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})),'timeline-generated-at'))
  if(attention.input_count&&attention.coverage)section.append(el('p',attention.coverage,'hint timeline-coverage'))
  if((attention.diagnostics?.failed_batches?.length||attention.diagnostics?.pending_batches)&&attention.status!=='working')section.append(el('p',t('部分资料尚未完成整理，以下保留已核对的进展；可刷新补充。'),'hint timeline-partial'))
  if(attention.cards?.length&&attention.status==='failed')section.append(el('p',t('本次更新未完成，以下保留上次结果。'),'hint'))
  if(command){const refresh=button(t(attention.status==='working'?'正在整理…':'刷新'),()=>command('timeline.refresh',{}),header,'timeline:refresh');refresh.className='quiet';refresh.disabled=attention.status==='working'||attention.available===false}
  const latestReport=item=>Math.max(0,...(item.sources??[]).map(source=>Date.parse(source.observed_at??'')||0))
  const orderedBriefs=[...(attention.cards??[])].sort((a,b)=>(b.time?.anchor_date??'').localeCompare(a.time?.anchor_date??'')||latestReport(b)-latestReport(a))
  if(orderedBriefs.length)section.append(el('p',t('共 {0} 条进展 · 已展示 {1} 条',orderedBriefs.length,Math.min(visibleCount,orderedBriefs.length)),'hint timeline-brief-count'))
  for(const item of orderedBriefs.slice(0,visibleCount)){
   const kind=['attention','deadline','progress','insight'].includes(item.kind)?item.kind:'insight'
   const card=el('article',undefined,'timeline-attention-card');card.tabIndex=-1;card.dataset.kind=kind;card.dataset.objectId=item.id;briefCards.push({item,card});if(compact)section.append(card)
   const meta=el('div',undefined,'timeline-brief-meta'),topic=el('span',undefined,'timeline-topic')
   const glyph=el('span',{attention:'!',deadline:'◷',progress:'✓',insight:'◇'}[kind],'timeline-topic-icon');glyph.setAttribute('aria-hidden','true');topic.append(glyph,el('span',item.category));meta.append(topic)
   if(item.status_label)meta.append(el('span',item.status_label,'timeline-status-tag'));card.append(meta,el('h3',item.title))
   if(item.people?.length){const people=renderCardTags(card,item.people.map(person=>({label:person.name,tone:'person'})),{el});people.className+=' timeline-people';people.setAttribute('aria-label',t('相关同事'))}
   const timeMeta=el('div',undefined,'timeline-card-time'),time=item.time,label=text=>timeMeta.append(el('span',text,'timeline-time-label'))
   if(time?.anchor_date){
    label(t({occurred:'发生于 {0}',deadline:'截止 {0}',scheduled:'安排于 {0}',reported:'最近记录 {0}'}[time.anchor_basis]??'记录于 {0}',formatDate(time.anchor_date)))
    if(time.last_reported_on&&time.anchor_basis!=='reported')label(t('最近记录 {0}',formatDate(time.last_reported_on)))
    if(time.evidence_from&&time.evidence_to&&time.evidence_from!==time.evidence_to)label(t('依据 {0}—{1}',formatDate(time.evidence_from),formatDate(time.evidence_to)))
    if(time.started_on){label(t('始于 {0}',formatDate(time.started_on)));if(time.last_reported_on)label(t('记录跨度 {0} 天',Math.max(0,Math.round((Date.parse(time.last_reported_on)-Date.parse(time.started_on))/86400000))))}
    if(time.due_on){const days=Math.round((Date.parse(time.due_on)-Date.parse(currentDate))/86400000);label(t(days>0?'距截止 {0} 天':days===0?'今天截止':'原截止已过 {0} 天，结果以最新记录为准',Math.abs(days)))}
    if(time.kind==='ongoing'&&time.last_reported_on<currentDate)label(t('当前状态待更新'))
    if(time.anchor_basis==='reported'&&time.kind==='event')label(t('发生日期未明确'))
   }else label(t('时间待明确'))
   card.append(timeMeta)
   const facts=el('div',undefined,'timeline-attention-facts');facts.dataset.count=String(item.facts?.length??0);for(const fact of item.facts??[]){const panel=el('div',undefined,'timeline-fact');panel.dataset.tone=['risk','warning','positive'].includes(fact.tone)?fact.tone:'neutral';if(fact.label)panel.append(el('h4',fact.label));panel.append(el('p',fact.text));facts.append(panel)}card.append(facts)
   const reason=el('div',undefined,'timeline-attention-reason');reason.append(el('span',t({attention:'影响',deadline:'时间窗口',progress:'进展',insight:'判断'}[kind])),el('p',item.why_now));card.append(reason)
   if(item.next_steps?.length){
    const followups=el('section',undefined,'timeline-followups');followups.append(el('h4',t('接下来可以推进')))
    const steps=el('ol',undefined,'timeline-next-steps');for(const [index,step] of item.next_steps.entries()){const tile=el('li');tile.append(el('span',String(index+1).padStart(2,'0'),'timeline-step-number'),el('h5',step.title),el('p',step.detail));steps.append(tile)}followups.append(steps);card.append(followups)
   }
   if(item.uncertainty){const caution=el('p',undefined,'timeline-caution');caution.append(el('span',t('尚不确定：')),el('span',item.uncertainty));card.append(caution)}
   attachSourceTags(card,item.sources,{openArticle,title:t('事项依据')})
   const actions=el('div',undefined,'timeline-actions');card.append(actions)
   for(const action of item.actions??[])button(action.label,()=>discuss([{kind:'timeline',id:item.id,version:item.version,interaction:action.kind}],action.kind==='draft'?t('请直接在当前对话中根据引用事项写出草稿，并标明事实缺口。只展示文字，不创建待办或任务，不发送消息或执行操作。'):t('请在当前对话中分析引用事项，说明已知事实、判断和下一步。只讨论，不创建待办或任务，不执行操作。')),actions).className=action===item.actions[0]?'timeline-primary':'soft'
   if(command)button(t('隐藏'),()=>command('timeline.dismiss',{id:item.id}),actions).className='quiet timeline-dismiss'
  }
  if(!attention.cards?.length)section.append(el('p',t(attention.status==='working'?'正在结合近期信息整理…':attention.status==='queued'?'即将整理近期信息…':attention.status==='failed'?(attention.error==='timeline_generation_timeout'?'整理用时较长，尚未完成，可点击刷新重试。':'这次整理未完成，可稍后刷新。'):attention.input_count?'暂时没有足够明确的关注事项。':'已授权来源中暂时没有可整理的近期内容。'),'hint'))
 }
 if(!groups.length&&compact&&!attention){const empty=el('div',undefined,'timeline-empty');empty.append(el('h3',t('安排留有余地')),el('p',t('给待办设置截止日期后，会出现在这里。'),'hint'));button(t('查看待办'),openTodos,empty);root.append(empty)}
 let displayGroups=groups,axis
 if(!compact){
  const dates=new Map([[currentDate,{id:'current',date:currentDate,items:[]}]])
  for(const group of groups)if(['overdue','current','soon','later'].includes(group.id))for(const item of group.items){
   if(!dates.has(item.date))dates.set(item.date,{id:group.id,date:item.date,items:[]})
   dates.get(item.date).items.push(item)
  }
  for(const entry of briefCards){const date=entry.item.time?.anchor_date;if(!date)continue;if(!dates.has(date))dates.set(date,{id:date===currentDate?'current':date<currentDate?'history':'future',date,items:[]});const group=dates.get(date);(group.briefs??=[]).push(entry.card)}
  if(briefCards.some(entry=>entry.item.time?.anchor_date)&&!dates.get(currentDate).items.length&&!dates.get(currentDate).briefs?.length)dates.delete(currentDate)
  const dateGroups=[...dates.values()].sort((a,b)=>b.date.localeCompare(a.date))
  displayGroups=[...dateGroups,...groups.filter(group=>['waiting','unscheduled','completed'].includes(group.id))]
  axis=el('div',undefined,'timeline-axis');axis.setAttribute('aria-label',t(attention?'近期简报':'待办截止日期'));root.append(axis)
 }
 for(const group of displayGroups){
  const section=el('section',undefined,`timeline-group${group.date?' timeline-date-group'+(group.id==='current'?' timeline-current':''):compact?'':' timeline-undated'}`);section.dataset.group=group.id
  let cards=section
  if(group.date){
   section.dataset.date=group.date
   const marker=el('h3',undefined,'timeline-date-marker'),time=el('time',formatDate(group.date));time.dateTime=group.date
   if(group.id==='current')marker.append(el('span','Today','timeline-current-label'))
   marker.append(time,el('span',new Date(group.date+'T12:00:00Z').toLocaleDateString(currentLanguage(),{weekday:'short',timeZone:'UTC'}),'timeline-weekday'))
   cards=el('div',undefined,`timeline-day-cards${group.items.length>1?' timeline-shared-date':''}`);if(group.items.length>1)cards.append(el('p',t('{0} 项在同一天到期',group.items.length),'timeline-day-summary'));section.append(marker,cards);axis.append(section)
   if(group.briefs?.length)cards.append(...group.briefs)
   if(!group.items.length&&!group.briefs?.length){
    cards.append(el('p',t(attention?'今天暂无新的事项记录或到期安排':'今天没有到期事项'),'timeline-day-empty'))
    if(!groups.length&&!attention){cards.append(el('p',t('给待办设置截止日期后，会出现在这里。'),'hint'));button(t('查看待办'),openTodos,cards)}
   }
  }else{section.append(el('h3',`${t(group.label)} · ${group.items.length}`,'timeline-group-title'));root.append(section)}
  for(const item of group.items){
   const card=el('article',undefined,'timeline-card');card.dataset.objectId=item.id;cards.append(card);if(item.suggested)card.dataset.suggested='true'
   const days=item.date?Math.round((Date.parse(item.date)-Date.parse(currentDate))/86400000):null
   const pressure=item.status==='done'?t('已完成'):days===null?t(item.status==='waiting'?'等待回复 · 未设期限':'尚未安排'):days<0?t('已过截止 {0} 天',-days):days===0?t('今天到期'):days===1?t('明天到期'):t('还有 {0} 天',days)
   card.dataset.tone=item.status==='done'?'progress':days!==null&&days<0?'attention':days!==null&&days<=1?'time':days===null&&item.status==='waiting'?'waiting':'context';card.dataset.period=days!==null&&days<=1&&item.importance==='high'&&item.status!=='done'?'near':'later'
   const repeated=group.id==='current'||group.id==='waiting'||group.id==='completed'
   if(!repeated){const meta=el('div',pressure,'timeline-meta');card.append(meta);if(compact&&item.date){const time=el('time',formatDate(item.date));time.dateTime=item.date;meta.append(time)}}
   const dateLabel=item.date?formatDate(item.date):null
   const title=item.suggested?el('h3',item.title,'timeline-title'):button(item.title,()=>item.status==='done'?openTodos(item.id):discuss([item.reference]),card,`timeline-discuss:${item.id}`);title.className='timeline-title';if(item.suggested)card.append(title)
   if(item.source_changed)card.append(el('p',t('来源内容已变化，请先核对。'),'timeline-caution'))
   const excerpt=item.note||item.sources?.find(source=>typeof source?.summary==='string'&&source.summary.trim())?.summary
   if(excerpt){const context=el('div',undefined,'timeline-context');context.append(el('span',t(item.note?'当前记录':'来源摘录'),'timeline-context-label'),el('p',excerpt,'timeline-note'));card.append(context)}
   const tags=item.suggested?[{label:item.kind==='progress'?'进展建议':'建议',tone:'context'}]:[]
   if(item.date&&item.status==='done')tags.push({label:t('原截止 {0}',dateLabel),tone:'context'})
   if(item.importance==='high')tags.push({label:'重要',tone:'importance'})
   tags.push({label:item.status==='done'?'已完成':STATUS[item.status]??item.status,tone:item.status==='done'?'progress':item.status==='waiting'?'waiting':item.status==='doing'?'progress':'context'})
   if(item.goal)tags.push({label:item.goal,tone:'project'})
   renderCardTags(card,tags,{el});const sourceDetails=attachSourceTags(card,item.sources,{autoRecorded:item.auto_recorded,sourceChanged:false,openArticle,title:compact?undefined:t('事项依据')})
   const actions=el('div',undefined,'timeline-actions');card.append(actions)
   if(item.suggested){
    button(t('加入待办'),()=>command?.('understanding.adopt',{id:item.id}),actions).className='soft'
    button(t('忽略'),()=>command?.('understanding.dismiss',{id:item.id}),actions).className='ghost'
    continue
   }
   for(const update of snapshot?.derived_understanding?.suggestions??[])if(update.todo_id===item.id){
    const note=el('div',undefined,'timeline-context');note.append(el('span',t('进展建议'),'timeline-context-label'),el('p',update.body,'timeline-note'))
    button(t('确认进展'),()=>command?.('understanding.adopt',{id:update.id}),note).className='soft';button(t('忽略'),()=>command?.('understanding.dismiss',{id:update.id}),note).className='ghost';card.append(note)
   }
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
 if(!compact){const unplaced=briefCards.filter(entry=>!entry.item.time?.anchor_date);if(unplaced.length){const section=el('section',undefined,'timeline-unplaced');section.append(el('h3',t('时间待明确'),'timeline-group-title'),el('p',t('以下事项尚无可用于排序的日期。'),'hint'),...unplaced.map(entry=>entry.card));root.append(section)}}
 if(!compact&&(attention?.cards?.length??0)>visibleCount){
  const more=button(t('继续查看进展（还有 {0} 条）',attention.cards.length-visibleCount),()=>{
   expanded.add(pageKey+pages);disposeSources(root)
   const holder=el('div');renderTimeline(holder,{snapshot,el,button,discuss,openTodos,openArticle,openSettings,command,expanded,compact,connected,now})
   const replacement=holder.children[0];root.replaceWith(replacement)
   replacement.querySelectorAll('.timeline-attention-card')[visibleCount]?.focus?.({preventScroll:true})
  },root,'timeline:more');more.className='soft timeline-load-more'
 }
 root.append(el('p',t('这里展示已记录的事项和待确认建议，不代表完整日程。'),'timeline-source-note'))
 for(const node of root.querySelectorAll('button'))if(!connected&&node.className!=='source-info')node.disabled=true
}
