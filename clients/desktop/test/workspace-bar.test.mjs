import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountWorkspaceBar,workspaceLabel,workspaceNameError,workspaceErrorText} from '../src/renderer/workspace-bar.mjs'
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
function fixture(presentationReady=true){
 const states=new Map(),calls=[],items=[{workspace_id:'w0',name:'default',is_default:true},{workspace_id:'w1',name:'Demo',is_default:false}]
 const c={connected:true,presentationReady,selectedId:'a',changed(){},state(id){if(!states.has(id))states.set(id,{});return states.get(id)},async command(method,p){calls.push([method,p]);if(method==='workspaces.list')return items;const item={workspace_id:'w2',name:p.name,is_default:false};items.push(item);return item}}
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

test('workspace discovery waits for presentation recovery',async()=>{
 const f=fixture(false);await flush();assert.deepEqual(f.calls,[]);assert.equal(f.select.disabled,true)
 f.c.presentationReady=true;f.bar.update();await flush()
 assert.deepEqual(f.calls,[['workspaces.list',{}]]);assert.deepEqual(f.bar.value(),{workspace_id:'w0'});assert.equal(f.select.disabled,false)
})

test('the create row survives updates, hides on another choice and closes on cancel',async()=>{
 const f=fixture();await flush()
 const name=f.bar.element.children[1],createButton=f.bar.element.children[2],cancelButton=f.bar.element.children[3]
 f.select.value='new';await f.select.listeners.change()
 assert.equal(f.bar.creating,true);assert.equal(name.hidden,false);assert.equal(createButton.hidden,false);assert.equal(cancelButton.hidden,false)
 assert.equal(f.select.value,'new')
 // The host `run()` wrapper calls update() after the change handler: the picker must not bounce back.
 f.bar.update();f.bar.update()
 assert.equal(f.select.value,'new','update() must not recompute the picker while creating')
 assert.equal(name.hidden,false,'the create row stays attached to the "new" choice')
 assert.deepEqual(f.bar.value(),{workspace_id:'w0'},'the pending create row does not change the selected workspace')
 f.select.value='w1';await f.select.listeners.change()
 assert.equal(f.bar.creating,false);assert.equal(name.hidden,true);assert.equal(createButton.hidden,true);assert.equal(cancelButton.hidden,true)
 assert.deepEqual(f.bar.value(),{workspace_id:'w1'})
 f.select.value='new';await f.select.listeners.change()
 cancelButton.listeners.click();f.bar.update()
 assert.equal(f.bar.creating,false);assert.equal(name.hidden,true);assert.equal(f.select.value,'w1','cancel returns the picker to the real owner')
 assert.equal(f.calls.some(([method])=>method==='workspaces.create'),false)
})

test('empty and invalid names disable create and never reach the host',async()=>{
 const f=fixture();await flush()
 f.select.value='new';await f.select.listeners.change()
 const name=f.bar.element.children[1],createButton=f.bar.element.children[2],hint=f.bar.element.children[4]
 for(const value of ['', '   ', '项目 #1', '工作区（新）', 'demo·2', '.', '..', 'a'.repeat(81)]){
  name.value=value;name.listeners.input()
  assert.equal(createButton.disabled,true,`create must be disabled for ${JSON.stringify(value)}`)
  await createButton.listeners.click()
  assert.equal(f.calls.filter(([method])=>method==='workspaces.create').length,0,`${JSON.stringify(value)} must not reach the host`)
 }
 name.value='';name.listeners.input()
 assert.equal(hint.hidden,true,'an empty name does not nag with an inline hint')
 name.value='项目 #1';name.listeners.input()
 assert.equal(hint.hidden,false);assert.match(hint.textContent,/只能包含文字、数字、空格/)
 name.value=' 项目 1 ';name.listeners.input()
 assert.equal(createButton.disabled,false)
 await createButton.listeners.click()
 assert.deepEqual(f.calls.filter(([method])=>method==='workspaces.create').map(([,params])=>params),[{name:'项目 1'}],'the sent name is trimmed')
 assert.equal(f.bar.creating,false);assert.deepEqual(f.bar.value(),{workspace_id:'w2'})
})

test('the client mirror of the host name rule accepts only the same characters',()=>{
 for(const value of ['项目 1','demo_2 (new).-','a','a'.repeat(80)])assert.equal(workspaceNameError(value),'',value)
 for(const value of ['','   ','项目 #1','工作区（新）','demo·2','.','..','a'.repeat(81)])assert.notEqual(workspaceNameError(value),'',value)
})

test('a delayed create writes back to the conversation that started it',async()=>{
 const states=new Map(),items=[{workspace_id:'w0',name:'default',is_default:true}]
 let resolveCreate
 const c={connected:true,presentationReady:true,selectedId:'a',changed(){},state(id){if(!states.has(id))states.set(id,{});return states.get(id)},async command(method,params){
  if(method==='workspaces.list')return items
  if(method==='workspaces.create')return new Promise(resolve=>{resolveCreate=()=>resolve({workspace_id:'w2',name:params.name})})
  return {}
 }}
 const parent=el('main'),bar=mountWorkspaceBar(parent,{c,el,button,run:value=>value(),api:{},visible:()=>true})
 bar.update();await flush()
 const select=bar.element.children[0],name=bar.element.children[1],create=bar.element.children[2]
 select.value='new';await select.listeners.change()
 name.value='Delayed';name.listeners.input()
 const pending=create.listeners.click();await flush()
 c.selectedId='b'
 resolveCreate();await pending
 assert.deepEqual(states.get('a')?.workspace,{workspace_id:'w2'},'the original conversation owns the created workspace')
 assert.equal(states.get('b')?.workspace,undefined,'the later selection is untouched')
})

test('create and list failures read as sentences and never expose host codes or Zod JSON',async()=>{
 const zod=new Error('[\n  {\n    "origin": "string",\n    "code": "invalid_format",\n    "format": "regex",\n    "pattern": "^[\\\\p{L}\\\\p{N} _().-]+$",\n    "message": "Invalid string: must match pattern"\n  }\n]')
 const items=[{workspace_id:'w0',name:'default',is_default:true}]
 let listError=zod,createError=null
 const calls=[],c={connected:true,presentationReady:true,selectedId:'a',changed(){},state(){return {}},async command(method,params){
  calls.push([method,params])
  if(method==='workspaces.list'){if(listError)throw listError;return items}
  if(method==='workspaces.create'){if(createError)throw createError;return {workspace_id:'w9',name:params.name}}
  return {}
 }}
 const parent=el('main'),bar=mountWorkspaceBar(parent,{c,el,button,run:callback=>callback(),api:{},visible:()=>true})
 bar.update();await flush()
 assert.match(c.error,/不符合要求/);assert.doesNotMatch(c.error,/invalid_format|origin|"pattern"|[{}[\]]/)
 listError=null;createError=new Error('workspace_name_conflict')
 bar.update();await flush()
 bar.element.children[0].value='new';await bar.element.children[0].listeners.change()
 bar.element.children[1].value='Demo';bar.element.children[1].listeners.input()
 await bar.element.children[2].listeners.click()
 assert.match(c.error,/同名/);assert.doesNotMatch(c.error,/workspace_name_conflict/)
 createError=new Error('workspaces_unavailable')
 await bar.element.children[2].listeners.click()
 assert.match(c.error,/工作区列表暂时不可用/);assert.doesNotMatch(c.error,/workspaces_unavailable/)
 assert.equal(bar.creating,true,'a failed create keeps the row open for a retry')
 assert.equal(bar.element.children[1].value,'Demo')
 assert.equal(workspaceErrorText('invalid_params'),'提交的内容不符合要求，请检查后重试。')
 assert.equal(workspaceErrorText(new Error('workspaces_unavailable')),'工作区列表暂时不可用，请稍后重试。')
 assert.doesNotMatch(workspaceErrorText(zod),/invalid_format|origin/)
})
