import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountWorkspaceBar,workspaceLabel} from '../src/renderer/workspace-bar.mjs'
class Element{
 constructor(name,text=''){this.name=name;this.textContent=text;this.children=[];this.listeners={};this.hidden=false;this.attributes={}}
 append(...children){this.children.push(...children)}
 replaceChildren(...children){this.children=children}
 setAttribute(k,v){this.attributes[k]=v}
 addEventListener(k,f){this.listeners[k]=f}
}
const el=(name,text,className)=>Object.assign(new Element(name,text),{className:className??''})
const button=(label,click,parent)=>{const n=el('button',label);n.listeners.click=click;parent.append(n);return n}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(){
 const states=new Map(),calls=[],items=[{workspace_id:'w0',name:'default',is_default:true},{workspace_id:'w1',name:'Demo',is_default:false}]
 const c={connected:true,selectedId:'a',changed(){},state(id){if(!states.has(id))states.set(id,{});return states.get(id)},async command(method,p){calls.push([method,p]);if(method==='workspaces.list')return items;const item={workspace_id:'w2',name:p.name,is_default:false};items.push(item);return item}}
 const parent=el('main'),visible={value:true},bar=mountWorkspaceBar(parent,{c,el,button,run:f=>f(),api:{chooseBuildDirectory:async()=>'/private/folder/demo'},visible:()=>visible.value});bar.update()
 return {c,calls,bar,visible,select:bar.element.children[0]}
}
test('managed default, selection, creation and explicit advanced folder keep paths out of labels',async()=>{
 const f=fixture();await flush();assert.deepEqual(f.bar.value(),{workspace_id:'w0'})
 f.select.value='w1';await f.select.listeners.change();assert.deepEqual(f.bar.value(),{workspace_id:'w1'})
 f.select.value='new';await f.select.listeners.change();const name=f.bar.element.children[1];name.value='New';await f.bar.element.children[2].listeners.click();assert.deepEqual(f.bar.value(),{workspace_id:'w2'})
 f.select.value='folder';await f.select.listeners.change();assert.deepEqual(f.bar.value(),{project:'/private/folder/demo'});assert.equal(f.select.title,'demo');assert.equal(f.select.children.some(n=>n.textContent.includes('/private')),false)
 f.c.selectedId='b';f.bar.update();assert.deepEqual(f.bar.value(),{workspace_id:'w0'});f.visible.value=false;f.bar.update();assert.equal(f.bar.element.hidden,true)
 assert.equal(workspaceLabel('C:\\Private\\demo'),'demo')
})
