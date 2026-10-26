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

test('starting a conversation from a card never stops a running Build without confirmation',async()=>{
 let approve=false,asked=0
 const {c,sent}=fixture(async()=>{asked++;return approve}),request={title:'卡片',text:'聊聊',references:[{kind:'goal',id:'g',version:1}]}
 await assert.rejects(c.startConversationWithReference(request),/切换已取消/);assert.equal(asked,1);assert.deepEqual(sent,[],'cancelling sends nothing at all')
 approve=true;await c.startConversationWithReference(request)
 assert.deepEqual(sent.map(frame=>frame.method),['build.stop','conversations.start']);assert.deepEqual(sent[1].params,request)
})

test('switching from running Build to voice stops first and keeps voice in the same Build conversation',async()=>{
 const {c,sent}=fixture(async()=>true)
 // Stop just before capture: this test checks routing without claiming microphone hardware coverage.
 c.start=async()=>{throw Error('capture fixture')}
 await assert.rejects(c.voice(),/capture fixture/)
 assert.equal(sent[0].method,'build.stop');assert.equal(c.selectedId,'build')
 assert.ok(sent.filter(frame=>frame.method==='conversations.voice').every(frame=>frame.params.id==='build'))
 assert.equal(sent.some(frame=>frame.method==='conversations.select'),false,'no detour through the main chat')
})

test('local approval setting defaults to ask and is independent of executor approval',()=>{
 assert.equal(normalizeSettings({}).localToolApproval,'ask')
 assert.equal(normalizeSettings({localToolApproval:'invalid'}).localToolApproval,'ask')
 const settings=normalizeSettings({localToolApproval:'never',codexApprovalMode:'ask'})
 assert.equal(settings.localToolApproval,'never');assert.equal(settings.codexApprovalMode,'ask');assert.equal('localToolApproval' in backendSettings(settings),false,'the approval mode switches live and never forces a restart')
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
  const local={};const c={state:()=>local,connected:true,isVoiceConversation:false,selectedId:item.id,selectedConversation:item,command:async(method)=>{
   commands.push(method)
   if(method==='workspaces.list')return [{workspace_id:'managed-default',name:'default',is_default:true}];
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
  const runner=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='执行器')
  const picker=planCard.children.find(child=>child.attributes?.role==='group')
  const actions=planCard.children.find(child=>child.name==='div'&&child.children.some(node=>node.name==='button'&&node.textContent.startsWith('交给')))
  assert.deepEqual(runner.children.map(option=>option.value),['codex'],'no built-in Build where the platform cannot run it')
  assert.equal(picker.hidden,true)
  assert.ok(actions.children.some(node=>node.textContent==='交给 codex'))
  assert.equal(actions.children.some(node=>node.textContent==='开始 Build'),false)
 }finally{globalThis.document=previousDocument}
})

test('published Plan starts the built-in Build or hands the plan to a chosen executor, in the chosen workspace',async()=>{
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
  const local={};const c={state:()=>local,connected:true,isVoiceConversation:false,selectedId:item.id,selectedConversation:item,command:async(method,params)=>{
   commands.push([method,params])
   if(method==='workspaces.list')return [{workspace_id:'managed-default',name:'default',is_default:true}];
   if(method==='plans.get')return {id:'plan-1',version:1,title:'Plan',content:'Full plan',next_offset:null}
   if(method==='conversations.targets')return {local_build_supported:true,targets:[],executors:['codex']}
   return {}
  }}
  const parent=new Element('main'),el=(name,text)=>new Element(name,text),agent=mountWorkbenchAgent(parent,{c,el,run:callback=>callback(),api:{personal:{chooseBuildDirectory:async()=>project}}})
  agent.update()
  for(let tries=0;tries<50&&!commands.some(([method])=>method==='conversations.targets');tries++)await new Promise(resolve=>setTimeout(resolve,0))
  await new Promise(resolve=>setTimeout(resolve,0))
  const planCard=agent.element.children.find(child=>child.name==='section'&&child.children.some(node=>node.name==='h3'&&node.textContent==='计划 · Plan · v1'))
  const picker=planCard.children.find(child=>child.attributes?.role==='group')
  const directories=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='工作区')
  const runner=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='执行器')
  const actions=planCard.children.find(child=>child.name==='div'&&child.children.some(node=>node.textContent==='开始 Build'))
  const start=actions.children.find(node=>node.textContent==='开始 Build')
  assert.deepEqual(runner.children.map(option=>option.value),['','codex'],'built-in Build first, then the executors')
  assert.equal(picker.hidden,false)
  assert.equal(start.disabled,false,'the managed default workspace is selected')
  assert.equal(start.disabled,false)
  await start.listeners.click()
  runner.value='codex';runner.listeners.change()
  assert.equal(start.textContent,'交给 codex');assert.equal(picker.hidden,true,'executors only use listed workspaces')
  await start.listeners.click()
  assert.deepEqual(commands.filter(([method])=>['build.start','plans.delegate'].includes(method)).map(([method,params])=>[method,params.executor,params.workspace_id??params.project]),[
   ['build.start',undefined,'managed-default'],['plans.delegate','codex',undefined],
  ])
 }finally{globalThis.document=previousDocument}
})

test('Build status bar shows state, the workspace folder name without exposing the absolute path, and a readable reason',()=>{
 class Element{
  constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.attributes={}}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(name,value){this.attributes[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
 }
 const project='/Volumes/External/nova-builds/build-cu-example/demo'
 const item={id:'build',kind:'build',build:{status:'paused',project,reason:'restart_requires_resume'}}
 const local={};const c={state:()=>local,connected:true,selectedId:item.id,selectedConversation:item,command:async()=>({})}
 const parent=new Element('main'),agent=mountWorkbenchAgent(parent,{c,el:(name,text)=>new Element(name,text),run:callback=>callback(),api:{personal:{}}})
 agent.update()
 const walk=node=>[node,...node.children.flatMap(walk)]
 const status=walk(agent.element).find(node=>node.attributes.role==='status')
 assert.equal(status.textContent,'Build · 已暂停');assert.equal(status.attributes['data-state'],'paused')
 const info=walk(agent.element).find(node=>node.children.includes(status)),[, path, reason]=info.children
 assert.equal(path.textContent,'demo');assert.equal(path.title,'demo')
 assert.equal(reason.textContent,'重启后等待恢复');assert.equal(reason.hidden,false)
})

test('a paused Build explains an approval denial in words instead of the raw code',()=>{
 class Element{
  constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.attributes={}}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(name,value){this.attributes[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
 }
 const walk=node=>[node,...node.children.flatMap(walk)]
 const bar=reason=>{const item={id:'build',kind:'build',build:{status:'paused',project:'/x/demo',reason}},local={},c={state:()=>local,connected:true,selectedId:item.id,selectedConversation:item,command:async()=>({})},parent=new Element('main'),agent=mountWorkbenchAgent(parent,{c,el:(name,text)=>new Element(name,text),run:callback=>callback(),api:{personal:{}}});agent.update();const status=walk(agent.element).find(node=>node.attributes.role==='status');return walk(agent.element).find(node=>node.children.includes(status)).children[2]}
 assert.equal(bar('approval_denied').textContent,'你拒绝了一次操作，补充新的要求后继续')
 const unknown=bar('some_internal_code');assert.equal(unknown.textContent,'');assert.equal(unknown.hidden,true,'unknown codes are never shown raw')
})

test('plan card workspaces follow the runner: Build and Codex differ, other executors take no workspace',async()=>{
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
  const local={};const c={state:()=>local,connected:true,isVoiceConversation:false,selectedId:item.id,selectedConversation:item,command:async(method,params)=>{
   commands.push([method,params])
   if(method==='workspaces.list')return [{workspace_id:'managed-default',name:'default',is_default:true}];
   if(method==='plans.get')return {id:'plan-1',version:1,title:'Plan',content:'Full plan',next_offset:null}
   if(method==='conversations.targets')return {local_build_supported:true,targets:[{project:'demo',directory:'/registered/demo'}],executors:['codex','pi']}
   return {}
  }}
  const parent=new Element('main'),el=(name,text)=>new Element(name,text),agent=mountWorkbenchAgent(parent,{c,el,run:callback=>callback(),api:{personal:{chooseBuildDirectory:async()=>'/anywhere',defaultWorkspace:async()=>'/default/ws'}}})
  agent.update()
  for(let tries=0;tries<50&&!commands.some(([method])=>method==='conversations.targets');tries++)await new Promise(resolve=>setTimeout(resolve,0))
  await new Promise(resolve=>setTimeout(resolve,0))
  const planCard=agent.element.children.find(child=>child.name==='section'&&child.children.some(node=>node.name==='h3'))
  const runner=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='执行器')
  const directories=planCard.children.find(child=>child.name==='select'&&child.attributes['aria-label']==='工作区')
  const actions=planCard.children.find(child=>child.name==='div'&&child.children.some(node=>node.name==='button'&&node.textContent==='开始 Build'))
  const start=()=>actions.children.find(node=>node.name==='button'&&['开始 Build','交给 codex','交给 pi'].includes(node.textContent))
  assert.ok(planCard.children.some(node=>node.attributes?.role==='group'&&!node.hidden),'built-in Build offers managed workspaces');assert.equal(directories.hidden,true)
  runner.value='codex';runner.listeners.change()
  assert.deepEqual(directories.children.map(option=>option.value),['','/registered/demo'],'Codex only offers registered directories')
  directories.value='/registered/demo';directories.listeners.change();await start().listeners.click()
  runner.value='pi';runner.listeners.change()
  assert.equal(directories.hidden,true,'a non-Codex executor takes no workspace')
  await start().listeners.click()
  assert.deepEqual(commands.filter(([method])=>method==='plans.delegate').map(([,params])=>[params.executor,params.project]),[['codex','/registered/demo'],['pi',undefined]])
 }finally{globalThis.document=previousDocument}
})

test('Build status styles reserve a single row and ellipsize the readable reason',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 for(const selector of ['workbench-mode-bar','workbench-build-info','workbench-build-actions'])assert.match(css,new RegExp('\\.'+selector+'\\{[^}]*flex-wrap:nowrap'))
 assert.match(css,/\.workbench-build-reason\{[^}]*text-overflow:ellipsis;white-space:nowrap/)
 const source=await readFile(new URL('../src/renderer/workbench-agent.mjs',import.meta.url),'utf8');assert.ok(source.includes("resume=el('button',t('继续'))"));assert.ok(!source.includes("resume=el('button','Resume')"))
})
