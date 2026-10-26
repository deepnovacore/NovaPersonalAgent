import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountExecutorFloat} from '../src/renderer/executor-float.mjs'

class Element{
 constructor(name,text=''){this.name=name;this.textContent=text;this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={};this.className='';this.title='';this.dataset={}}
 append(...children){this.children.push(...children)}
 replaceChildren(...children){this.children=children}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
}
const el=(name,text,className)=>Object.assign(new Element(name,text),{className:className??''})
const button=(label,onClick,parent)=>{const node=el('button',label);node.listeners.click=onClick;parent?.append(node);return node}
const all=node=>[node,...node.children.flatMap(all)]
const task=(id,phase='working',extra={})=>({work_id:id,executor:'codex',project:'demo',title:'任务 '+id,phase,summary:'正在运行测试',ts:1,...extra})
const frame=(tasks,revision=1)=>({type:'executor.tasks',revision,active_project:'demo',tasks})

function fixture(){
 const opened=[],parent=el('div')
 const float=mountExecutorFloat(parent,{el,button,openTask:id=>opened.push(id),taskFor:work=>work==='a'?'durable-a':null})
 return {float,opened,root:parent.children[0]}
}

test('a running executor task floats collapsed at the vertical middle and expands to its latest output',()=>{
 const f=fixture();assert.equal(f.root.hidden,true)
 f.float.receive(frame([task('a')]))
 assert.equal(f.root.hidden,false);assert.equal(f.root.dataset.expanded,'false')
 const pill=all(f.root).find(n=>n.className==='executor-float-pill');assert.match(pill.textContent,/codex/);assert.match(pill.textContent,/进行中/)
 assert.equal(all(f.root).some(n=>n.textContent==='正在运行测试'),false,'collapsed shows no output lines')
 pill.listeners.click();assert.equal(f.root.dataset.expanded,'true')
 assert.ok(all(f.root).some(n=>n.textContent==='正在运行测试'));assert.ok(all(f.root).some(n=>n.textContent==='任务 a'))
})

test('finished tasks leave the float, a failure stays until the next snapshot, and the open button resolves the durable task',()=>{
 const f=fixture()
 f.float.receive(frame([task('a'),task('b','completed')]))
 all(f.root).find(n=>n.className==='executor-float-pill').listeners.click()
 assert.equal(all(f.root).filter(n=>n.className==='executor-float-task').length,1,'the completed task is gone')
 f.float.receive(frame([task('a','failed')],2));assert.equal(f.root.hidden,false)
 all(f.root).find(n=>n.textContent==='查看详情').listeners.click();assert.deepEqual(f.opened,['durable-a'])
 f.float.receive(frame([],3));assert.equal(f.root.hidden,true)
})

test('a stale or invalid snapshot is ignored',()=>{
 const f=fixture();f.float.receive(frame([task('a')],5));f.float.receive(frame([],4));assert.equal(f.root.hidden,false)
 f.float.receive({type:'executor.tasks',revision:6,tasks:'nope'});assert.equal(f.root.hidden,false)
})
