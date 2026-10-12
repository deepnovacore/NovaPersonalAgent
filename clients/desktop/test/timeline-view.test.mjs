import test,{beforeEach,afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {timelineGroups,renderTimeline} from '../src/renderer/timeline-view.mjs'
import {disposeSources} from '../src/renderer/source-popover.mjs'
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
 focus(){document.activeElement=this}
 querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tag===selector)?[node]:[],...node.querySelectorAll(selector)])}
}
const previousDocument=globalThis.document
beforeEach(()=>{globalThis.document={activeElement:null,listeners:new Map(),createElement:tag=>new Element(tag),addEventListener(event,handler){if(!this.listeners.has(event))this.listeners.set(event,new Set());this.listeners.get(event).add(handler)},removeEventListener(event,handler){this.listeners.get(event)?.delete(handler)}}})
afterEach(()=>{disposeSources();globalThis.document=previousDocument})
function render(state,options={}){
 const parent=new Element('main'),calls=[],el=(...args)=>new Element(...args)
 const button=(text,click,host)=>{const node=el('button',text);node.addEventListener('click',click);host.append(node);return node}
 renderTimeline(parent,{snapshot:state,el,button,discuss:(...args)=>calls.push(args),openTodos(){},now:new Date('2026-10-11T18:00:00Z'),...options})
 return {parent,calls}
}
test('dated cards share chronological date nodes while undated and completed cards stay off the axis',()=>{
 const state=structuredClone(snapshot)
 state.life.todos.push({id:'same-day',title:'Second draft',status:'open',due:'2026-10-12',version:2},{id:'future',title:'Next',status:'waiting',due:'2026-10-14',version:1},{id:'done',title:'Finished',status:'done',due:'2026-10-20',version:1})
 const {parent,calls}=render(state),dates=parent.querySelectorAll('.timeline-date-group')
 assert.deepEqual(dates.map(node=>node.dataset.date),['2026-10-10','2026-10-12','2026-10-14'])
 assert.deepEqual(dates[1].querySelectorAll('article').map(node=>node.dataset.objectId),['date','same-day'])
 const timed=parent.querySelectorAll('.timeline-axis').flatMap(node=>node.querySelectorAll('article'))
 assert.deepEqual(timed.map(node=>node.dataset.objectId),['past','date','same-day','future'])
 assert.equal(parent.querySelectorAll('article').length,6)
 dates[1].querySelectorAll('.timeline-title')[0].listeners.click()
 assert.deepEqual(calls,[[[{kind:'todo',id:'date',version:1}]]])
})
test('Today uses the configured local date and remains present without any due items',()=>{
 const state={settings:{timezone:'Asia/Shanghai'},life:{todos:[],goals:[]}}
 const {parent}=render(state),dates=parent.querySelectorAll('.timeline-date-group')
 assert.equal(dates.length,1)
 assert.equal(dates[0].dataset.date,'2026-10-12')
 assert.equal(parent.querySelectorAll('.timeline-current-label')[0]?.textContent,'Today')
 assert.equal(parent.querySelectorAll('time')[0]?.dateTime,'2026-10-12')
 assert.equal(parent.querySelectorAll('article').length,0)
})
test('past-due disclosure keeps Today visible by default and preserves the user expansion',()=>{
 const expanded=new Set(),{parent}=render(snapshot,{expanded}),past=parent.querySelectorAll('.timeline-past')[0]
 assert.ok(past)
 assert.equal(past.open,false)
 past.open=true;past.listeners.toggle()
 assert.equal(render(snapshot,{expanded}).parent.querySelectorAll('.timeline-past')[0].open,true)
})
test('compact sidebar retains its groups without date gutters or a current-day empty node',()=>{
 const {parent}=render(snapshot,{compact:true})
 assert.equal(parent.querySelectorAll('.timeline-axis').length,0)
 assert.equal(parent.querySelectorAll('.timeline-current-label').length,0)
 assert.deepEqual(parent.querySelectorAll('.timeline-group').map(node=>node.dataset.group),['overdue','current','waiting'])
 assert.equal(parent.querySelectorAll('article').length,3)
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
 assert.equal(card.querySelectorAll('.source-tag').length,1)
})
test('stored item details remain readable offline while assistance actions are disabled',()=>{
 const {parent}=render(snapshot,{connected:false}),card=parent.querySelectorAll('article').find(node=>node.dataset.objectId==='date'),info=card.querySelectorAll('.source-info')[0]
 assert.ok(info)
 assert.notEqual(info.disabled,true)
 assert.equal(card.querySelectorAll('.timeline-title')[0].disabled,true)
})
