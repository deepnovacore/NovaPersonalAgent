import assert from 'node:assert/strict'
import {test} from 'node:test'
import {COMPOSER_MODES,composerMode,mountComposerMode,nextComposerMode} from '../src/renderer/composer-mode.mjs'

class Element{
 constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={}}
 append(...children){this.children.push(...children)}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
 focus(){}
}
const el=(name,text)=>new Element(name,text)
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0))}

function fixture(item){
 const commands=[],drafts=new Map()
 const c={connected:true,isVoiceConversation:false,selectedConversation:item,changed(){},
  state:id=>{if(!drafts.has(id))drafts.set(id,{});return drafts.get(id)},
  command:async(method,params)=>{commands.push([method,params]);if(method==='conversations.mode')item.mode=params.mode}}
 const parent=el('div'),control=mountComposerMode(parent,{c,el,run:callback=>callback()})
 const root=parent.children[0],button=root.children[0]
 control.update()
 return {c,commands,control,root,button}
}

test('modes cycle Chat, Plan, Build, Delegate in both directions',()=>{
 assert.deepEqual(COMPOSER_MODES,['chat','plan','build','delegate'])
 assert.equal(nextComposerMode('chat'),'plan');assert.equal(nextComposerMode('delegate'),'chat')
 assert.equal(nextComposerMode('chat',-1),'delegate');assert.equal(nextComposerMode('unknown'),'plan')
 assert.equal(composerMode({kind:'chat'}),'chat');assert.equal(composerMode({kind:'chat',mode:'plan'},{}),'plan')
 assert.equal(composerMode({kind:'chat',mode:'plan'},{execution:'delegate'}),'delegate')
 assert.equal(composerMode({kind:'chat'},{execution:'build'}),'chat','a stale execution choice never outlives Plan')
 assert.equal(composerMode({kind:'build'}),'build')
})

test('Shift+Tab steps through every mode with one host command per conversation-mode change',async()=>{
 const item={id:'chat:main',kind:'chat'},{c,commands,control,root}=fixture(item)
 const seen=[]
 for(let i=0;i<4;i++){assert.equal(control.cycle(),true);await flush();seen.push(root.attributes['data-mode'])}
 assert.deepEqual(seen,['plan','build','delegate','chat'])
 assert.deepEqual(commands,[['conversations.mode',{id:'chat:main',mode:'plan'}],['conversations.mode',{id:'chat:main',mode:'chat'}]])
 assert.equal(c.state('chat:main').execution,undefined)
})

test('Build and Delegate set the plan execution choice without starting anything',async()=>{
 const item={id:'chat:main',kind:'chat'},{c,commands,control,button,root}=fixture(item)
 await control.select('delegate');await flush()
 assert.equal(item.mode,'plan');assert.equal(c.state('chat:main').execution,'delegate');assert.equal(root.attributes['data-mode'],'delegate')
 await control.select('build');await flush()
 assert.equal(c.state('chat:main').execution,'build');assert.equal(commands.length,1,'already in Plan')
 assert.ok(commands.every(([method])=>method==='conversations.mode'))
 assert.equal(button.textContent,'Build');assert.equal(root.children.length,1)
 button.listeners.click();await flush();assert.equal(button.textContent,'Delegate')
})

test('arrow keys cycle the active mode and Shift+Tab is left alone when switching is unavailable',async()=>{
 const item={id:'chat:main',kind:'chat'},{c,control,button,root}=fixture(item)
 let prevented=false
 button.listeners.keydown({key:'ArrowLeft',preventDefault(){prevented=true}});await flush()
 assert.equal(prevented,true);assert.equal(root.attributes['data-mode'],'delegate')
 c.isVoiceConversation=true;control.update()
 assert.equal(control.cycle(),false);assert.equal(button.disabled,true);assert.equal(root.attributes['aria-disabled'],'true')
 c.isVoiceConversation=false;c.connected=false;control.update();assert.equal(control.cycle(),false)
})

test('a Build session shows Build locked and other kinds hide the control',()=>{
 const build=fixture({id:'b',kind:'build',build:{status:'running'}})
 assert.equal(build.root.hidden,false);assert.equal(build.root.attributes['data-mode'],'build')
 assert.equal(build.button.disabled,true);assert.equal(build.button.textContent,'Build');assert.equal(build.control.cycle(),false)
 assert.equal(build.button.title,'Build 会话进行中');assert.equal(build.root.children.length,1)
 for(const kind of ['proactive','schedule'])assert.equal(fixture({id:kind,kind}).root.hidden,true)
})
