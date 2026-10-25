import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mountComposerApproval} from '../src/renderer/composer-approval.mjs'

class Element{
 constructor(name){this.name=name;this.textContent='';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={};this.title=''}
 append(...children){this.children.push(...children)}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
}
const el=name=>new Element(name)
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0))}

function fixture({stored='ask',visible=true,fail=false}={}){
 const commands=[],saved=[]
 const c={connected:true,command:async(method,params)=>{if(fail)throw Error('nope');commands.push([method,params]);return {}}}
 const api={localToolApproval:async mode=>{if(mode===undefined)return stored;saved.push(mode);return mode}}
 const parent=el('div'),state={visible}
 const control=mountComposerApproval(parent,{c,el,run:callback=>callback(),api,visible:()=>state.visible})
 return {c,commands,saved,state,control,button:parent.children[0]}
}

test('the stored mode loads, the button hides outside plan and Build, and clicks flip it live',async()=>{
 const f=fixture({stored:'never',visible:false});await flush()
 assert.equal(f.button.attributes['data-approval'],'never');assert.equal(f.button.hidden,true)
 f.state.visible=true;f.control.update();assert.equal(f.button.hidden,false);assert.equal(f.button.attributes['aria-pressed'],'true')
 f.button.listeners.click();await flush()
 assert.deepEqual(f.commands,[['settings.local_tool_approval',{mode:'ask'}]]);assert.deepEqual(f.saved,['ask'])
 assert.equal(f.button.attributes['data-approval'],'ask');assert.match(f.button.title,/Always ask/)
 f.button.listeners.click();await flush()
 assert.equal(f.button.attributes['data-approval'],'never');assert.match(f.button.title,/Always approve/)
})

test('a rejected runtime command leaves the mode and the stored value alone',async()=>{
 const f=fixture({fail:true});await flush()
 await f.control.toggle().catch(()=>{})
 assert.equal(f.button.attributes['data-approval'],'ask');assert.deepEqual(f.saved,[]);assert.equal(f.button.disabled,false)
})
