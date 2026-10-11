import test from 'node:test'
import assert from 'node:assert/strict'
import {timelineGroups} from '../src/renderer/timeline-view.mjs'
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
