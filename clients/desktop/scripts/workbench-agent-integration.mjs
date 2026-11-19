import assert from 'node:assert/strict'
import {app,BrowserWindow,ipcMain,net,protocol} from 'electron'
import {mkdir,readFile,writeFile,realpath,stat} from 'node:fs/promises'
import {resolve,join,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {registerAppScheme} from '../src/main/app-protocol.mjs'
import {prepareWorkbenchTestResources} from './workbench-test-resources.mjs'

// The caller must select an output directory. No build or Electron cache may fall back to the checkout.
assert.ok(['darwin','win32'].includes(process.platform),'Run native acceptance on macOS or Windows')
assert.ok(process.env.NOVA_ACCEPTANCE_ROOT,'NOVA_ACCEPTANCE_ROOT is required')
assert.ok(process.env.NOVA_TEST_DIST,'NOVA_TEST_DIST must point at the isolated TypeScript output')
const root=await realpath(process.env.NOVA_ACCEPTANCE_ROOT),desktop=resolve(import.meta.dirname,'..'),dist=await realpath(process.env.NOVA_TEST_DIST)
assert.equal((await stat(root)).isDirectory(),true)
for(const name of ['userdata','session','logs','tmp','state','project 中文 空格'])await mkdir(join(root,name),{recursive:true,mode:0o700})
app.setPath('userData',join(root,'userdata'));app.setPath('sessionData',join(root,'session'));app.setPath('logs',join(root,'logs'))
app.setPath('temp',join(root,'tmp'));process.env.TEMP=join(root,'tmp');process.env.TMP=join(root,'tmp')
app.commandLine.appendSwitch('disk-cache-dir',join(root,'session','cache'))
registerAppScheme(protocol)
const project=join(root,'project 中文 空格'),modelCalls=[],rendererErrors=[]
let window,host,approvalMode='ask'
const imported=async path=>import(pathToFileURL(join(dist,'src',path)).href)
const {PersonalAgentHost}=await imported('personal-agent/host.js'),{SuggestionPool}=await imported('core/suggestions.js'),{createWorkbenchRuntime}=await imported('personal-agent/workbench-runtime.js')
const {createChatCompletionsLlmFactory}=await imported('realtime/cascaded/chat-completions-llm.js'),{PLAN_LLM_TRANSPORT}=await imported('realtime/cascaded/llm-stream-limits.js')
const resources=process.env.CODEX_RESOURCES_PATH??await prepareWorkbenchTestResources(join(root,'resources'))
const planText='# 完整实施计划\n\n读取 seed.txt，精确修改并用本机 shell 验证；报告真实退出状态。\n\n'+'验收细节必须完整保留。'.repeat(3000)
function factory(build){
 if(!build){let step=0;return createChatCompletionsLlmFactory({provider:'deepseek',baseUrl:'https://example.test',apiKey:'synthetic',model:'test',instructions:'Plan',...PLAN_LLM_TRANSPORT,fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body),current=step++
  assert.equal(body.parallel_tool_calls,true)
  modelCalls.push({build:false,step:current,tools:body.tools.map(tool=>tool.function.name),inputs:body.messages})
  const calls=current===0?[{index:0,id:'plan:read-a',function:{name:'monitor',arguments:'{}'}},{index:1,id:'plan:read-b',function:{name:'monitor',arguments:'{}'}}]:[{index:0,id:'plan:publish',function:{name:'publish_plan',arguments:JSON.stringify({title:'本地工具与暂停恢复',content:planText})}}]
  if(current===1)assert.deepEqual(body.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['plan:read-a','plan:read-b'])
  const event={id:'plan-response-'+current,choices:[{delta:current===2?{content:'请审阅完整计划并选择执行方式。'}:{tool_calls:calls},finish_reason:current===2?'stop':'tool_calls'}]}
  return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}})
 }})}
 return {open(){let step=0;return {
 setHistoryLimits(){},checkpoint:()=>({step}),restoreCheckpoint:state=>{step=state.step},close:async()=>{},abandonPendingResponse:async()=>{},
 async *stream(input){
  modelCalls.push({build,step,tools:input.tools.map(tool=>tool.name),inputs:input.inputs})
  input.signal.throwIfAborted();const current=step++,response_id='r'+current
  yield {kind:'response_started',response_id}
  let call
  if(build){
   if(approvalMode==='never'){
    if(current===0)call={name:'file_write',arguments:{path:'no-confirm.txt',content:'无需确认 · 中文日志'}}
    if(current===1)call={name:'shell_execute',arguments:{command:process.platform==='win32'?"Start-Sleep -Seconds 2; [Console]::Out.Write('无需确认 shell 输出')":"sleep 2; printf '无需确认 shell 输出'"}}
    if(current===2)call={name:'file_read',arguments:{path:'no-confirm.txt'}}
    if(current===4&&input.inputs.some(item=>item.kind==='user_text'&&item.text==='完成并锁定'))call={name:'finish_build',arguments:{summary:'Build 已完成，验证结果已记录。'}}
   }else{
   if(current===0)call={name:'file_read',arguments:{path:'seed.txt'}}
   if(current===1)call={name:'file_edit',arguments:{path:'seed.txt',old_string:'hello',new_string:'你好'}}
   if(current===2)call={name:'shell_execute',arguments:{command:process.platform==='win32'?"[IO.File]::WriteAllText((Join-Path $PWD 'shell.txt'), '中文命令', (New-Object Text.UTF8Encoding($false))); [Console]::Out.Write('stdout 中文'); [Console]::Error.Write('stderr 中文'); exit 7":"printf '中文命令' > shell.txt; printf 'stdout 中文'; printf 'stderr 中文' >&2; exit 7"}}
   if(current===3)call={name:'file_read',arguments:{path:'shell.txt'}}
   if(current===4)call={name:'shell_execute',arguments:{command:process.platform==='win32'?"[IO.File]::WriteAllText((Join-Path $PWD 'running.pid'), [string]$PID); Start-Sleep -Seconds 60":"printf '%s' $$ > running.pid; sleep 60"}}
   }
  }
  if(call)yield {kind:'tool_call',item_id:'i'+current,call_id:(build?'build:':'plan:')+current,...call}
   else yield {kind:'text_delta',text:build?(approvalMode==='never'?(current===3?'文件写入、shell 和读取已完成。\n\n'+('较长 Build 回复必须完整保存。\n').repeat(1400):'无需确认 Build 回复已完成。'):'修改已保存。验证命令退出码为 7，该检查未通过；长命令已停止。'):'请审阅完整计划并选择执行方式。'}
  yield {kind:'response_completed',response_id}
 },
}}}}
let monitoring=0,monitorMaximum=0,monitorCount=0
const bridge={tools:[{name:'monitor',parameters:{type:'object'}}],readonlyNames:['monitor'],origin:async()=> 'fixture-user',invoke:async()=>{monitoring++;monitorCount++;monitorMaximum=Math.max(monitorMaximum,monitoring);await new Promise(resolveWait=>setTimeout(resolveWait,50));monitoring--;return {status:'idle'}}}
const plain={runTurn:async()=>({assistant:'Chat'}),close:async()=>{},toolBridge:bridge}
function send(frame){if(window&&!window.isDestroyed())window.webContents.send('acceptance:frame',frame)}
const delay=()=>new Promise(resolveWait=>setTimeout(resolveWait,25))
async function until(read,predicate,label){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await delay()}throw Error('Acceptance timeout: '+label+'; '+JSON.stringify(await state()))}
const evaluate=async source=>{try{return await window.webContents.executeJavaScript(source)}catch(error){throw Error('Renderer operation '+source.slice(0,200)+': '+error.message)}}
async function capture(name){
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
 await writeFile(join(root,name),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
}
const state=()=>evaluate('window.acceptanceState?.()')
let previousApproval=null
const click=async label=>{
 await until(()=>evaluate(`[...document.querySelectorAll('button')].some(node=>!node.hidden&&!node.disabled&&node.textContent.trim()===${JSON.stringify(label)})`),Boolean,'enabled button '+label)
 if(label==='允许本次'){const value=await state();previousApproval=value.items.find(item=>item.id===value.selected)?.build?.approval?.id}
 return evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>!node.hidden&&!node.disabled&&node.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing enabled button: '+${JSON.stringify(label)});const menu=button.closest('details');if(menu)menu.open=true;button.click()})()`)
}
const choose=async value=>{
 for(let i=0;i<4;i++){
  await until(()=>evaluate(`(()=>{const button=document.querySelector('.composer-mode-active');return !button.disabled&&button.getAttribute('aria-busy')!=='true'})()`),Boolean,'mode ready')
  const current=await evaluate(`document.querySelector('.composer-mode').dataset.mode`)
  if(current===value)return
  await evaluate(`document.querySelector('.composer-mode-active').click()`)
  await until(()=>evaluate(`document.querySelector('.composer-mode').dataset.mode`),mode=>mode!==current,'mode changed')
 }
 assert.equal(await evaluate(`document.querySelector('.composer-mode').dataset.mode`),value)
}

const approval=async name=>{
 await until(state,value=>{const pending=value?.items.find(item=>item.id===value.selected)?.build?.approval;return pending?.name===name&&pending.id!==previousApproval},'approval '+name)
 await until(()=>evaluate(`(()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent==='允许本次');return node&&!node.disabled})()`),Boolean,'complete approval preview')
}
let success=false
const deadline=setTimeout(()=>{console.error('Workbench acceptance deadline expired');app.exit(1)},120000)
async function run(){
try{
 await app.whenReady()
 protocol.handle('nova',request=>{
  const path=resolve(desktop,'.'+decodeURIComponent(new URL(request.url).pathname))
  if(!path.startsWith(desktop+sep)||!(/\.(?:html|mjs|css|mp4)$/.test(path)))return new Response('Forbidden',{status:403})
  return net.fetch(pathToFileURL(path).href)
 })
 await writeFile(join(project,'seed.txt'),'\ufeffhello\r\nkeep\r\n')
 host=new PersonalAgentHost({path:join(root,'state','personal.json'),userScope:'electron-acceptance',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 await host.open()
 host.setConversationRuntime((conversation,emit,_mode,lifetime)=>conversation.mode==='plan'||conversation.kind==='build'?createWorkbenchRuntime({conversation,host,factory:factory(conversation.kind==='build'),createBridge:async()=>plain,emit,lifetime,language:'zh-CN',approval:approvalMode,shell:{...(resources?{resourcesPath:resources}:{}),temporaryRoot:join(root,'tmp')}}):Promise.resolve(plain),send)
 await host.command({type:'personal.command',request_id:'presentation',method:'presentation.set',params:{mode:'workbench'}},{client_id:'desktop:local'})
 host.subscribe(()=>send(host.snapshot()))
 window=new BrowserWindow({show:false,width:1300,height:950,webPreferences:{preload:join(import.meta.dirname,'workbench-agent-integration-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
 window.webContents.on('console-message',event=>{const text=String(event.message);if(text.includes('Uncaught')||event.level==='error'){rendererErrors.push(text);console.error('Renderer: '+text)}})
 ipcMain.handle('acceptance:directory',()=>project)
 ipcMain.on('acceptance:frame',async(event,frame)=>{
  if(event.sender!==window.webContents)return
  try{
   if(frame.type==='personal.command')send(await host.command(frame,{client_id:'desktop:local'}))
   else if(frame.type==='input.text'){await host.submitConversationText(frame.conversation_id,frame.text,frame.request_id,undefined,{local_desktop:true});send({type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true})}
  }catch(error){send(frame.type==='personal.command'?{type:'personal.result',request_id:frame.request_id,ok:false,error:error.message}:{type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:false,error:error.message})}
 })
 ipcMain.on('acceptance:ready',()=>{send({type:'desktop.capabilities',input_instance_id:'acceptance',capabilities:['text_input']});send(host.snapshot())})
 await window.loadURL('nova://orb/scripts/workbench-agent-integration.html')
 await until(state,value=>value?.selected==='chat:main','initial Chat')
 await choose('plan');await until(state,value=>value.items[0].mode==='plan','Plan selection')
 await evaluate(`(()=>{const draft=document.querySelector('[aria-label="消息草稿"]');draft.value='请制定完整计划';draft.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label="发送消息"]').click()})()`)
 await until(state,value=>!!value.items[0].plan,'published plan')
 assert.equal(monitorCount,2);assert.equal(monitorMaximum,2)
 await until(()=>evaluate('document.querySelector(".workbench-plan-body").textContent.length'),value=>value>10000,'paged full plan')
 await click('修改计划');await evaluate(`(()=>{const edit=document.querySelector('[aria-label="计划内容"]');edit.value+=${JSON.stringify('\n用户补充的验收要求。')}})()`);await click('保存计划')
 await until(state,value=>value.items[0].plan.version===2,'edited plan version')
 // Shift+Tab in the draft picks Build as the plan's execution; it promotes the local action and starts nothing.
 const modeKey=()=>evaluate(`(()=>{const draft=document.querySelector('[aria-label="消息草稿"]');draft.focus();const event=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});draft.dispatchEvent(event);return event.defaultPrevented})()`)
 assert.equal(await modeKey(),true)
 await until(()=>evaluate(`document.querySelector('.composer-mode').dataset.mode`),value=>value==='build','Shift+Tab Build mode')
 await until(()=>evaluate(`[...document.querySelectorAll('.workbench-plan-actions button')].find(node=>node.dataset.primary==='true')?.textContent`),value=>value==='在当前项目 Build','Build is the primary plan action')
 assert.equal((await state()).items[0].mode,'plan');assert.equal((await state()).items.some(item=>item.kind==='build'),false)
 await choose('plan');await until(()=>evaluate(`document.querySelector('.composer-mode').dataset.mode`),value=>value==='plan','Plan mode restored')
 await click('选择本地目录…');await until(()=>evaluate('document.querySelector("[aria-label=项目目录]").value'),Boolean,'local directory')
 await click('在当前项目 Build');await approval('file_edit')
 const buildId=(await state()).selected
 await until(()=>evaluate('document.querySelectorAll(".build-tool-group").length'),value=>value===1,'live read and pending edit log group')
 assert.equal(await evaluate('document.querySelectorAll(".build-tool-rows .tool-message").length'),2)
 await evaluate('document.querySelector(".build-tool-call summary").click()')
 assert.equal(await evaluate('document.querySelector(".build-tool-call").open'),true)
 assert.notEqual(buildId,'chat:main');assert.equal(await readFile(join(project,'seed.txt'),'utf8'),'\ufeffhello\r\nkeep\r\n')
 await capture('approval.png')
 await click('允许本次');await approval('shell_execute');assert.equal(await readFile(join(project,'seed.txt'),'utf8'),'\ufeff你好\r\nkeep\r\n')
 assert.equal(await evaluate('document.querySelector(".build-tool-call").open'),true,'snapshot updates preserve tool expansion')
 await click('允许本次');await approval('shell_execute')
 await until(()=>evaluate('document.querySelector(".tool-message-group [data-tool-status=failed]")?.textContent'),value=>value?.includes('退出码 7'),'nonzero exit shown in chat')
 await click('允许本次');await until(()=>readFile(join(project,'running.pid'),'utf8').catch(()=>null),Boolean,'real shell running')
 const runningPid=Number(await readFile(join(project,'running.pid'),'utf8'))
 // Both decisions exercise the actual workbench dialog and controller.
 await click('主对话');await until(()=>evaluate('Boolean(document.querySelector("dialog[open]"))'),Boolean,'switch dialog')
 await click('继续执行');assert.equal((await state()).selected,buildId)
 await click('主对话');await until(()=>evaluate('Boolean(document.querySelector("dialog[open]"))'),Boolean,'second switch dialog');await click('停止并切换')
 await until(state,value=>value.selected==='chat:main','stop then switch')
 await until(()=>{try{process.kill(runningPid,0);return false}catch{return true}},Boolean,'owned process gone')
 assert.equal(host.tasks.list().length,0);assert.equal(host.life.snapshot().todos.length,0)
 await click('本地工具与暂停恢复');await click('Resume');await until(state,value=>value.items.find(item=>item.id===buildId).build.status==='completed','explicit Resume')
 await click('执行记录');await until(()=>evaluate('document.querySelector(".workbench-tool-log").textContent'),value=>value.includes('stderr 中文')&&value.includes('"exit_code": 7'),'actual failed command record')
 const checkpoint=await host.workbench.checkpoint(buildId,0)
 assert.equal(checkpoint.calls.filter(call=>call.name==='file_edit').length,1);assert.ok(checkpoint.calls.some(call=>call.result?.status==='cancelled'))
 assert.ok((await host.workbench.plan(host.conversationSnapshot().items[0].plan.id,2)).content.endsWith('用户补充的验收要求。'))
 assert.ok(modelCalls.filter(call=>!call.build).every(call=>!call.tools.includes('file_read')));assert.equal(rendererErrors.length,0,rendererErrors.join('\n'))
 await capture('completed.png')
 await until(()=>evaluate('({groups:document.querySelectorAll(".build-tool-group").length,calls:document.querySelectorAll(".build-tool-rows .tool-message").length})'),value=>value.groups===1&&value.calls===5,'complete persisted grouped tool log')
 await click('主对话');approvalMode='never'
 await host.publishPlan('chat:main',0,'无需确认的实时操作记录','创建 no-confirm.txt，用 shell 输出，再读取文件。')
 await until(state,value=>value.items[0].plan.version===3,'second approved plan')
 await click('在当前项目 Build')
 await until(()=>evaluate('document.querySelector(".tool-message[data-tool-status=running]")?.textContent'),value=>value?.includes('shell_execute'),'running command without approval')
 const unattendedId=(await state()).selected
 assert.notEqual(unattendedId,buildId)
 assert.equal(await evaluate('document.querySelector(".workbench-local-approval").hidden'),true)
 await capture('running-no-confirmation.png')
 await until(state,value=>value.items.find(item=>item.id===unattendedId)?.build?.status==='completed','unattended build completes')
 await until(()=>evaluate('({groups:document.querySelectorAll(".build-tool-group").length,calls:document.querySelectorAll(".build-tool-rows .tool-message").length})'),value=>value.groups===1&&value.calls===3,'file_write shell_execute file_read grouped logs')
 assert.equal(await readFile(join(project,'no-confirm.txt'),'utf8'),'无需确认 · 中文日志')
 await until(()=>evaluate('Boolean(document.querySelector(".build-full-reply summary"))'),Boolean,'long reply expansion link')
 await evaluate('document.querySelector(".build-full-reply summary").click()')
 await until(()=>evaluate('document.querySelector(".build-full-reply-content").textContent.length'),value=>value>20000,'full long Build reply pages')
 await evaluate(`(()=>{const draft=document.querySelector('[aria-label="消息草稿"]');draft.value='完成并锁定';draft.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label="发送消息"]').click()})()`)
 await until(state,value=>value.items.find(item=>item.id===unattendedId)?.build?.status==='finished','finish_build locks conversation')
 assert.equal(await evaluate('document.querySelector("[aria-label=消息草稿]").disabled'),true)
 assert.equal(await evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="Resume"&&!button.hidden)'),false)
 await evaluate('document.querySelectorAll(".build-tool-call summary").forEach(summary=>summary.click())')
 await capture('tool-log-expanded.png')
 await new Promise(resolveReload=>{window.webContents.once('did-finish-load',resolveReload);window.webContents.reload()})
 await until(state,value=>value?.selected==='chat:main','home after renderer reload')
 await click('无需确认的实时操作记录')
 await until(state,value=>value?.selected===unattendedId,'reopened build')
 await until(()=>evaluate('({groups:document.querySelectorAll(".build-tool-group").length,calls:document.querySelectorAll(".build-tool-rows .tool-message").length})'),value=>value.groups===2&&value.calls===4,'tool logs survive renderer reload')
 assert.equal(rendererErrors.length,0,rendererErrors.join('\n'))
 await writeFile(join(root,'result.json'),JSON.stringify({passed:true,platform:process.platform,electron:process.versions.electron,plan_characters:planText.length,tool_calls:checkpoint.calls.length+4,plan_parallel_queries:monitorCount,task_count:host.tasks.list().length,checks:['Plan batch Chat Completions wire parsing and concurrent queries','Plan publish/edit/full handoff','independent Build','complete approval preview','native file and shell','nonzero stdout/stderr','cancel dialog/stay/stop','native process cleanup','explicit Resume/no replay','no Task/Todo','grouped tool calls and per-call expansion','failed exit shown in chat','full Build reply paging','Build follow-up messages','finish_build permanent lock','no-confirmation build with real shell','logs restore after renderer reload']},null,2))
 console.log('Workbench Electron acceptance passed: '+root);success=true
}catch(error){console.error(error.stack??error);if(window&&!window.isDestroyed())await writeFile(join(root,'failure.png'),(await window.webContents.capturePage()).toPNG()).catch(()=>{})}
finally{clearTimeout(deadline);await host?.close();if(window&&!window.isDestroyed())window.destroy();app.exit(success?0:1)}
}
void run().catch(error=>{console.error(error);app.exit(1)})
