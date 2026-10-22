import test from 'node:test'
import assert from 'node:assert/strict'
import {skillEntries,filterSkills,renderSkillsPage} from '../src/renderer/skills-page.mjs'

const status={modules:{search:{enabled:true},camera:{enabled:false},coding:{enabled:true,reason:'x'},knowledge:{enabled:true}},servers:[{name:'notes',status:'ok'},{name:'broken',status:'failed'},{name:'idle',status:'disabled'}]}

test('system skills lead with Computer Use; MCP servers are personal with their own state',()=>{
 const entries=skillEntries(status)
 assert.deepEqual(entries.filter(e=>e.group==='system').map(e=>[e.id,e.state]),[['computer-use','session'],['search','on'],['camera','off'],['coding','degraded'],['knowledge','on']])
 assert.deepEqual(entries.filter(e=>e.group==='personal').map(e=>[e.name,e.state]),[['notes','on'],['broken','failed'],['idle','off']])
})
test('without registry status Computer Use is still listed and nothing else is invented',()=>{
 assert.deepEqual(skillEntries(null).map(e=>e.id),['computer-use'])
})
test('search matches name or description inside the selected group only',()=>{
 const entries=skillEntries(status)
 assert.deepEqual(filterSkills(entries,'system','截图').map(e=>e.id),['computer-use'])
 assert.deepEqual(filterSkills(entries,'system','NOTES'),[])
 assert.deepEqual(filterSkills(entries,'personal','notes').map(e=>e.name),['notes'])
})

class Node{
 constructor(tag,text){this.tag=tag;this.textContent=text??'';this.children=[];this.attrs={};this.listeners={};this.dataset={};this.value='';this.disabled=false;this.className=''}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=[...nodes]}
 prepend(...nodes){this.children.unshift(...nodes)}
 get classList(){return {add(){}}}
 setAttribute(k,v){this.attrs[k]=v}
 addEventListener(k,f){this.listeners[k]=f}
}
const walk=node=>[node,...node.children.flatMap(walk)]
function mount(state){
 globalThis.document={createElementNS:(ns,tag)=>new Node(tag)}
 const el=(tag,text,className)=>Object.assign(new Node(tag,text),className?{className}:{})
 const calls=[],panel=new Node('section')
 const button=(label,action,parent)=>{const b=el('button',label);b.listeners.click=action;parent.append(b);return b}
 renderSkillsPage(panel,{el,button,state,refresh:()=>calls.push('refresh'),manage:()=>calls.push('manage')})
 return {panel,calls,cards:()=>walk(panel).filter(n=>n.className==='skill-card')}
}
test('each skill gets its own inline icon and the group tabs and search re-filter without a rerender',()=>{
 const state={status,loading:false,error:'',group:'system',query:''}
 const m=mount(state)
 assert.equal(m.cards().length,5)
 const paths=m.cards().map(card=>card.children[0].children[0]?.children[0]?.attrs.d)
 assert(paths.every(Boolean));assert.equal(new Set(paths).size,5)
 const [systemTab,personalTab]=walk(m.panel).find(n=>n.className==='skills-tabs').children
 personalTab.listeners.click();assert.equal(m.cards().length,3);assert.equal(personalTab.attrs['aria-pressed'],'true');assert.equal(systemTab.attrs['aria-pressed'],'false')
 const search=walk(m.panel).find(n=>n.className==='skills-search');search.value='bro';search.listeners.input();assert.deepEqual(m.cards().map(c=>c.children[1].children[0].textContent),['broken'])
 assert.equal(state.query,'bro')
})
test('empty and loading states explain themselves and the manage button is wired',()=>{
 const loading=mount({status:null,loading:true,error:'',group:'personal',query:''})
 assert.equal(loading.cards().length,0);assert(walk(loading.panel).some(n=>n.textContent==='正在读取技能…'))
 const failed=mount({status:null,loading:false,error:'暂时无法读取技能，请稍后刷新。',group:'personal',query:''})
 assert(walk(failed.panel).some(n=>n.textContent==='暂时无法读取技能，请稍后刷新。'))
 walk(failed.panel).find(n=>n.textContent==='在设置中管理能力').listeners.click();assert.deepEqual(failed.calls,['manage'])
})
