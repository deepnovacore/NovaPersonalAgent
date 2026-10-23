import test,{beforeEach,afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {timelineGroups,renderTimeline} from '../src/renderer/timeline-view.mjs'
import {disposeSources} from '../src/renderer/source-popover.mjs'
import {setLanguage} from '../src/renderer/locale.mjs'
const snapshot={settings:{timezone:'Asia/Shanghai'},life:{goals:[{id:'g',title:'Ship Nova'}],todos:[
 {id:'date',title:'Draft',status:'open',due:'2026-10-12',version:1,goal_id:'g'},
 {id:'wait',title:'Reply',status:'waiting',due:null,version:3,updated_at:'2026-09-01T00:00:00Z'},
 {id:'past',title:'Late',status:'open',due:'2026-10-10',version:1},
 {id:'cancel',title:'Cancelled',status:'cancelled',due:'2026-10-11',version:1},
 ]},feed:[{expires_at:'2026-10-11T00:00:00Z'}]}
test('timeline honors configured timezone, date-only deadlines and undated waits',()=>{
 const groups=timelineGroups(snapshot,new Date('2026-10-10T18:00:00Z'))
 assert.deepEqual(groups.map(g=>g.id),['overdue','soon','waiting'])
 assert.equal(groups[1].items[0].date,'2026-10-12');assert.equal(groups[1].items[0].goal,'Ship Nova')
 assert.equal(groups[2].items[0].date,null);assert.equal(groups[2].items[0].elapsed,undefined)
 assert.equal(groups.flatMap(g=>g.items).length,3)
})
test('same objects update once; completed and cancelled items leave active groups',()=>{
 const next=structuredClone(snapshot);next.life.todos[0]={...next.life.todos[0],version:2,due:'2026-10-20'};next.life.todos[2].status='done'
 const groups=timelineGroups(next,new Date('2026-10-11T08:00:00Z'))
 assert.equal(groups.flatMap(g=>g.items).filter(i=>i.id==='date').length,1)
 assert.equal(groups.find(g=>g.id==='later').items[0].reference.version,2)
 assert.equal(groups.some(g=>g.id==='overdue'),false)
})

class Element{
 constructor(tag,text,className=''){this.tag=tag;this.textContent=text??'';this.className=className;this.children=[];this.dataset={};this.listeners={};this.style={};this.hidden=false}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
 setAttribute(key,value){this[key]=value}
 addEventListener(event,handler){this.listeners[event]=handler}
 contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false}
 replaceWith(node){const host=this.parentElement;host.children[host.children.indexOf(this)]=node;node.parentElement=host}
 focus(){document.activeElement=this}
 querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tag===selector)?[node]:[],...node.querySelectorAll(selector)])}
}
const previousDocument=globalThis.document
beforeEach(()=>{globalThis.document={activeElement:null,listeners:new Map(),createElement:tag=>new Element(tag),addEventListener(event,handler){if(!this.listeners.has(event))this.listeners.set(event,new Set());this.listeners.get(event).add(handler)},removeEventListener(event,handler){this.listeners.get(event)?.delete(handler)}}})
afterEach(()=>{disposeSources();globalThis.document=previousDocument})
function render(state,options={}){
 const parent=new Element('main'),calls=[],starts=[],el=(...args)=>new Element(...args)
 const button=(text,click,host)=>{const node=el('button',text);node.addEventListener('click',click);host.append(node);return node}
 renderTimeline(parent,{snapshot:{settings:snapshot.settings,...state},el,button,discuss:(...args)=>calls.push(args),startConversation:(...args)=>starts.push(args),now:new Date('2026-10-11T18:00:00Z'),...options})
 return {parent,calls,starts}
}
test('dated cards share chronological date nodes while undated and completed cards stay off the axis',()=>{
 const state=structuredClone(snapshot)
 state.life.todos.push({id:'same-day',title:'Second draft',status:'open',due:'2026-10-12',version:2},{id:'future',title:'Next',status:'waiting',due:'2026-10-14',version:1},{id:'done',title:'Finished',status:'done',due:'2026-10-20',version:1})
 const {parent,calls}=render(state),dates=parent.querySelectorAll('.timeline-date-group')
 assert.deepEqual(dates.map(node=>node.dataset.date),['2026-10-14','2026-10-12','2026-10-10'])
 assert.deepEqual(dates[1].querySelectorAll('article').map(node=>node.dataset.objectId),['date','same-day'])
 assert.equal(dates[1].querySelectorAll('.timeline-date-count').length,0)
 assert.equal(dates[1].querySelectorAll('.timeline-day-summary')[0]?.textContent,'2 项在同一天到期')
 const timed=parent.querySelectorAll('.timeline-axis').flatMap(node=>node.querySelectorAll('article'))
 assert.deepEqual(timed.map(node=>node.dataset.objectId),['future','date','same-day','past'])
 assert.equal(parent.querySelectorAll('article').length,6)
 dates[1].querySelectorAll('.timeline-title')[0].listeners.click()
 assert.deepEqual(calls,[[[{kind:'todo',id:'date',version:1}]]])
})
test('Today uses the configured local date and remains present without any due items',()=>{
 const state={settings:{timezone:'Asia/Shanghai'},life:{todos:[],goals:[]}}
 const {parent}=render(state),dates=parent.querySelectorAll('.timeline-date-group')
 assert.equal(dates.length,1)
 assert.equal(dates[0].dataset.date,'2026-10-12')
 assert.equal(parent.querySelectorAll('.timeline-current-label')[0]?.textContent,'今天')
 assert.equal(parent.querySelectorAll('time')[0]?.dateTime,'2026-10-12')
 assert.equal(parent.querySelectorAll('article').length,0)
})
test('past dates remain on the same descending axis after Today',()=>{
 const {parent}=render(snapshot)
 assert.equal(parent.querySelectorAll('.timeline-past').length,0)
 assert.deepEqual(parent.querySelectorAll('.timeline-date-group').map(node=>node.dataset.date),['2026-10-12','2026-10-10'])
})
test('compact sidebar retains its groups without date gutters or a current-day empty node',()=>{
 const {parent}=render(snapshot,{compact:true})
 assert.equal(parent.querySelectorAll('.timeline-axis').length,0)
 assert.equal(parent.querySelectorAll('.timeline-current-label').length,0)
 assert.deepEqual(parent.querySelectorAll('.timeline-group').map(node=>node.dataset.group),['overdue','current','waiting'])
 assert.equal(parent.querySelectorAll('article').length,3)
 const card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date')
 assert.equal(card.querySelectorAll('.timeline-meta').length,0)
 assert.equal(card.querySelectorAll('.timeline-time-range').length,0)
})

test('the item info icon opens its version and Escape closes it with focus restored',()=>{
 const {parent}=render(snapshot),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date'),info=card.querySelectorAll('.source-info')[0]
 assert.ok(info)
 assert.equal(info.textContent,'ⓘ');assert.equal(info['aria-label'],'事项依据')
 assert.equal(card.querySelectorAll('summary').length,0)
 const popover=card.querySelectorAll('.source-popover')[0];assert.equal(popover.hidden,true)
 info.listeners.click({stopPropagation(){}})
 assert.equal(popover.hidden,false);assert.equal(info['aria-expanded'],'true')
 assert.ok(popover.querySelectorAll('li').some(node=>node.textContent==='来自待办 · 版本 1'))
 for(const listener of document.listeners.get('keydown'))listener({key:'Escape',preventDefault(){}})
 assert.equal(popover.hidden,true);assert.equal(document.activeElement,info)
})
test('a card with provenance uses one info icon for both the source and item details',()=>{
 const state=structuredClone(snapshot);state.life.todos[0].sources=[{type:'mail',summary:'已确认的截止说明'}];state.life.todos[0].source_changed=true
 const {parent}=render(state),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date')
 assert.equal(card.querySelectorAll('.source-info').length,1)
 const popover=card.querySelectorAll('.source-popover')[0]
 assert.ok(popover.querySelectorAll('p').some(node=>node.textContent==='来自待办 · 版本 1'))
 assert.ok(popover.querySelectorAll('p').some(node=>node.textContent==='已确认的截止说明'))
 assert.ok(popover.querySelectorAll('p').some(node=>node.textContent==='来源内容已变化，请核对事项。'))
 assert.equal(card.querySelectorAll('.source-tag').length,0)
})
test('stored item details remain readable offline while assistance actions are disabled',()=>{
 const {parent}=render(snapshot,{connected:false}),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date'),info=card.querySelectorAll('.source-info')[0]
 assert.ok(info)
 assert.notEqual(info.disabled,true)
 assert.equal(card.querySelectorAll('.timeline-title')[0].disabled,true)
})

test('cards express date-only pressure in the configured timezone without guessing hours or waiting age',()=>{
 const state=structuredClone(snapshot);state.life.todos.push({id:'next',title:'Tomorrow',status:'open',due:'2026-10-13',version:1},{id:'later',title:'Later',status:'open',due:'2026-10-27',version:1},{id:'done',title:'Done',status:'done',due:'2026-10-01',version:1})
 const {parent}=render(state),meta=id=>parent.querySelectorAll('article').find(node=>node.dataset.objectId===id).querySelectorAll('.timeline-meta')[0]?.textContent
 assert.equal(meta('date'),undefined);assert.equal(meta('next'),'明天到期');assert.equal(meta('later'),'还有 15 天');assert.equal(meta('past'),'已过截止 2 天');assert.equal(meta('wait'),undefined);assert.equal(meta('done'),undefined)
})
test('compact cards retain user context and original dates without repeating the date as a chip',()=>{
 const state=structuredClone(snapshot);state.life.todos[0].note='先整理用户已经确认的演示路径。';state.life.todos[0].due='2026-10-27'
 const {parent}=render(state,{compact:true}),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date')
 assert.equal(card.querySelectorAll('.timeline-note')[0]?.textContent,'先整理用户已经确认的演示路径。')
 assert.deepEqual(card.querySelectorAll('time').map(node=>node.dateTime),['2026-10-27'])
 assert.equal(card.querySelectorAll('.tag-time').length,0)
})
test('changed sources get an explicit caution and source excerpts keep their provenance label',()=>{
 const state=structuredClone(snapshot);state.life.todos[0].source_changed=true;state.life.todos[0].sources=[{type:'mail',summary:'来自原文的内容，不是用户自己的备注。'}]
 const {parent}=render(state),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date')
 assert.ok(card.querySelectorAll('.timeline-caution').length)
 assert.equal(card.querySelectorAll('.timeline-context-label')[0]?.textContent,'来源摘录')
 assert.equal(card.querySelectorAll('.timeline-note')[0]?.textContent,'来自原文的内容，不是用户自己的备注。')
})
test('importance stays an explicit versioned mutation and is separate from the main assistance action',()=>{
 const commands=[],state=structuredClone(snapshot);state.life.todos[0].importance='high'
 const {parent,starts}=render(state,{command:(...args)=>commands.push(args)}),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date'),star=card.querySelectorAll('.timeline-importance')[0]
 assert.ok(star);assert.equal(star['aria-label'],'取消重要标记');assert.equal(star['aria-pressed'],'true')
 star.listeners.click();assert.deepEqual(commands,[['life.mutate',{op:'update',kind:'todo',id:'date',expected_version:1,importance:'normal'}]])
 const action=card.querySelectorAll('.timeline-actions')[0].querySelectorAll('button')[0];assert.equal(action.textContent,'拆成行动步骤');action.listeners.click();assert.deepEqual(starts[0][0].references,[{kind:'todo',id:'date',version:1}]);assert.match(starts[0][0].text,/Draft/);assert.equal(starts[0][0].title,'Draft')
})

test('briefing retains Today and the date axis while loading without pending suggestions',()=>{
 const commands=[],state={...snapshot,life:{todos:[],goals:[]},timeline:{status:'working',cards:[]},workbench_context:{cards:[{id:'candidate',tab:'todos',title:'Review the draft',body:'A source-backed suggestion'}]}}
 const {parent}=render(state,{command:(...args)=>commands.push(args)})
 assert.equal(parent.querySelectorAll('.timeline-suggestions').length,0)
 assert.equal(parent.querySelectorAll('.timeline-axis').length,1)
 assert.equal(parent.querySelectorAll('.timeline-overview-summary').length,0)
 assert.equal(parent.querySelectorAll('button').some(n=>n.textContent==='加入待办'),false)
 assert.equal(parent.querySelectorAll('.timeline-attention').length,1)
 assert.equal(commands.length,0)
})

test('briefing keeps the date axis for briefs and lists the user todos below it under their own heading',()=>{
 const state={...snapshot,timeline:{status:'ready',cards:[]}}
 const {parent}=render(state,{now:new Date('2026-10-11T08:00:00Z'),command:()=>{}})
 assert.equal(parent.querySelectorAll('.timeline-current').length,1)
 assert.deepEqual(parent.querySelectorAll('.timeline-date-group').map(n=>n.dataset.date),['2026-10-11'],'the axis only carries briefs and today')
 assert.equal(parent.querySelectorAll('.timeline-todos-title')[0].textContent,'我的待办')
 const children=parent.querySelectorAll('.timeline-content')[0].children,heading=children.findIndex(n=>n.className==='timeline-todos-title')
 assert.ok(heading>children.findIndex(n=>n.className==='timeline-attention'),'todos sit below the briefing')
 assert.deepEqual(parent.querySelectorAll('.timeline-undated').map(n=>n.dataset.group),['overdue','soon','waiting'])
 assert.deepEqual(parent.querySelectorAll('article').filter(n=>!n.className.includes('attention')).map(n=>n.dataset.objectId).sort(),['date','past','wait'])
})
test('briefing todo list does not repeat suggestions already shown as pending cards',()=>{
 const state={...snapshot,timeline:{status:'ready',cards:[]},derived_understanding:{sources:[],suggestions:[{id:'s1',kind:'action',title:'Proposed',body:'b',refs:[]}]}}
 const {parent}=render(state,{command:()=>{}})
 assert.equal(parent.querySelectorAll('article').filter(n=>n.dataset.objectId==='s1').length,1)
})
test('a todo is completed, reopened and rescheduled with versioned life.mutate updates',()=>{
 const commands=[],state={...snapshot,timeline:{status:'ready',cards:[]}}
 const {parent}=render(state,{now:new Date('2026-10-11T08:00:00Z'),command:(...args)=>{commands.push(args);return Promise.resolve()}})
 const card=parent.querySelectorAll('article').find(n=>n.dataset.objectId==='date')
 card.querySelectorAll('button').find(n=>n.textContent==='标记完成').listeners.click()
 const select=card.querySelectorAll('select')[0];select.value='doing';select.listeners.change()
 const due=card.querySelectorAll('input')[0];due.value='2026-10-30';due.listeners.change()
 due.value='';due.listeners.change()
 assert.deepEqual(commands,[
  ['life.mutate',{op:'update',kind:'todo',id:'date',expected_version:1,status:'done'}],
  ['life.mutate',{op:'update',kind:'todo',id:'date',expected_version:1,status:'doing'}],
  ['life.mutate',{op:'update',kind:'todo',id:'date',expected_version:1,due:'2026-10-30'}],
  ['life.mutate',{op:'update',kind:'todo',id:'date',expected_version:1,due:null}]])
})
test('a done todo lands in the completed group in briefing mode and offers no done button',()=>{
 const state=structuredClone(snapshot);state.timeline={status:'ready',cards:[]};state.life.todos.push({id:'fin',title:'Finished',status:'done',due:'2026-10-09',version:2})
 const {parent}=render(state,{now:new Date('2026-10-11T08:00:00Z'),command:()=>{}})
 const group=parent.querySelectorAll('section').find(n=>n.dataset.group==='completed')
 assert.deepEqual(group.querySelectorAll('article').map(n=>n.dataset.objectId),['fin'])
 assert.ok(!group.querySelectorAll('button').some(n=>n.textContent==='标记完成'))
 assert.equal(group.querySelectorAll('select')[0].value,'done')
})

test('existing todo entries are discussed in place: no card offers a jump to a todo page, done ones included',()=>{
 const state=structuredClone(snapshot)
 state.life.todos.push({id:'done',title:'Finished',status:'done',due:'2026-10-20',version:1})
 const {parent,calls}=render(state)
 const labels=parent.querySelectorAll('button').map(n=>n.textContent)
 assert.ok(!labels.includes('查看事项'));assert.ok(!labels.includes('查看待办'))
 const doneCard=parent.querySelectorAll('article').find(n=>n.dataset.objectId==='done')
 doneCard.querySelectorAll('.timeline-title')[0].listeners.click()
 assert.deepEqual(calls,[[[{kind:'todo',id:'done',version:1}]]],'a completed entry opens a discussion, not a todo list')
 const empty=render({life:{todos:[],goals:[]},timeline:{status:'ready',cards:[]}},{compact:true})
 assert.ok(!empty.parent.querySelectorAll('button').some(n=>/待办/u.test(n.textContent)),'the empty timeline has no todo shortcut')
})

test('timeline renders synthesized attention cards even with zero todos and no direct mentions',()=>{
 const state={life:{todos:[],goals:[]},timeline:{status:'ready',cards:[{id:'signal',version:'v1',kind:'attention',status_label:'状态待核查',category:'需要关注',title:'监控仍未恢复',why_now:'告警重复出现，当前状态需核对',facts:[{label:'重复告警',tone:'warning',text:'节点告警出现两次'}],next_steps:[{title:'确认恢复时间',detail:'拿到当前状态和恢复安排'}],uncertainty:'尚未取得恢复确认',actions:[{label:'起草询问',kind:'draft'}],sources:[]}]}}
 const {parent,starts}=render(state)
 assert.equal(parent.querySelectorAll('.timeline-attention-card').length,1)
 assert.equal(parent.querySelectorAll('.timeline-attention-card')[0].dataset.kind,'attention')
 assert.equal(parent.querySelectorAll('.timeline-status-tag')[0].textContent,'状态待核查')
 assert.equal(parent.querySelectorAll('.timeline-fact')[0].dataset.tone,'warning')
 assert.equal(parent.querySelectorAll('.timeline-fact')[0].querySelectorAll('h4')[0].textContent,'重复告警')
 assert.equal(parent.querySelectorAll('.timeline-next-steps')[0].querySelectorAll('h5')[0].textContent,'确认恢复时间')
 assert.equal(parent.querySelectorAll('.timeline-axis').length,1)
 assert.equal(parent.querySelectorAll('.timeline-unplaced')[0].querySelectorAll('.timeline-attention-card').length,1)
 assert.equal(parent.querySelectorAll('.timeline-current').length,1)
 const button=parent.querySelectorAll('button').find(n=>n.textContent==='起草询问');assert.ok(button);button.listeners.click()
 assert.deepEqual(starts[0][0].references,[{kind:'timeline',id:'signal',version:'v1',interaction:'draft'}])
 assert.equal(starts[0][0].title,'监控仍未恢复')
 assert.match(starts[0][0].text,/草稿/)
 assert.equal(state.life.todos.length,0)
})

test('card type and status come from evidence fields, not title keywords or position',()=>{
 const card={id:'done',version:'v2',category:'交付',kind:'progress',status_label:'已验收',title:'Review alert handling',why_now:'The review finished',facts:[{label:'结果',tone:'positive',text:'The checks passed'}],actions:[]}
 const {parent}=render({life:{todos:[],goals:[]},timeline:{cards:[card,{...card,id:'note',kind:'insight',status_label:''}]}})
 assert.deepEqual(parent.querySelectorAll('.timeline-attention-card').map(n=>n.dataset.kind),['progress','insight'])
 assert.equal(parent.querySelectorAll('.timeline-status-tag').length,1)
 assert.equal(parent.querySelectorAll('.timeline-next-steps').length,0)
 assert.equal(parent.querySelectorAll('.timeline-caution').length,0)
})

test('briefing and compact briefing omit duplicated deadline cards',()=>{
 const state={...snapshot,timeline:{status:'ready',cards:[]}}
 const {parent}=render(state),today=parent.querySelectorAll('.timeline-current')
 assert.equal(today.length,1)
 assert.equal(parent.querySelectorAll('.timeline-attention').length,1)
 assert.deepEqual(today[0].querySelectorAll('.timeline-card').map(n=>n.dataset.objectId),[])
 assert.equal(render(state,{compact:true}).parent.querySelectorAll('.timeline-axis').length,0)
 assert.equal(render(state,{compact:true}).parent.querySelectorAll('.timeline-attention').length,1)
})

const datedBrief=(id,time)=>({id,version:'v1',kind:'progress',category:'进展',title:id,why_now:'发生了变化',facts:[],actions:[],time})
test('briefing events, source reports and deadlines occupy their real dates, unknown stays off axis',()=>{
 const cards=[datedBrief('old-event',{kind:'event',anchor_date:'2026-10-09',anchor_basis:'occurred',occurred_on:'2026-10-09'}),datedBrief('discussion',{kind:'synthesis',anchor_date:'2026-10-11',anchor_basis:'reported',last_reported_on:'2026-10-11',evidence_from:'2026-10-10',evidence_to:'2026-10-11'}),datedBrief('release',{kind:'deadline',anchor_date:'2026-10-14',anchor_basis:'deadline',due_on:'2026-10-14'}),datedBrief('unknown',null)]
 const state={...snapshot,timeline:{status:'ready',cards,updated_at:'2026-10-12T01:00:00Z'}}
 const {parent}=render(state),dates=parent.querySelectorAll('.timeline-date-group')
 assert.deepEqual(dates.map(n=>n.dataset.date),['2026-10-14','2026-10-11','2026-10-09'])
 assert.deepEqual(dates.map(n=>n.querySelectorAll('.timeline-attention-card').map(c=>c.dataset.objectId)),[['release'],['discussion'],['old-event']])
 assert.equal(parent.querySelectorAll('.timeline-unplaced')[0].querySelectorAll('.timeline-attention-card')[0].dataset.objectId,'unknown')
 assert.equal(parent.querySelectorAll('.timeline-past').length,0,'old evidence is not an overdue todo disclosure')
 assert.ok(parent.querySelectorAll('.timeline-time-label').some(n=>n.textContent.includes('距截止 2 天')))
})
test('ongoing cards show bounded report span rather than implying they lasted until today',()=>{
 const time={kind:'ongoing',anchor_date:'2026-10-11',anchor_basis:'reported',started_on:'2026-10-08',last_reported_on:'2026-10-11',evidence_from:'2026-10-08',evidence_to:'2026-10-11'}
 const {parent}=render({life:{todos:[],goals:[]},timeline:{cards:[datedBrief('incident',time)]}})
 const labels=parent.querySelectorAll('.timeline-time-label').map(n=>n.textContent).join(' ')
 assert.match(labels,/记录跨度 3 天/);assert.match(labels,/当前状态待更新/);assert.doesNotMatch(labels,/持续 4 天/)
 assert.equal(parent.querySelectorAll('.timeline-current').length,0,'an empty today placeholder does not precede the latest real briefing')
 const today=render({settings:{timezone:'UTC'},life:{todos:[],goals:[]},timeline:{cards:[datedBrief('incident',time)]}}).parent
 assert.ok(today.querySelectorAll('.timeline-time-label').every(node=>!node.textContent.includes('当前状态待更新')))
})

test('pending and timed out briefing do not claim no relevant items',()=>{
 for(const [status,error,expected] of [['queued',null,'即将整理近期信息…'],['failed','timeline_generation_timeout','整理用时较长，尚未完成，可点击刷新重试。']]){
  const {parent}=render({settings:snapshot.settings,life:{todos:[],goals:[]},timeline:{available:true,status,error,input_count:10,cards:[]}})
  const hints=parent.querySelectorAll('.hint').map(n=>n.textContent)
  assert.ok(hints.includes(expected));assert.equal(hints.some(text=>text.includes('没有足够明确')),false)
 }
})

test('same-day briefing cards put the most recent source update first',()=>{
 const time={kind:'synthesis',anchor_date:'2026-10-12',anchor_basis:'reported',last_reported_on:'2026-10-12'}
 const older={...datedBrief('morning',time),sources:[{type:'im',observed_at:'2026-10-12T01:00:00Z'}]}
 const newer={...datedBrief('afternoon',time),sources:[{type:'im',observed_at:'2026-10-12T07:00:00Z'}]}
 const {parent}=render({...snapshot,timeline:{status:'ready',cards:[older,newer]}})
 assert.deepEqual(parent.querySelectorAll('.timeline-date-group').find(node=>node.dataset.date==='2026-10-12').querySelectorAll('.timeline-attention-card').map(node=>node.dataset.objectId),['afternoon','morning'])
})


test('briefing pagination exposes every card in descending date order without truncation',()=>{
 const cards=Array.from({length:19},(_,i)=>datedBrief(String(i),{kind:'event',anchor_date:'2026-10-'+String(i+1).padStart(2,'0'),anchor_basis:'reported'}))
 const state={life:{todos:[],goals:[]},timeline:{cards,generation_id:'generation-1',updated_at:'2026-10-20T00:00:00Z'}}
 const expanded=new Set(),{parent}=render(state,{expanded})
 assert.equal(parent.querySelectorAll('.timeline-attention-card').length,8)
 parent.querySelectorAll('.timeline-load-more')[0].listeners.click()
 assert.equal(parent.querySelectorAll('.timeline-attention-card').length,16)
 parent.querySelectorAll('.timeline-load-more')[0].listeners.click()
 assert.deepEqual(parent.querySelectorAll('.timeline-attention-card').map(n=>n.dataset.objectId),Array.from({length:19},(_,i)=>String(18-i)))
 assert.equal(parent.querySelectorAll('.timeline-load-more').length,0)
 state.timeline.updated_at='2026-10-20T00:01:00Z'
 assert.equal(render(state,{expanded}).parent.querySelectorAll('.timeline-attention-card').length,19,'batch progress rerenders retain expansion')
 const compact=render(state,{compact:true}).parent
 assert.equal(compact.querySelectorAll('.timeline-attention-card').length,3)
 assert.ok(compact.querySelectorAll('.timeline-brief-count')[0].textContent.includes('19'))
})

test('partial generation keeps grounded cards visible and explains missing coverage',()=>{
 const state={life:{todos:[],goals:[]},timeline:{status:'ready',cards:[datedBrief('kept',{kind:'event',anchor_date:'2026-10-11'})],diagnostics:{failed_batches:[{batch:2,reason:'invalid_evidence'}]}}}
 const {parent}=render(state)
 assert.equal(parent.querySelectorAll('.timeline-attention-card').length,1)
 assert.equal(parent.querySelectorAll('.timeline-partial').length,1)
 assert.match(parent.querySelectorAll('.timeline-partial')[0].textContent,/部分资料尚未完成/)
})

test('briefings display name-only people tags without inventing roles or changing date order',()=>{
 const card={...datedBrief('collaboration',{kind:'event',anchor_date:'2026-10-10'}),people:[{name:'林舟',quote:'林舟负责复现',ref:'m'}]}
 const {parent}=render({life:{todos:[],goals:[]},timeline:{cards:[card]}})
 assert.deepEqual(parent.querySelectorAll('.tag-person').map(node=>node.textContent),['林舟'])
 assert.equal(parent.querySelectorAll('.timeline-people')[0]['aria-label'],'相关同事')
})

test('shared suggestions appear without a saved todo and adoption uses the shared command',()=>{
 const state={settings:{timezone:'Asia/Shanghai'},life:{todos:[],goals:[]},derived_understanding:{sources:[],suggestions:[{id:'suggestion',kind:'action',title:'Review interface',body:'The design needs review',due:'2026-10-12',todo_id:null,refs:[]}]},profile_preparation:{status:'ready'}}
 const calls=[],{parent}=render(state,{command:(...args)=>calls.push(args)})
 const card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='suggestion');assert.ok(card)
 assert.equal(card.dataset.suggested,'true')
 card.querySelectorAll('button').find(node=>node.textContent==='加入待办').listeners.click()
 assert.deepEqual(calls,[['understanding.adopt',{id:'suggestion'}]])
 assert.equal(state.life.todos.length,0)
})

test('shared suggestion preserves its original IM channel and source URL',()=>{
 const state={life:{todos:[]},derived_understanding:{sources:[{id:'message',type:'im',provider:'feishu',label:'Project chat',observed_at:'2026-10-13T03:51:00Z',url:'https://example.com/message'}],suggestions:[{id:'s',kind:'action',title:'Review',body:'Discuss the proposal',due:null,todo_id:null,refs:[{entry_id:'message',version:'1'}]}]}}
 const source=timelineGroups(state)[0].items[0].sources[0]
 assert.equal(source.type,'im');assert.equal(source.provider,'feishu');assert.equal(source.url,'https://example.com/message')
 const {parent}=render(state)
 assert.ok(parent.querySelectorAll('strong').some(node=>node.textContent==='飞书'))
})


test('unified actions and progress remain visible beside TimelineBrief and use independent commands',()=>{
 const calls=[],state={life:{todos:[],goals:[]},timeline:{status:'ready',cards:[]},derived_understanding:{sources:[],suggestions:[{id:'s',kind:'action',title:'Review',body:'Check draft',refs:[]},{id:'p',kind:'progress',title:'Finished review',body:'Review completed',todo_id:'existing',refs:[]}]}}
 const {parent}=render(state,{command:(...args)=>calls.push(args)})
 assert.equal(parent.querySelectorAll('.timeline-suggestions').length,1)
 const cards=parent.querySelectorAll('article').filter(node=>node.dataset.suggested==='true');assert.equal(cards.length,2)
 cards[0].querySelectorAll('button').find(node=>node.textContent==='加入待办').listeners.click()
 cards[1].querySelectorAll('button').find(node=>node.textContent==='确认进展').listeners.click()
 assert.deepEqual(calls,[['understanding.adopt',{id:'s'}],['understanding.adopt',{id:'p'}]])
 assert.equal(parent.querySelectorAll('.timeline-axis').length,1)
})

test('historical cards label prior status, assessment and suggestions without shifting the event date',()=>{
 const card={id:'history',version:'v1',kind:'deadline',status_label:'今天截止',category:'交付',title:'Release',why_now:'今天需要交付',facts:[{text:'Recorded release date'}],next_steps:[{title:'确认',detail:'今天核对'}],sources:[],actions:[],time:{as_of:'2026-10-11',anchor_date:'2026-10-11',anchor_basis:'deadline',due_on:'2026-10-11',kind:'deadline'}}
 const {parent}=render({...snapshot,timeline:{status:'ready',cards:[card]}})
 const node=parent.querySelectorAll('.timeline-attention-card')[0]
 assert.equal(node.dataset.historical,'true')
 assert.equal(node.querySelectorAll('.timeline-status-tag')[0].textContent,'当时状态：今天截止')
 assert.equal(node.querySelectorAll('.timeline-attention-reason')[0].querySelectorAll('span')[0].textContent,'当时判断')
 assert.equal(node.querySelectorAll('.timeline-followups')[0].querySelectorAll('h4')[0].textContent,'当时建议')
 const historyNote=node.querySelectorAll('.timeline-history-note')[0].textContent
 assert.ok(historyNote.startsWith('整理于 ')&&historyNote.includes('11')&&!historyNote.includes('2026-10-11'))
 assert.ok(node.querySelectorAll('.timeline-time-label').some(n=>n.textContent==='原截止已过 1 天，结果以最新记录为准'))
 assert.deepEqual(parent.querySelectorAll('.timeline-date-group').map(n=>n.dataset.date),['2026-10-11'])
})

test('deleted-source history keeps its content and date while disabling source actions',()=>{
 const card={id:'saved',version:'v1',category:'项目',title:'Saved update',why_now:'Original assessment',facts:[{text:'Original successful summary'}],sources:[],actions:[{label:'讨论',kind:'discuss'}],sources_available:false,historical:true,time:{as_of:'2026-10-11',anchor_date:'2026-10-11',kind:'event'}}
 const {parent}=render({...snapshot,timeline:{status:'failed',cards:[card]}},{command:()=>{}})
 const node=parent.querySelectorAll('.timeline-attention-card')[0]
 assert.equal(node.querySelectorAll('h3')[0].textContent,'Saved update')
 assert.equal(node.querySelectorAll('.timeline-source-unavailable')[0].textContent,'原始来源已不可用')
 assert.ok(!node.querySelectorAll('button').some(button=>button.textContent==='讨论'))
 assert.ok(node.querySelectorAll('button').some(button=>button.textContent==='隐藏'))
 assert.deepEqual(parent.querySelectorAll('.timeline-date-group').map(n=>n.dataset.date),['2026-10-11'])
})

const briefCard=(overrides={})=>({id:'brief',version:'v1',kind:'attention',category:'发布',title:'长'.repeat(60),why_now:'演示临近',facts:[],actions:[{label:'起草状态说明',kind:'draft'},{label:'一起分析',kind:'discuss'}],sources:[],...overrides})
test('a draft briefing action opens a new conversation and a discuss action keeps the main conversation',()=>{
 const {parent,calls,starts}=render({life:{todos:[],goals:[]},timeline:{cards:[briefCard()]}})
 const draft=parent.querySelectorAll('button').find(n=>n.textContent==='起草状态说明'),discuss=parent.querySelectorAll('button').find(n=>n.textContent==='一起分析')
 assert.ok(draft&&discuss)
 draft.listeners.click();assert.equal(calls.length,0);assert.equal(starts.length,1)
 assert.deepEqual(starts[0][0].references,[{kind:'timeline',id:'brief',version:'v1',interaction:'draft'}]);assert.equal(starts[0][0].title.length,40)
 assert.match(starts[0][0].text,/草稿/)
 discuss.listeners.click();assert.equal(starts.length,1);assert.deepEqual(calls[0][0],[{kind:'timeline',id:'brief',version:'v1',interaction:'discuss'}]);assert.match(calls[0][1],/只讨论/)
})
test('only buttons that open a conversation carry the marker, and the generated label is untouched',()=>{
 const {parent}=render({life:{todos:[],goals:[]},timeline:{cards:[briefCard()]}})
 const draft=parent.querySelectorAll('button').find(n=>n.textContent==='起草状态说明'),discuss=parent.querySelectorAll('button').find(n=>n.textContent==='一起分析')
 assert.equal(draft.dataset.opensConversation,'true');assert.equal(draft.title,'会新开一个对话');assert.equal(draft['aria-label'],'起草状态说明 · 会新开一个对话')
 assert.equal(discuss.dataset.opensConversation,undefined);assert.notEqual(discuss.title,'会新开一个对话');assert.equal(discuss['aria-label'],undefined)
 setLanguage('en')
 try{
  const en=render({life:{todos:[],goals:[]},timeline:{cards:[briefCard()]}}).parent.querySelectorAll('button').find(n=>n.textContent==='起草状态说明')
  assert.equal(en.title,'Opens a new conversation');assert.equal(en['aria-label'],'起草状态说明 · Opens a new conversation')
 }finally{setLanguage('zh-CN')}
})
test('historical or sourceless briefing cards offer no conversation actions',()=>{
 for(const overrides of [{historical:true},{sources_available:false}]){
  const {parent}=render({life:{todos:[],goals:[]},timeline:{cards:[briefCard(overrides)]}})
  assert.equal(parent.querySelectorAll('button').some(n=>n.textContent==='起草状态说明'),false)
 }
})
test('every todo status primary action opens a conversation about that exact todo while the title still discusses',()=>{
 const todos=[{id:'a',title:'Open one',status:'open',version:1,due:null},{id:'b',title:'Doing one',status:'doing',version:2},{id:'c',title:'Waiting one',status:'waiting',version:3},{id:'d',title:'Changed',status:'open',version:4,source_changed:true}]
 const {parent,calls,starts}=render({life:{todos,goals:[]}})
 for(const todo of todos){
  const card=parent.querySelectorAll('article').find(node=>node.dataset.objectId===todo.id),primary=card.querySelectorAll('button').find(node=>node.pendingKey===undefined&&node.className==='soft'&&/拆成|整理|起草|核对/u.test(node.textContent))
  assert.ok(primary,todo.id);assert.equal(primary.dataset.opensConversation,'true');primary.listeners.click()
  assert.deepEqual(starts.at(-1)[0].references,[{kind:'todo',id:todo.id,version:todo.version}]);assert.equal(starts.at(-1)[0].title,todo.title)
 }
 assert.equal(starts.length,4);assert.equal(calls.length,0)
 parent.querySelectorAll('.timeline-title')[0].listeners.click();assert.equal(calls.length,1);assert.equal(starts.length,4)
})
