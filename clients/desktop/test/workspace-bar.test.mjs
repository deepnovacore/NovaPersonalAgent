import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountWorkspaceBar,workspaceLabel} from '../src/renderer/workspace-bar.mjs'

class Element{
 constructor(name,text=''){this.name=name;this.textContent=text;this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={};this.className='';this.title=''}
 append(...children){this.children.push(...children)}
 replaceChildren(...children){this.children=children}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
}
const el=(name,text,className)=>Object.assign(new Element(name,text),{className:className??''})
const button=(label,onClick,parent)=>{const node=el('button',label);node.listeners.click=onClick;parent?.append(node);return node}
const all=node=>[node,...node.children.flatMap(all)]
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}

function fixture({defaultPath='/Users/me/.nova/workspace/default',chosen=null,visible=true}={}){
 const states=new Map(),calls=[]
 const c={connected:true,selectedId:'chat:main',state:id=>{if(!states.has(id))states.set(id,{});return states.get(id)},changed(){calls.push('changed')}}
 const api={defaultWorkspace:async()=>defaultPath,chooseBuildDirectory:async()=>chosen}
 const parent=el('div'),state={visible},bar=mountWorkspaceBar(parent,{c,el,button,run:callback=>callback(),api,visible:()=>state.visible})
 return {c,bar,state,root:parent.children[0],calls}
}

test('the folder label is the last path segment, with a friendly name for the default workspace',()=>{
 assert.equal(workspaceLabel('/Users/me/projects/xiaohuang-mechanic','/Users/me/.nova/workspace/default'),'xiaohuang-mechanic')
 assert.equal(workspaceLabel('/Users/me/.nova/workspace/default','/Users/me/.nova/workspace/default'),'默认工作区')
 assert.equal(workspaceLabel('C:\\Users\\me\\proj\\app\\','C:\\x'),'app')
 assert.equal(workspaceLabel(null,null),'选择工作区')
})

test('the default workspace is used until a folder is chosen, and the bar hides outside Build',async()=>{
 const f=fixture();await flush();f.bar.update()
 assert.equal(f.bar.value(),'/Users/me/.nova/workspace/default')
 assert.ok(all(f.root).some(n=>n.textContent==='默认工作区'));assert.ok(all(f.root).some(n=>n.textContent==='本机'))
 f.state.visible=false;f.bar.update();assert.equal(f.root.hidden,true)
})

test('choosing a folder stores it per conversation, and cancelling keeps the previous one',async()=>{
 const f=fixture({chosen:'/Users/me/projects/demo'});await flush()
 all(f.root).find(n=>n.name==='button'&&n.className.includes('workspace-folder')).listeners.click();await flush()
 assert.equal(f.bar.value(),'/Users/me/projects/demo');assert.equal(f.c.state('chat:main').workspace,'/Users/me/projects/demo')
 assert.ok(all(f.root).some(n=>n.textContent==='demo'))
 const cancelled=fixture({chosen:null});await flush()
 all(cancelled.root).find(n=>n.name==='button'&&n.className.includes('workspace-folder')).listeners.click();await flush()
 assert.equal(cancelled.bar.value(),'/Users/me/.nova/workspace/default')
})

test('a default workspace that is not known at mount time is picked up once the host has it',async()=>{
 const states=new Map(),answers=[null,null,'/Users/me/.nova/workspace/default']
 const c={connected:true,selectedId:'chat:main',state:id=>{if(!states.has(id))states.set(id,{});return states.get(id)},changed(){}}
 const api={defaultWorkspace:async()=>answers.length?answers.shift():'/Users/me/.nova/workspace/default',chooseBuildDirectory:async()=>null}
 const parent=el('div'),bar=mountWorkspaceBar(parent,{c,el,button,run:callback=>callback(),api,visible:()=>true})
 await flush();bar.update();assert.equal(bar.value(),null,'the host had no workspace at mount')
 assert.ok(all(parent.children[0]).some(n=>n.textContent==='选择工作区'))
 bar.update();await flush();bar.update();await flush()
 assert.equal(bar.value(),'/Users/me/.nova/workspace/default')
 assert.ok(all(parent.children[0]).some(n=>n.textContent==='默认工作区'))
 const calls=answers.length;bar.update();bar.update();await flush();assert.equal(answers.length,calls,'it stops asking once it has the answer')
})
