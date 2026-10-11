import test from 'node:test'
import assert from 'node:assert/strict'
import {timelineGroups,renderTimeline} from '../src/renderer/timeline-view.mjs'
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
 constructor(tag,text,className=''){this.tag=tag;this.textContent=text??'';this.className=className;this.children=[];this.dataset={};this.listeners={}}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
 setAttribute(key,value){this[key]=value}
 addEventListener(event,handler){this.listeners[event]=handler}
 querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tag===selector)?[node]:[],...node.querySelectorAll(selector)])}
}
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
