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
