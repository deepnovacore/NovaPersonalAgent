import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
import {createImPanel} from '../src/renderer/im-panel.mjs'
import {renderFeishu} from '../src/renderer/feishu-view.mjs'
import {feishuVerificationUrl} from '../src/main/security.mjs'

class Node {
 constructor(tag,text){this.tag=tag;this.text=text;this.children=[];this.listeners={};this.dataset={};this.classList={add:()=>{}}}
 append(...children){this.children.push(...children)}
 prepend(...children){this.children.unshift(...children)}
 replaceChildren(...children){this.children=children}
 setAttribute(key,value){this[key]=value}
 addEventListener(name,fn){this.listeners[name]=fn}
 querySelectorAll(tag){return this.children.flatMap(node=>[...(node.tag===tag?[node]:[]),...node.querySelectorAll(tag)])}
 querySelector(tag){return this.querySelectorAll(tag)[0]}
 focus(){}
}
function view(state,overrides={}){
 const nodes=[],commands=[],local={onError:error=>{throw error},...overrides}
 const el=(tag,text)=>{const node=new Node(tag,text);nodes.push(node);return node}
 const button=(label,action,parent)=>{const b=el('button',label);b.action=action;parent.append(b);return b}
 globalThis.document={createTextNode:text=>el('text',text)}
 renderFeishu({state,local,card:()=>el('article'),el,button,command:async(method,params)=>{commands.push({method,params})},refresh:()=>{},api:{personal:{}}})
 return {nodes,commands,button:label=>nodes.find(node=>node.tag==='button'&&node.text===label)}
}
test('Feishu does not authorize reading or bot delivery by rendering and keeps deletion separate',async()=>{
 const v=view({available:true,configured:true,state:'ready',chats:[{id:'chat-1',name:'测试会话'}]})
 assert.deepEqual(v.commands,[])
 const checks=v.nodes.filter(node=>node.tag==='input')
 assert.ok(checks.every(node=>node.checked===false&&node.role==='switch'))
 const save=v.button('完成配置');assert.equal(save.disabled,true)
 checks[0].checked=true;checks[0].listeners.change();checks[1].checked=true;checks[1].listeners.change()
 assert.equal(save.disabled,false);await save.action()
 assert.deepEqual(v.commands[0],{method:'feishu.configure',params:{chat_ids:['chat-1'],consent:true}})
 await v.button('断开（保留历史）').action()
 assert.equal(v.commands.at(-1).method,'feishu.disconnect')
 assert.ok(!v.commands.some(command=>command.method==='feishu.delete'))
 const confirmation=v.nodes.find(node=>node['aria-label']==='确认删除飞书历史');assert.equal(confirmation.hidden,true)
 await v.button('删除本地历史').action();assert.equal(confirmation.hidden,false)
 await v.button('确认删除本地历史').action();assert.equal(v.commands.at(-1).method,'feishu.delete')
})
test('unconfigured deployment does not offer OAuth or expose credentials',()=>{
 assert.doesNotThrow(()=>view(null))
 const v=view({available:true,configured:false,device_code:'secret',app_secret:'secret'})
 assert.equal(v.button('登录飞书'),undefined)
 assert.ok(!v.nodes.some(node=>String(node.text).includes('secret')))
})
test('only official HTTPS verification destinations can open outside the application',()=>{
 assert.equal(feishuVerificationUrl('https://accounts.feishu.cn/login?code=public'),'https://accounts.feishu.cn/login?code=public')
 for(const url of ['http://feishu.cn','https://feishu.cn.attacker.test','https://attackerfeishu.cn','https://user:pass@feishu.cn','file:///tmp/code','https://feishu.cn:9443/'])assert.throws(()=>feishuVerificationUrl(url))
})

test('the real authorization IPC rejects other windows before opening a URL',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:personal:feishu-verification'"),source.indexOf("  ipcMain.handle('nova:personal:connector-authorization'"))
 const mainWindow={webContents:{}},settingsWindow={webContents:{}},opened=[];let handler
 new Function('ipcMain','mainWindow','shell','feishuVerificationUrl','settingsWindow',block)({handle:(_,fn)=>{handler=fn}},mainWindow,{openExternal:async url=>opened.push(url)},feishuVerificationUrl,settingsWindow)
 await assert.rejects(handler({sender:{}},'https://accounts.feishu.cn/login'),/rejected/)
 await assert.rejects(handler({sender:mainWindow.webContents},'https://evil.test'),/无效/)
 assert.deepEqual(opened,[])
 await handler({sender:mainWindow.webContents},'https://accounts.feishu.cn/login')
 await handler({sender:settingsWindow.webContents},'https://accounts.feishu.cn/login')
 assert.deepEqual(opened,['https://accounts.feishu.cn/login','https://accounts.feishu.cn/login'])
})

test('read-only project entries have no correction or forget controls',async()=>{
 const body=new Node('body'),shell=new Node('div');body.append(shell)
 globalThis.window={addEventListener(){}}
 globalThis.document={addEventListener(){},body,createElement:tag=>new Node(tag),createTextNode:text=>new Node('text',text),querySelector:selector=>selector==='#shell'?shell:null}
 const sent=[]
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{orbMenu:{},personal:{}}})
 view.controller.connect()
 const entry=(id,editable)=>({id,editable,version:1,topic:id,content:'项目进展',kind:'topic',status:'active',source_refs:[]})
 view.receive({type:'personal.state',revision:1,memory:{entries:[entry('只读项目',false),entry('个人记忆',true)]},capabilities:{memory:{list:true,correct:true,forgetEntry:true}}})
 await body.querySelectorAll('button').find(button=>button.textContent==='Profile').listeners.click()
 await body.querySelectorAll('button').find(button=>button.textContent==='查看与纠正已有记忆').listeners.click()
 const articles=body.querySelectorAll('article')
 const buttons=topic=>articles.find(article=>article.querySelector('h4')?.textContent===topic).querySelectorAll('button').map(button=>button.textContent)
 assert.deepEqual(buttons('只读项目'),['接着聊'])
 assert.deepEqual(buttons('个人记忆'),['纠正','忘记','接着聊'])
 const toggle=body.querySelectorAll('input').find(input=>input.type==='checkbox');assert.equal(toggle.checked,false)
 toggle.checked=true;const pending=toggle.listeners.change();const request=sent.at(-1)
 assert.deepEqual(request.params,{limit:50,include_expired:true})
 const expired={...entry('过期安排',true),status:'expired',content:'已经过期的安排'}
 view.receive({type:'personal.state',revision:2,memory:{include_expired:true,entries:[entry('个人记忆',true),expired]},capabilities:{memory:{list:true,correct:true,forgetEntry:true}}})
 view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await pending
 assert.equal(body.querySelectorAll('input').find(input=>input.type==='checkbox').checked,true)
 assert.ok(body.querySelectorAll('h4').some(node=>node.textContent==='过期安排'))
 assert.ok(body.querySelectorAll('span').some(node=>node.textContent==='已过期'))
 assert.ok(!body.querySelectorAll('p').filter(node=>node.className==='memory-overview-copy').some(node=>node.textContent.includes('已经过期')))
})

test('application guide exposes creation and existing binding before OAuth',async()=>{
 const v=view({available:true,configured:false})
 assert.ok(v.button('绑定已有应用'))
 await v.button('创建飞书应用').action()
 assert.deepEqual(v.commands,[{method:'feishu.app.start',params:{}}])
 const binding=view({available:true,configured:false},{bindApp:true})
 const inputs=binding.nodes.filter(node=>node.tag==='input')
 inputs[0].value=' cli_example ';inputs[1].value='fixture-only-secret'
 await binding.button('绑定并继续').action()
 assert.equal(inputs[1].type,'password');assert.equal(inputs[1].value,'')
 assert.deepEqual(binding.commands,[{method:'feishu.app.bind',params:{app_id:'cli_example',app_secret:'fixture-only-secret'}}])
 const waiting=view({available:true,configured:false,app_setup:{state:'waiting',verification_url:'https://open.feishu.cn/page/cli'}})
 assert.equal(waiting.button('创建飞书应用'),undefined)
 await waiting.button('我已完成，继续').action();await waiting.button('取消配置').action()
 assert.deepEqual(waiting.commands.map(command=>command.method),['feishu.app.status','feishu.app.cancel'])
})

test('setup polling opens the link once and preserves controls while progress is unchanged',async t=>{
 const root=new Node('div'),error=new Node('p');let tick
 t.mock.method(globalThis,'setTimeout',callback=>{tick=callback;return 0})
 t.mock.method(globalThis,'clearTimeout',()=>{})
 globalThis.document={querySelector:selector=>selector==='#im-connection'?root:error,createElement:tag=>new Node(tag),createTextNode:text=>new Node('text',text)}
 let state={available:true,configured:false,state:'unauthorized'};const opened=[]
 const panel=createImPanel({document,api:{openFeishuVerification:async url=>opened.push(url),feishuCommand:async method=>{
  if(method==='feishu.app.start')state={...state,app_setup:{state:'waiting',verification_url:'https://open.feishu.cn/page/cli?fixture=1'}}
  if(method==='feishu.app.status')state={...state,configured:true,app_setup:{state:'ready'}}
  return structuredClone(state)
 }}})
 await panel.load()
 const click=async title=>{root.querySelectorAll('button').find(node=>node.textContent===title).listeners.click();await new Promise(resolve=>setImmediate(resolve))}
 await click('创建飞书应用');assert.equal(opened.length,1)
 const card=root.children[0];tick();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(root.children[0],card);assert.equal(opened.length,1)
 await click('我已完成，继续')
 assert.ok(root.querySelectorAll('button').some(node=>node.textContent==='登录飞书'))
})

test('settings waits for status without claiming CLI is missing',async()=>{
 const root=new Node('main'),error=new Node('p');let respond
 const document={querySelector:selector=>selector==='#im-connection'?root:error,createElement:tag=>new Node(tag)}
 const panel=createImPanel({document,api:{feishuCommand:()=>new Promise(resolve=>{respond=resolve})}})
 const text=()=>root.querySelectorAll('p').map(node=>node.textContent??node.text).join(' ')
 assert.match(text(),/正在读取/);assert.doesNotMatch(text(),/安装|lark-cli/)
 const pending=panel.load();assert.match(text(),/正在读取/)
 respond({available:false});await pending;assert.match(text(),/lark-cli/)
})

test('text captions never duplicate persisted users; voice captions and generation states remain visible',()=>{
 const body=new Node('body'),shell=new Node('div');body.append(shell)
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,createElement:tag=>new Node(tag),createTextNode:text=>new Node('text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[],api:{orbMenu:{},personal:{}}});view.controller.connect()
 const snapshot=(revision,voice,status='pending')=>view.receive({type:'personal.state',revision,conversations:{selected_id:'a',voice_id:voice,items:[{id:'a',kind:'chat',title:'A'}],messages:[{id:'u',conversation_id:'a',role:'user',text:'one admitted text',generation_status:status}]},memory:{entries:[]}})
 snapshot(1,null)
 view.receive({type:'caption',conversation_id:'a',turn_id:'synthetic',role:'user',text:'one admitted text',final:true})
 assert.equal(body.querySelectorAll('p').filter(n=>n.textContent==='one admitted text').length,1)
 assert.ok(body.querySelectorAll('small').some(n=>n.textContent==='正在回复…'))
 snapshot(2,null,'interrupted');assert.ok(body.querySelectorAll('small').some(n=>n.textContent==='回复已中断，请重新发送'))
 snapshot(3,'a','completed');view.receive({type:'caption',conversation_id:'a',turn_id:'voice-turn',role:'user',text:'live voice',final:false})
 assert.equal(body.querySelectorAll('p').filter(n=>n.textContent==='live voice').length,1)
})

test('side panel starts open and toggles locally with accessible state',async()=>{
 const body=new Node('body'),shell=new Node('div');body.append(shell)
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,createElement:tag=>new Node(tag),createTextNode:text=>new Node('text',text),querySelector:()=>shell}
 const calls=[];mountPersonalView({send:frame=>(calls.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[],api:{orbMenu:{},personal:{}}})
 const side=body.querySelectorAll('section').find(node=>node.id==='personal-side'),root=body.querySelector('main'),toggle=body.querySelectorAll('button').find(node=>node.textContent==='侧栏')
 assert.equal(side.hidden,false);assert.equal(root.dataset.sideOpen,'true');assert.equal(toggle['aria-expanded'],'true')
 await toggle.listeners.click();assert.equal(side.hidden,true);assert.equal(root.dataset.sideOpen,'false');assert.equal(toggle['aria-expanded'],'false')
 await toggle.listeners.click();assert.equal(side.hidden,false);assert.equal(calls.length,0)
})

test('guide progress follows actual application and OAuth state, with an explicit waiting handoff',()=>{
 for(const [state,current] of [[{available:true,configured:false},0],[{available:true,configured:true,state:'authorizing'},1],[{available:true,configured:true,state:'ready'},2]]){
  const rendered=view(state),steps=rendered.nodes.filter(node=>node.tag==='li'&&node.dataset.state)
  assert.equal(steps.length,3);assert.equal(steps[current]['aria-current'],'step')
  assert.equal(steps.filter(step=>step.dataset.state==='done').length,current)
  assert.deepEqual(rendered.commands,[])
 }
 const waiting=view({available:true,configured:false,app_setup:{state:'waiting'}})
 assert(waiting.nodes.some(node=>node.role==='status'))
 assert(waiting.button('我已完成，继续'));assert.equal(waiting.button('创建飞书应用'),undefined)
})

test('chat list preserves server recency order and bulk selection never grants consent',async()=>{
 const v=view({available:true,configured:true,state:'ready',chats:[{id:'new',name:'较新'},{id:'old',name:'较旧'}]})
 const list=v.nodes.find(node=>node['aria-label']==='可同步的飞书会话');assert.equal(list.tabIndex,0)
 assert.deepEqual(list.children.map(label=>label.children[1].text),['较新','较旧'])
 const save=v.button('完成配置');await v.button('全选').action();assert.equal(save.disabled,true);assert.equal(v.commands.length,0)
 const inputs=v.nodes.filter(node=>node.tag==='input');assert.deepEqual(inputs.slice(0,3).map(node=>node.checked),[true,true,false])
 await v.button('取消全选').action();assert.deepEqual(inputs.slice(0,3).map(node=>node.checked),[false,false,false]);assert.equal(save.disabled,true)
})
test('persisted scope completion finishes all steps and offers adjustment',()=>{
 const v=view({available:true,configured:true,state:'paused',scope_configured:true,chats:[{id:'saved',name:'已选',selected:true}]})
 assert.ok(v.nodes.some(node=>node.text==='飞书配置完成'))
 assert.ok(v.nodes.filter(node=>node.tag==='li'&&node.dataset.state).every(node=>node.dataset.state==='done'))
 assert.ok(v.button('调整会话'));assert.equal(v.button('完成配置'),undefined)
 const editing=view({available:true,configured:true,state:'ready',scope_configured:true,chats:[{id:'saved',selected:true}]},{accountKey:null,editScope:true})
 assert.ok(editing.button('完成配置'));assert.equal(editing.button('完成配置').disabled,true)
})

test('app connectors keep read selection and model processing consent separate',async()=>{
 const {renderConnectors}=await import('../src/renderer/connectors-view.mjs')
 const nodes=[],commands=[],local={fixture:{choices:{items:[{id:'INBOX',name:'Inbox'}],next:null},selected:new Set(['INBOX'])}}
 const el=(tag,text)=>{const n=new Node(tag,text);nodes.push(n);return n}
 renderConnectors({state:{available:true,connections:[{id:'fixture',toolkit:'gmail',state:'paused',identity:'fixture@example.test',scope:null,processing_allowed:false}]},local,card:()=>el('article'),el,button:(label,action,parent)=>{const b=el('button',label);b.action=action;parent.append(b);return b},command:async(method,params)=>{commands.push({method,params})},api:{personal:{}},refresh(){}})
 assert.deepEqual(commands,[])
 const checks=nodes.filter(n=>n.tag==='input'&&n.type==='checkbox')
 assert.equal(checks[0].checked,true);assert.equal(checks[1].checked,false)
 await nodes.find(n=>n.text==='保存范围并开始同步').action()
 assert.equal(commands[0].method,'connector.configure');assert.equal(commands[0].params.processingConsent,false)
 assert.deepEqual(commands[0].params.scope,{kind:'gmail',labels:['INBOX'],pastDays:30})
})
