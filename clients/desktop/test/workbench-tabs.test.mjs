import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setLanguage} from '../src/renderer/locale.mjs'
import {mountWorkspaceTabs,workspaceTabForKey} from '../src/renderer/workbench-tabs.mjs'
class Node{constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.attrs={};this.focused=0}append(...c){this.children.push(...c)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,v){this.listeners[k]=v}focus(){this.focused++}scrollIntoView(){this.scrolled=(this.scrolled??0)+1}}
const dom={createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag)},all=n=>[n,...n.children.flatMap(all)]
test('workspace tabs wrap horizontally and leave vertical arrow keys to the panel',()=>{
 assert.equal(workspaceTabForKey('timeline','ArrowLeft'),'profile');assert.equal(workspaceTabForKey('profile','ArrowRight'),'timeline');assert.equal(workspaceTabForKey('ideas','ArrowRight'),'goals')
 assert.equal(workspaceTabForKey('x','Home'),'timeline');assert.equal(workspaceTabForKey('x','End'),'profile');assert.equal(workspaceTabForKey('todos','ArrowDown'),null);assert.equal(workspaceTabForKey('nope','ArrowRight'),null)
})
test('the right tablist exposes visible labels, one active page, keyboard focus and task counts',()=>{
 const root=new Node('body'),selected=[],tabs=mountWorkspaceTabs(root,{document:dom,onSelect:id=>{selected.push(id);tabs.select(id)}})
 const nodes=all(root),buttons=nodes.filter(n=>n.tag==='button')
 assert.deepEqual(buttons.map(b=>b.children.find(n=>n.className==='workspace-tab-label').textContent),['时间线','待办','想法','目标','资讯','任务','Profile'])
 assert.equal(nodes.find(n=>n.attrs.role==='tablist').attrs['aria-orientation'],'horizontal')
 tabs.select('timeline');assert.equal(buttons[0].scrolled,1);tabs.select('timeline');assert.equal(buttons[0].scrolled,1);assert.equal(buttons[0].tabIndex,0);assert.equal(buttons[1].tabIndex,-1);assert.equal(buttons[0].attrs['aria-controls'],'workbench-panel')
 let prevented=0;buttons[0].listeners.keydown({key:'ArrowRight',preventDefault:()=>prevented++})
 assert.deepEqual(selected,['todos']);assert.equal(buttons[1].focused,1);assert.equal(prevented,1);assert.equal(tabs.active,'todos');assert.equal(buttons[1].scrolled,1);assert.equal(buttons.filter(b=>b.attrs['aria-selected']==='true').length,1)
 buttons[1].listeners.keydown({key:'Tab',preventDefault:()=>prevented++});assert.equal(prevented,1)
 const badge=buttons[5].children.find(n=>n.className==='workspace-tab-badge');tabs.badge('tasks',2);assert.equal(badge.hidden,false);assert.equal(badge.textContent,'2');tabs.badge('tasks',0);assert.equal(badge.hidden,true)
})
test('English workspace navigation uses the same language for labels and accessible names',()=>{
 setLanguage('en')
 try{
  const root=new Node('body');mountWorkspaceTabs(root,{document:dom,onSelect:()=>{}})
  const buttons=all(root).filter(n=>n.tag==='button')
  assert.deepEqual(buttons.map(b=>b.children.find(n=>n.className==='workspace-tab-label').textContent),['Timeline','To-dos','Ideas','Goals','Feeds','Task','Profile'])
  assert(buttons.every(b=>!/[\u4e00-\u9fff]/u.test(b.attrs['aria-label'])))
 }finally{setLanguage('zh-CN')}
})
