import {attachSourceTags} from './source-popover.mjs'
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
 const groups=timelineGroups(snapshot,now).filter(group=>!compact||group.id!=='completed')
 const intro=el('p',t('按真实截止日期整理；未设时间的事项单独保留。'),'timeline-description');if(!compact)root.append(intro)
 if(!snapshot?.life){const status=el('p',t(connected?'正在读取事项…':'连接后可查看安排。'),'hint');status.setAttribute('role','status');root.append(status);return}
 const dated=groups.flatMap(group=>group.items).filter(item=>item.date&&item.status!=='done'),counts=new Map()
 for(const item of dated)counts.set(item.date,(counts.get(item.date)??0)+1)
 const cluster=[...counts].find(([date,count])=>date>=timelineDate(snapshot,now)&&count>1)
 if(cluster&&!compact){const notice=el('p',t('{0} 有 {1} 项到期，建议安排推进顺序。',new Date(cluster[0]+'T12:00:00Z').toLocaleDateString(currentLanguage(),{month:'short',day:'numeric',timeZone:'UTC'}),cluster[1]),'timeline-cluster');root.append(notice)}
 if(!groups.length){const empty=el('div',undefined,'timeline-empty');empty.append(el('h3',t('安排留有余地')),el('p',t('给待办设置截止日期后，会出现在这里。'),'hint'));button(t('查看待办'),openTodos,empty);root.append(empty)}
 for(const group of groups){
  const section=el('section',undefined,'timeline-group');section.dataset.group=group.id;section.append(el('h3',`${t(group.label)} · ${group.items.length}`,'timeline-group-title'));root.append(section)
  for(const item of group.items){
   const card=el('article',undefined,'timeline-card');card.dataset.objectId=item.id;section.append(card)
   const meta=el('div',t('待办'),'timeline-meta');card.append(meta)
   const dateLabel=item.date?new Date(item.date+'T12:00:00Z').toLocaleDateString(currentLanguage(),{...(item.date.slice(0,4)!==timelineDate(snapshot,now).slice(0,4)?{year:'numeric'}:{}),month:'short',day:'numeric',timeZone:'UTC'}):null
   const title=button(item.title,()=>item.status==='done'?openTodos(item.id):discuss([item.reference]),card,`timeline-discuss:${item.id}`);title.className='timeline-title'
   const tags=[]
   if(item.date)tags.push({label:item.status==='done'?t('原截止 {0}',dateLabel):group.id==='overdue'?t('已过截止 · {0}',dateLabel):t('截止 {0}',dateLabel),tone:group.id==='overdue'?'attention':'time'})
   if(item.importance==='high')tags.push({label:'重要',tone:'importance'})
   tags.push({label:item.status==='done'?'已完成':STATUS[item.status]??item.status,tone:item.status==='done'?'progress':item.status==='waiting'?'waiting':item.status==='doing'?'progress':'context'})
   if(item.goal)tags.push({label:item.goal,tone:'project'})
   renderCardTags(card,tags,{el});attachSourceTags(card,item.sources,{autoRecorded:item.auto_recorded,sourceChanged:item.source_changed,openArticle})
   if(!compact&&item.note)card.append(el('p',item.note,'timeline-note'))
   const actions=el('div',undefined,'timeline-actions');card.append(actions)
   const primary=item.status==='done'?null:button(t(item.status==='waiting'?'起草跟进':'排一版方案'),()=>discuss([item.reference],t(item.status==='waiting'?'请针对「{0}」起草一条跟进消息，先给我草稿。':'请针对「{0}」排一版可执行方案，结合真实截止日期，说明建议顺序。',item.title)),actions,`timeline-plan:${item.id}`);if(primary)primary.className='soft'
   if(!compact)button(t('查看事项'),()=>openTodos(item.id),actions).className='ghost'
   if(!compact&&command&&item.status!=='done')button(t(item.importance==='high'?'取消重要标记':'标为重要'),()=>command('life.mutate',{op:'update',kind:'todo',id:item.id,expected_version:item.version,importance:item.importance==='high'?'normal':'high'}),actions,`life:${item.id}`).className='ghost'
   if(!compact){const details=el('details');details.dataset.objectId=item.id;details.open=expanded.has(item.id);details.addEventListener('toggle',()=>{details.open?expanded.add(item.id):expanded.delete(item.id)});details.append(el('summary',t('事项依据')),el('p',t('来自待办 · 版本 {0}',item.version),'hint'));if(item.source_changed)details.append(el('p',t('来源内容已变化，请核对事项。'),'hint'));card.append(details)}
  }
 }
 root.append(el('p',t('这里展示待办安排；日历完整性尚未确认。'),'timeline-source-note'))
 for(const node of root.querySelectorAll('button'))if(!connected)node.disabled=true
}
