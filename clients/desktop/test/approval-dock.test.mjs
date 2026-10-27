import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountApprovalDock} from '../src/renderer/approval-dock.mjs'

class Element{
 constructor(name,text=''){this.name=name;this.textContent=text;this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={};this.className=''}
 append(...children){this.children.push(...children)}
 replaceChildren(...children){this.children=children}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
}
const el=(name,text,className)=>Object.assign(new Element(name,text),{className:className??''})
const button=(label,onClick,parent)=>{const node=el('button',label);node.listeners.click=onClick;parent?.append(node);return node}
const all=node=>[node,...node.children.flatMap(all)]
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0))}

function fixture({approvals=[],selectedId='chat:main',connected=true}={}){
 const commands=[]
 const c={connected,selectedId,snapshot:{pending_approvals:approvals},command:async(method,params)=>{commands.push([method,params]);return {accepted:true}}}
 const parent=el('div'),dock=mountApprovalDock(parent,{c,el,button,run:callback=>callback()})
 return {c,commands,dock,root:parent.children[0],labels:()=>all(parent).filter(n=>n.name==='button').map(n=>n.textContent)}
}
const row=(overrides={})=>({approval_id:'a1',conversation_id:'chat:main',summary:'Codex 请求执行一条工作区命令。',queued:false,...overrides})

test('a pending approval for the selected conversation shows its summary with allow and deny buttons',async()=>{
 const f=fixture({approvals:[row()]});f.dock.update()
 assert.equal(f.root.hidden,false)
 assert.ok(all(f.root).some(n=>n.textContent==='Codex 请求执行一条工作区命令。'))
 assert.deepEqual(f.labels(),['允许','拒绝'])
 f.root.children.flatMap(all).find(n=>n.textContent==='允许').listeners.click();await flush()
 assert.deepEqual(f.commands,[['conversations.approve',{id:'chat:main',approval_id:'a1',approved:true}]])
})

test('deny sends approved:false',async()=>{
 const f=fixture({approvals:[row()]});f.dock.update()
 all(f.root).find(n=>n.textContent==='拒绝').listeners.click();await flush()
 assert.deepEqual(f.commands,[['conversations.approve',{id:'chat:main',approval_id:'a1',approved:false}]])
})

test('approvals of other conversations, or without an owning conversation, are not shown',()=>{
 const f=fixture({approvals:[row({conversation_id:'other'}),row({approval_id:'a2',conversation_id:null})]});f.dock.update()
 assert.equal(f.root.hidden,true);assert.deepEqual(f.labels(),[])
})

test('buttons are disabled while offline or while the approval is queued behind another',()=>{
 const offline=fixture({approvals:[row()],connected:false});offline.dock.update()
 assert.ok(all(offline.root).filter(n=>n.name==='button').every(n=>n.disabled))
 const queued=fixture({approvals:[row({queued:true})]});queued.dock.update()
 assert.ok(all(queued.root).filter(n=>n.name==='button').every(n=>n.disabled))
})

test('the dock rebuilds only when the approvals change, so a focused button survives unrelated updates',()=>{
 const f=fixture({approvals:[row()]});f.dock.update()
 const first=all(f.root).find(n=>n.textContent==='允许');f.dock.update()
 assert.equal(all(f.root).find(n=>n.textContent==='允许'),first)
 f.c.snapshot={pending_approvals:[]};f.dock.update()
 assert.equal(f.root.hidden,true)
})
