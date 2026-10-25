import test from 'node:test'
import assert from 'node:assert/strict'
import {skillEntries,filterSkills,renderSkillsPage} from '../src/renderer/skills-page.mjs'

const skills=[{id:'computer-use',name:'Computer Use',description:'真实截图与鼠标键盘操作，在 Build 会话中按需开启'},{id:'notes',name:'',description:'整理笔记'}]

test('every skills folder becomes an entry; only Computer Use is per-session',()=>{
 assert.deepEqual(skillEntries(skills).map(e=>[e.id,e.name,e.state]),[['computer-use','Computer Use','session'],['notes','notes','on']])
 assert.deepEqual(skillEntries(null),[])
})
test('search matches name or description',()=>{
 const entries=skillEntries(skills)
 assert.deepEqual(filterSkills(entries,'截图').map(e=>e.id),['computer-use'])
 assert.deepEqual(filterSkills(entries,'NOTES').map(e=>e.id),['notes'])
 assert.deepEqual(filterSkills(entries,'zzz'),[])
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
 renderSkillsPage(panel,{el,button,state,refresh:()=>calls.push('refresh')})
 return {panel,calls,cards:()=>walk(panel).filter(n=>n.className==='skill-card')}
}
test('cards render per skill, search re-filters without a rerender, and there are no group tabs',()=>{
 const state={skills,loading:false,error:'',query:''}
 const m=mount(state)
 assert.equal(m.cards().length,2)
 assert.equal(walk(m.panel).some(n=>n.className==='skills-tabs'),false)
 const search=walk(m.panel).find(n=>n.className==='skills-search');search.value='note';search.listeners.input()
 assert.deepEqual(m.cards().map(c=>c.children[1].children[0].textContent),['notes'])
 assert.equal(state.query,'note')
})
test('empty, loading and error states explain themselves and refresh is wired',()=>{
 const text=m=>walk(m.panel).map(n=>n.textContent)
 assert(text(mount({skills:[],loading:true,error:'',query:''})).includes('正在读取技能…'))
 assert(text(mount({skills:null,loading:false,error:'暂时无法读取技能，请稍后刷新。',query:''})).includes('暂时无法读取技能，请稍后刷新。'))
 const empty=mount({skills:[],loading:false,error:'',query:''})
 assert(text(empty).includes('还没有技能。把带 SKILL.md 的文件夹放进技能目录，刷新即可。'))
 walk(empty.panel).find(n=>n.textContent==='刷新').listeners.click();assert.deepEqual(empty.calls,['refresh'])
})
