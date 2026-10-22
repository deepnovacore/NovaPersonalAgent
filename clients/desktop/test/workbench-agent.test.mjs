import assert from 'node:assert/strict'
import {test} from 'node:test'
import {PersonalController} from '../src/renderer/personal-controller.mjs'
import {mountWorkbenchAgent} from '../src/renderer/workbench-agent.mjs'
import {normalizeSettings,backendSettings} from '../src/main/settings-store.mjs'

function fixture(confirm){
 const sent=[],c=new PersonalController({start:async()=>{},stop:async()=>{},confirmBuildSwitch:confirm,send:frame=>{
  sent.push(frame)
  if(frame.type==='personal.command')queueMicrotask(()=>{
   const data=structuredClone(c.snapshot.conversations)
   if(frame.method==='build.stop'){data.items.find(item=>item.kind==='build').build={status:'paused'};c.receive({type:'personal.result',request_id:frame.request_id,ok:true,data})}
   else if(frame.method==='conversations.select'){data.selected_id=frame.params.id;c.receive({type:'personal.result',request_id:frame.request_id,ok:true,data})}
   else c.receive({type:'personal.result',request_id:frame.request_id,ok:true})
  })
  return true
 }})
 c.connected=true;c.inputInstance='host';c.capabilities=['text_input','dictation'];c.receive({type:'personal.state',revision:1,conversations:{selected_id:'build',voice_id:null,items:[{id:'chat:main',kind:'chat'},{id:'build',kind:'build',build:{status:'running'}}],messages:[]}})
 return {c,sent}
}

test('running Build switch waits for user decision, applies stop receipt and leaves drafts intact',async()=>{
 let approve=false,asked=0
 const {c,sent}=fixture(async()=>{asked++;return approve});c.draft='下一步要求'
 await c.select('chat:main');assert.equal(c.selectedId,'build');assert.equal(sent.length,0);assert.equal(c.draft,'下一步要求')
 approve=true;await c.select('chat:main');assert.equal(c.selectedId,'chat:main');assert.equal(asked,2)
 assert.deepEqual(sent.map(frame=>frame.method),['build.stop','conversations.select']);assert.equal(c.activeBuild,null);assert.equal(c.state('build').draft,'下一步要求')
 await c.select('build');assert.equal(asked,2,'paused sessions switch without another prompt')
})

test('switching from running Build to voice stops first and routes microphone ownership to Chat',async()=>{
 const {c,sent}=fixture(async()=>true)
 // Stop just before capture: this test checks routing without claiming microphone hardware coverage.
 c.start=async()=>{throw Error('capture fixture')}
 await assert.rejects(c.voice(),/capture fixture/)
 assert.equal(sent[0].method,'build.stop');assert.equal(c.selectedId,'chat:main')
 assert.ok(sent.filter(frame=>frame.method==='conversations.voice').every(frame=>frame.params.id==='chat:main'))
})

test('local approval setting defaults to ask and is independent of executor approval',()=>{
 assert.equal(normalizeSettings({}).localToolApproval,'ask')
 assert.equal(normalizeSettings({localToolApproval:'invalid'}).localToolApproval,'ask')
 const settings=normalizeSettings({localToolApproval:'never',codexApprovalMode:'ask'})
 assert.equal(settings.localToolApproval,'never');assert.equal(settings.codexApprovalMode,'ask');assert.equal(backendSettings(settings).localToolApproval,'never')
})

test('local Build controls stay hidden when the host reports that the platform is unsupported',async()=>{
 class Element{
  constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.attributes={}}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(name,value){this.attributes[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
  get options(){return this.children}
 }
 const previousDocument=globalThis.document
 globalThis.document={createElement:name=>new Element(name),createTextNode:text=>new Element('#text',text)}
 try{
  const item={id:'chat:plan',kind:'chat',mode:'plan',plan:{id:'plan-1',version:1}},commands=[]
  const c={connected:true,isVoiceConversation:false,selectedId:item.id,selectedConversation:item,command:async(method)=>{
   commands.push(method)
   if(method==='plans.get')return {id:'plan-1',version:1,title:'Plan',content:'Full plan',next_offset:null}
   if(method==='conversations.targets')return {local_build_supported:false,targets:[],executors:['codex']}
   throw Error('unexpected command: '+method)
  }}
  const parent=new Element('main'),el=(name,text)=>new Element(name,text),agent=mountWorkbenchAgent(parent,{c,el,run:callback=>callback(),api:{personal:{}}})
  agent.update()
  for(let tries=0;tries<50&&!commands.includes('conversations.targets');tries++)await new Promise(resolve=>setTimeout(resolve,0))
  for(let tries=0;tries<50&&commands.filter(method=>method==='conversations.targets').length<1;tries++)await new Promise(resolve=>setTimeout(resolve,0))
  await new Promise(resolve=>setTimeout(resolve,0))
  const planCard=agent.element.children.find(child=>child.name==='section'&&child.children.some(node=>node.name==='h3'&&node.textContent==='计划 · Plan · v1'))
  assert.ok(planCard)
  const directory=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='项目目录')
  const picker=planCard.children.find(child=>child.name==='button'&&child.textContent==='选择本地目录…')
  const actions=planCard.children.find(child=>child.name==='div'&&child.children.some(node=>node.textContent==='在当前项目 Build'))
  const local=actions.children.find(node=>node.textContent==='在当前项目 Build')
  const delegate=actions.children.find(node=>node.textContent==='交给执行器 Build')
  assert.equal(directory.hidden,true);assert.equal(picker.hidden,true);assert.equal(local.hidden,true);assert.equal(delegate.hidden,false)
 }finally{globalThis.document=previousDocument}
})

test('published Plan enables local Build after the personal directory picker returns a path',async()=>{
 class Element{
  constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.attributes={}}
  append(...children){this.children.push(...children);if(this.name==='select'&&!this.value){const option=this.children.find(child=>child.name==='option'&&child.value);if(option)this.value=option.value}}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(name,value){this.attributes[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
  get options(){return this.children}
 }
 const previousDocument=globalThis.document
 globalThis.document={createElement:name=>new Element(name),createTextNode:text=>new Element('#text',text)}
 try{
  const item={id:'chat:plan',kind:'chat',mode:'plan',plan:{id:'plan-1',version:1}},commands=[],project='C:\\Projects\\中文 项目'
  const c={connected:true,isVoiceConversation:false,selectedId:item.id,selectedConversation:item,command:async(method,params)=>{
   commands.push([method,params])
   if(method==='plans.get')return {id:'plan-1',version:1,title:'Plan',content:'Full plan',next_offset:null}
   if(method==='conversations.targets')return {local_build_supported:true,targets:[],executors:['codex']}
   return {}
  }}
  const parent=new Element('main'),el=(name,text)=>new Element(name,text),agent=mountWorkbenchAgent(parent,{c,el,run:callback=>callback(),api:{personal:{chooseBuildDirectory:async()=>project}}})
  agent.update()
  for(let tries=0;tries<50&&!commands.some(([method])=>method==='conversations.targets');tries++)await new Promise(resolve=>setTimeout(resolve,0))
  await new Promise(resolve=>setTimeout(resolve,0))
  const planCard=agent.element.children.find(child=>child.name==='section'&&child.children.some(node=>node.name==='h3'&&node.textContent==='计划 · Plan · v1'))
  const picker=planCard.children.find(child=>child.name==='button'&&child.textContent==='选择本地目录…')
  const directories=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='项目目录')
  const actions=planCard.children.find(child=>child.name==='div'&&child.children.some(node=>node.textContent==='在当前项目 Build'))
  const local=actions.children.find(node=>node.textContent==='在当前项目 Build')
  const delegate=actions.children.find(node=>node.textContent==='交给执行器 Build')
  assert.equal(picker.hidden,false)
  assert.equal(local.disabled,true)
  await picker.listeners.click()
  assert.equal(directories.value,project)
  assert.equal(local.disabled,false)
  assert.equal(delegate.disabled,false)
  await local.listeners.click()
  await delegate.listeners.click()
  assert.deepEqual(commands.filter(([method])=>['build.start','plans.delegate'].includes(method)).map(([method,params])=>[method,params.project??params.executor]),[
   ['build.start',project],['plans.delegate','codex'],
  ])
 }finally{globalThis.document=previousDocument}
})

test('Build status bar keeps state, project path and restart reason as separate lines',()=>{
 class Element{
  constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.attributes={}}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(name,value){this.attributes[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
 }
 const project='/Volumes/sqxh-junjie/nova-builds/build-cu-01a15eb3/demo'
 const item={id:'build',kind:'build',build:{status:'paused',project,reason:'restart_requires_resume'}}
 const c={connected:true,selectedId:item.id,selectedConversation:item,command:async()=>({})}
 const parent=new Element('main'),agent=mountWorkbenchAgent(parent,{c,el:(name,text)=>new Element(name,text),run:callback=>callback(),api:{personal:{}}})
 agent.update()
 const walk=node=>[node,...node.children.flatMap(walk)]
 const status=walk(agent.element).find(node=>node.attributes.role==='status')
 assert.equal(status.textContent,'Build · 已暂停');assert.equal(status.attributes['data-state'],'paused')
 const info=walk(agent.element).find(node=>node.children.includes(status)),[, path, reason]=info.children
 assert.equal(path.textContent,project);assert.equal(path.title,project)
 assert.equal(reason.textContent,'重启后等待恢复');assert.equal(reason.hidden,false)
})
