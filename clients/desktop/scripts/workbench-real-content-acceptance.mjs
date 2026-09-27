import {app,BrowserWindow,ipcMain} from 'electron'
import {execFileSync,spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SubstrateMemoryResource} from '../../../runtime/dist/src/memory-substrate/resource.js'
import {WorkspaceGraphStoreClient} from '../../../runtime/dist/src/workspace-graph/store-client.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
import {LocalDirectorySources} from '../../../runtime/dist/src/personal-agent/sources.js'
import {GatewayPersonalWriter} from '../../../runtime/dist/src/model/personal-writer.js'
import {selectContextCandidates} from '../../../runtime/dist/src/personal-agent/context-candidates.js'
import {KnowledgeService} from '../../../runtime/dist/src/knowledge/service.js'
import {KnowledgeStoreClient} from '../../../runtime/dist/src/knowledge/store-client.js'

const require=createRequire(import.meta.url),Database=require('better-sqlite3')
const required=name=>{const value=process.env[name];if(!value||!isAbsolute(value))throw Error(`${name} must be an absolute path`);return resolve(value)}
const realRoot=required('REAL_PROFILE_ROOT'),output=required('CAPTURE_OUTPUT')
const activeProject=process.env.ACTIVE_PROJECT_ROOT?required('ACTIVE_PROJECT_ROOT'):null
const repo=fileURLToPath(new URL('../../../',import.meta.url))
const within=(root,path)=>{const child=relative(root,path);return child===''||(child!=='..'&&!child.startsWith('../')&&!isAbsolute(child))}
async function canonical(path){let ancestor=path;const missing=[];for(;;){try{return resolve(await realpath(ancestor),...missing.reverse())}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;missing.push(basename(ancestor));ancestor=dirname(ancestor)}}}
const realCanonical=await realpath(realRoot),outputCanonical=await canonical(output)
if(within(realCanonical,outputCanonical)||within(outputCanonical,realCanonical)||within(repo,outputCanonical))throw Error('capture_path_unsafe')
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()
const treeStatus=execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim()
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.on('window-all-closed',()=>{})
function claudeCompletion(request){
 return new Promise((resolve,reject)=>{
  if(request.signal?.aborted)return reject(request.signal.reason)
  const {$schema:_schema,...cliSchema}=request.jsonSchema
  const args=['-p','--bare','--model','claude-opus-5-5','--tools','','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(cliSchema),'--system-prompt',request.system]
  const child=spawn('claude',args,{stdio:['pipe','pipe','pipe']})
  let stdout='',stderr=''
  const fail=()=>{child.kill();reject(request.signal?.reason??Error('model_aborted'))}
  request.signal?.addEventListener('abort',fail,{once:true})
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>2_000_000)child.kill()})
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10_000)})
  child.stdin.on('error',reject)
  child.on('error',reject)
  child.on('close',code=>{request.signal?.removeEventListener('abort',fail);if(code!==0){let detail=stderr.slice(-500);try{const result=JSON.parse(stdout);detail=JSON.stringify({subtype:result.subtype,result:String(result.result??'').slice(0,500),api_error_status:result.api_error_status})}catch{}return reject(Error(`claude_cli_failed:${code}:${detail}`))}try{const result=JSON.parse(stdout);if(result.is_error||!result.structured_output)throw Error('claude_no_structured_output');resolve({text:JSON.stringify(result.structured_output)})}catch(error){reject(error)}})
  child.stdin.end(request.prompt)
 })
}
async function copyOne(from,to){const size=(await lstat(from)).size;if(size>0&&/\.(?:sqlite|db)$/u.test(basename(from))){const db=new Database(from,{readonly:true,fileMustExist:true});try{await db.backup(to)}finally{db.close()}}else await copyFile(from,to)}
async function copyTree(source,destination){await mkdir(destination,{recursive:true,mode:0o700});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.isSymbolicLink()||/(?:-wal|-shm|\.lock|\.log|\.jsonl)$/u.test(entry.name))continue;const from=join(source,entry.name),to=join(destination,entry.name);if(entry.isDirectory())await copyTree(from,to);else if(entry.isFile())await copyOne(from,to)}}
async function copyProfile(source,destination){await mkdir(destination,{recursive:true,mode:0o700});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.isSymbolicLink()||/(?:-wal|-shm|\.lock|\.log|\.jsonl)$/u.test(entry.name))continue;const from=join(source,entry.name),to=join(destination,entry.name);if(entry.isFile()&&(/^(?:blackboard|knowledge|workspace-graph|memory)\.sqlite(?:\..*)?$/u.test(entry.name)||/^(?:capabilities|codex-projects-v1)\.json$/u.test(entry.name)))await copyOne(from,to);if(entry.isDirectory()&&['memory.sqlite.mem0','workspace-graph.sqlite.memory','state'].includes(entry.name))await copyTree(from,to)}}
async function main(){
 await mkdir(output,{recursive:true,mode:0o700})
 await chmod(output,0o700)
 await rm(join(output,'index.html'),{force:true})
 const copy=await mkdtemp(join(await realpath(tmpdir()),'nova-workbench-offline-')),profile=join(copy,'profile')
 let window,host,memory,accepted=false,capturedImages=0
 try{
 await copyProfile(realRoot,profile)
 const copiedAt=new Date().toISOString()
 app.setPath('userData',join(copy,'electron'))
 const personalPath=join(profile,'blackboard.sqlite.personal.json'),owner=JSON.parse(await readFile(personalPath,'utf8'))
 const sourceFile=JSON.parse(await readFile(personalPath+'.sources.json','utf8'))
 let sourceRecords=sourceFile.sources??[]
 if(sourceRecords.length!==1||!sourceRecords[0]?.processing_consent)throw Error('expected_one_consented_local_source')
 let sourcePath=personalPath+'.sources.json'
 if(activeProject){
  if(!within(sourceRecords[0].view.path,activeProject)||await realpath(activeProject)!==activeProject)throw Error('active_project_outside_computer_grant')
  sourcePath=join(profile,'acceptance-active.sources.json')
  const knowledge=new KnowledgeService({store:new KnowledgeStoreClient({path:join(profile,'acceptance-active-knowledge.sqlite')}),embedding:{id:'acceptance-only',dims:2,embed:async texts=>texts.map(()=>new Float32Array([1,0]))}})
  await knowledge.open()
  const scan=new LocalDirectorySources({path:sourcePath,computerRoot:activeProject,knowledge,pollMs:0,processingGrant:()=>sourceRecords[0].processing_consent,onInvalidate:async()=>{},onObserve:async()=>{},onChange:async()=>{}})
  try{await scan.open();const {id}=await scan.command('sources.authorize_computer',{consent:true});await scan.command('sources.sync',{id})}finally{await scan.close().catch(()=>{});await knowledge.close().catch(()=>{})}
  sourceRecords=JSON.parse(await readFile(sourcePath,'utf8')).sources
 }
 await rm(personalPath+'.context.json',{force:true})
 const tasksFile=JSON.parse(await readFile(personalPath+'.tasks.json','utf8').catch(()=>'{"tasks":[]}'))
 const gateway={complete:()=>Promise.reject(Error('offline_capture_model_disabled')),stream:()=>{throw Error('offline_capture_model_disabled')}}
 const client=new WorkspaceGraphStoreClient(join(profile,'workspace-graph.sqlite'))
 memory=new SubstrateMemoryResource({client,userId:owner.user_scope,gateway,model:'disabled',inputConsent:false,consolidation:{enabled:false}})
 let modelCalls=0
 let modelError=null
 const modelFailures=[]
 const modelGateway={complete:async request=>{for(let attempt=0;attempt<3;attempt++){request.signal?.throwIfAborted();modelCalls++;try{return await claudeCompletion(request)}catch(error){const message=error instanceof Error?error.message:String(error);modelFailures.push(message);if(!/API Error: 400 Upstream request error|ENOTFOUND|Can't reach the API server/u.test(message)||attempt===2){modelError=message;console.error('acceptance_model_failed',modelError);throw error}await sleep(1000*(attempt+1))}}throw Error('unreachable_model_retry')},stream:()=>{throw Error('model_stream_unavailable')}}
 const writer=new GatewayPersonalWriter({gateway:modelGateway,model:'claude-opus-5-5'})
 const grant=sourceRecords[0]?.processing_consent
 const localSources=new LocalDirectorySources({path:sourcePath,pollMs:0,scanOnOpen:false,
  processingGrant:()=>grant,
  knowledge:{listSources:async()=>[],handle:async()=>{throw Error('snapshot_read_only')},syncFile:async()=>{throw Error('snapshot_read_only')}}})
 host=new PersonalAgentHost({path:personalPath,userScope:owner.user_scope,memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateContext:writer.generateContext})
 host.setSources(localSources)
  await app.whenReady();await memory.open();await host.open()
  const sourceEntries=localSources.contextEntries()
  const selected=selectContextCandidates(sourceEntries)
  const before=host.snapshot().workbench_context
  await host.workbenchContext.refresh()
  const after=host.snapshot().workbench_context
  if(before.candidate_count>0&&(after.status!=='ready'||modelCalls<1||modelError!==null))throw Error(`generation_not_ready:${after.status}:${modelError??'no_model_result'}`)
  if(before.candidate_count===0&&(modelCalls!==0||after.empty_reason!=='no_eligible_sources'||after.cards.length!==0))throw Error('empty_candidate_state_invalid')
  const snapshot=()=>host.snapshot()
  ipcMain.handle('capture-state',()=>snapshot())
  ipcMain.handle('capture-command',async(_event,frame)=>frame.method==='presentation.set'?host.command(frame):{type:'personal.result',request_id:frame.request_id,ok:false,error:'offline_capture_read_only'})
  const preload=join(copy,'preload.cjs');await writeFile(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('capture',{state:()=>ipcRenderer.invoke('capture-state'),command:frame=>ipcRenderer.invoke('capture-command',frame)});",{mode:0o600})
  const module=pathToFileURL(join(repo,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(repo,'clients/desktop/src/renderer/workbench.css')).href
  const taskJson=JSON.stringify(tasksFile.tasks??[]).replaceAll('<','\\u003c')
  const html=join(copy,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';window.view=mountPersonalView({send:frame=>{window.capture.command(frame).then(result=>window.view.receive(result));return true},start:async()=>{},stop:async()=>{},tasks:()=>({tasks:${taskJson}}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle(){return false}},orbMenu:{openSettings(){}}}});window.view.controller.connect();window.view.receive({type:'client.ready',input_instance_id:'offline-real-data',capabilities:['text_input']});window.view.receive(await window.capture.state());window.ready=true;</script>`,{mode:0o600})
  window=new BrowserWindow({width:1440,height:950,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}})
  await window.loadFile(html)
  const js=expression=>window.webContents.executeJavaScript(expression)
  for(let i=0;i<100&&!await js('window.ready===true');i++)await sleep(100)
  if(!await js('window.ready===true'))throw Error('renderer_not_ready')
  const images=[]
  const shot=async(name,label)=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await writeFile(join(output,`${name}.png`),(await window.webContents.capturePage()).toPNG(),{mode:0o600});images.push({file:`${name}.png`,label,heading:await js("document.querySelector('.page-title')?.textContent??''"),suggestion_cards:await js("document.querySelectorAll('.workbench-suggestions .card').length"),suggestion_titles:await js("[...document.querySelectorAll('.workbench-suggestions .card h3')].map(node=>node.textContent)"),recap:await js("document.querySelector('.workbench-recap')?.innerText??null")})}
  for(const [name,page,label] of [['01-todos','todos','待办'],['02-ideas','ideas','想法'],['03-goals','goals','目标'],['04-feeds','feeds','资讯'],['05-tasks','tasks','Agent 任务'],['06-profile','profile','关于我']]){const clicked=await js(`Boolean(document.querySelector('.rail-pages [data-page=${JSON.stringify(page)}]'))`);if(!clicked)throw Error(`page_missing:${page}`);await js(`document.querySelector('.rail-pages [data-page=${JSON.stringify(page)}]').click()`);await sleep(200);await shot(name,label);if(!images.at(-1).heading.includes(label==='Agent 任务'?'任务':label))throw Error(`page_mismatch:${page}`)}
  await js("document.querySelector('.memory-section summary')?.click();document.querySelector('.memory-section')?.scrollIntoView({block:'start'})");await sleep(150);await shot('07-profile-memory-expanded','记忆总览展开')
  await js("document.querySelector('.memory-group-details summary')?.click();document.querySelector('.memory-group-details')?.scrollIntoView({block:'start'})");await sleep(150);await shot('08-profile-memory-detail','记忆详情')
  await js("document.querySelector('.rail-pages [data-page=\"todos\"]')?.click();document.querySelector('.chat-toggle')?.click()");await sleep(150);await shot('09-todos-chat-collapsed','待办 · 收起对话栏')
  await js('void window.view.controller.collapse(true); true');window.setSize(220,84);await sleep(200);await shot('10-desktop-orb','桌面悬浮入口')
  capturedImages=images.length
  const sources=localSources.list()
  const matched=['todos','ideas'].every(tab=>{const image=images.find(item=>item.file===`0${tab==='todos'?1:2}-${tab}.png`);const expected=after.cards.filter(card=>card.tab===tab).slice(0,3);return image?.suggestion_cards===expected.length&&JSON.stringify(image.suggestion_titles)===JSON.stringify(expected.map(card=>card.title))})
  const grounded=after.cards.every(card=>selected.some(candidate=>candidate.candidate_id===card.candidate_id&&card.refs.every(ref=>candidate.refs.some(allowed=>allowed.entry_id===ref.entry_id&&allowed.version===ref.version))))
  if(treeStatus||before.candidate_count!==selected.length||!matched||!grounded)throw Error(`content_acceptance_failed:${after.status}:${modelError??'validation_failed'}`)
  const scanIncomplete=sources.some(source=>source.scan_pending||source.state==='error')
  const report={capture_type:activeProject?'fresh focused scan of real active-project files on isolated profile copy; production candidate selector, Claude Opus 5.5, Electron renderer':'real local source state and files on isolated profile copy; production candidate selector, Claude Opus 5.5, Electron renderer',commit,copied_at:copiedAt,captured_at:new Date().toISOString(),authorization:'User explicitly authorized sending local code, documents, and data to Claude Opus 5.5 for this acceptance; saved source grant is reused only on the isolated copy.',active_project_root:activeProject,source_count:sources.length,source_scan_state:sources.map(source=>({scope:source.scope,state:source.state,scan_pending:source.scan_pending??false,indexed:source.indexed??0,stored_processing_grant_present:!!sourceRecords.find(record=>record.view.id===source.id)?.processing_consent})),indexed_files:sources.reduce((sum,source)=>sum+(source.indexed??0),0),source_context_entries:sourceEntries.length,document_context_entries:sourceEntries.filter(entry=>entry.kind==='file'&&entry.role==='document').length,candidate_count_before_generation:before.candidate_count,candidate_count_after_generation:after.candidate_count,candidates:selected.map(candidate=>({tab:candidate.tab,reason_code:candidate.reason_code,priority:candidate.priority,source_path:sourceEntries.find(entry=>entry.id===candidate.refs[0]?.entry_id)?.rel_path??null})),generation_status:after.status,generation_empty_reason:after.empty_reason,generated_cards:after.cards.length,card_tabs:after.cards.map(card=>card.tab),images,model_calls:modelCalls,model_retry_errors:modelFailures,model_error:modelError,model:'claude-opus-5-5',fixture_records:0,limitations:[activeProject?'The focused scan covers only the selected active project and two initial source batches; it does not certify the whole-computer backlog.':'The test uses the real local source index on an isolated profile copy; it does not run a new whole-computer scan.',...(scanIncomplete?['The local source has incomplete scanning, so unindexed files are outside this acceptance.']:[]),'The model is the explicitly authorized Claude Opus 5.5 CLI, not the user-configured production provider.']}
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
  const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
  await writeFile(join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Nova 工作台 · 本机内容链路验收</title><style>body{font:16px/1.6 system-ui;background:#12141b;color:#f2f4f8;margin:0;padding:40px;max-width:1450px}h1{font-size:28px}p{color:#aab1bf}section{margin:32px 0 55px}img{display:block;max-width:100%;border:1px solid #353c4a;border-radius:12px}code{color:#b5c8ff}</style><h1>Nova 工作台 · 本机内容链路验收</h1><p>${activeProject?'当前仓库的真实文件在隔离副本中重新扫描':'本机真实资料的隔离副本'}，接入了来源、候选筛选、Claude Opus 5.5 和新版 Electron 页面；未注入示例数据。来源摘要 ${sourceEntries.length} 条，候选 ${after.candidate_count} 条，模型调用 ${modelCalls} 次，生成卡片 ${after.cards.length} 张。${scanIncomplete?'来源扫描尚未完成。':''}详情见 <a href="report.json">report.json</a>。提交：<code>${escape(commit.slice(0,12))}</code>。</p>${images.map((item,index)=>`<section><h2>${index+1}. ${escape(item.label)}</h2><p>${escape(item.heading)}${index<2?` · 页面建议卡片 ${item.suggestion_cards}`:''}</p><a href="${escape(item.file)}"><img src="${escape(item.file)}" alt="${escape(item.label)}"></a></section>`).join('')}</html>`,{mode:0o600})
  accepted=true
 }catch(error){console.error(JSON.stringify({status:'failed',error:error instanceof Error?error.stack:String(error),output}))}
 finally{await host?.close().catch(()=>{});await memory?.close().catch(()=>{});try{await rm(profile,{recursive:true,force:true})}catch(error){console.error('isolated_profile_cleanup_failed',error);accepted=false}window?.destroy();await sleep(1500);try{await rm(copy,{recursive:true,force:true,maxRetries:10,retryDelay:200})}catch(error){console.error('isolated_browser_cleanup_failed',error);accepted=false}if(accepted)console.log(JSON.stringify({status:'passed',index:join(output,'index.html'),images:capturedImages,report:join(output,'report.json')}));process.exit(accepted?0:1)}
}
void main().catch(error=>{console.error(error);app.exit(1)})
