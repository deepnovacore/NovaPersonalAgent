import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mountRail,railItemForKey,RAIL_IDS,RAIL_ITEMS} from '../src/renderer/workbench-rail.mjs'
class Node{constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.attrs={};this.focused=0}append(...c){this.children.push(...c)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,v){this.listeners[k]=v}focus(){this.focused++}}
const dom={createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag)}
const all=n=>[n,...n.children.flatMap(all)]
test('keyboard mapping wraps vertically and ignores other keys',()=>{
 assert.equal(railItemForKey('nova','ArrowUp'),'profile');assert.equal(railItemForKey('profile','ArrowDown'),'nova');assert.equal(railItemForKey('ideas','ArrowDown'),'goals')
 assert.equal(railItemForKey('x','Home'),'nova');assert.equal(railItemForKey('x','End'),'profile');assert.equal(railItemForKey('todos','Enter'),null);assert.equal(railItemForKey('nope','ArrowDown'),null)
 assert.deepEqual(RAIL_IDS,['nova','timeline','todos','ideas','goals','feeds','tasks','profile'])
})
test('rail buttons keep the brand label as text, a single current item and badges',()=>{
 const root=new Node('body'),selected=[],footerClicks=[]
 const rail=mountRail(root,{document:dom,onSelect:id=>selected.push(id),footer:[{label:'设置',title:'打开设置',icon:'M0 0',onClick:()=>footerClicks.push(1)}]})
 const buttons=all(root).filter(n=>n.tag==='button');assert.equal(buttons.length,RAIL_ITEMS.length+1)
 const labels=buttons.map(b=>b.children.find(c=>c.className==='rail-label').textContent);assert.deepEqual(labels,['Nova','Timeline','Todos','Ideas','Goals','Feeds','任务','Profile','设置'])
 assert.equal(buttons[0].attrs['aria-label'],'Nova · 主对话');assert.ok(all(buttons[0]).some(n=>n.tag==='svg'&&n.attrs['aria-hidden']==='true'))
 rail.select('goals');assert.deepEqual(buttons.slice(0,8).map(b=>b.attrs['aria-current']),['false','false','false','false','true','false','false','false']);assert.equal(buttons[4].tabIndex,0);assert.equal(buttons[0].tabIndex,-1);assert.equal(rail.active,'goals')
 buttons[6].listeners.click();buttons[8].listeners.click();assert.deepEqual(selected,['tasks']);assert.deepEqual(footerClicks,[1])
 let prevented=0;buttons[4].listeners.keydown({key:'ArrowDown',preventDefault:()=>prevented++});assert.deepEqual(selected,['tasks','feeds']);assert.equal(prevented,1);assert.equal(buttons[5].focused,1)
 buttons[4].listeners.keydown({key:'Tab',preventDefault:()=>prevented++});assert.equal(prevented,1)
 const badge=all(buttons[6]).find(n=>n.className==='rail-badge');rail.badge('tasks',2);assert.equal(badge.hidden,false);assert.equal(badge.textContent,'2');rail.badge('tasks',0);assert.equal(badge.hidden,true);rail.badge('nope',3)
})
