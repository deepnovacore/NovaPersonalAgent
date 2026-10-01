import {app,BrowserWindow,ipcMain} from 'electron'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SubstrateMemoryResource} from '../../../runtime/dist/src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../../../runtime/dist/src/memory-ledger/store-client.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'

const require=createRequire(import.meta.url),Database=require('better-sqlite3')
const required=name=>{const value=process.env[name];if(!value||!isAbsolute(value))throw Error(`${name} must be an absolute path`);return resolve(value)}
const realRoot=required('REAL_PROFILE_ROOT'),output=required('CAPTURE_OUTPUT')
const within=(root,path)=>{const child=relative(root,path);return child===''||(child!=='..'&&!child.startsWith('../')&&!isAbsolute(child))}
async function canonical(path){let ancestor=path;const missing=[];for(;;){try{return resolve(await realpath(ancestor),...missing.reverse())}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;missing.push(basename(ancestor));ancestor=dirname(ancestor)}}}
const realCanonical=await realpath(realRoot),outputCanonical=await canonical(output)
if(within(realCanonical,outputCanonical)||within(outputCanonical,realCanonical))throw Error('capture_path_unsafe')
const repo=fileURLToPath(new URL('../../../',import.meta.url))
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function copyOne(from,to){const size=(await lstat(from)).size;if(size>0&&/\.(?:sqlite|db)$/u.test(basename(from))){const db=new Database(from,{readonly:true,fileMustExist:true});try{await db.backup(to)}finally{db.close()}}else await copyFile(from,to)}
async function copyTree(source,destination){await mkdir(destination,{recursive:true,mode:0o700});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.isSymbolicLink()||/(?:-wal|-shm|\.lock|\.log|\.jsonl)$/u.test(entry.name))continue;const from=join(source,entry.name),to=join(destination,entry.name);if(entry.isDirectory())await copyTree(from,to);else if(entry.isFile())await copyOne(from,to)}}
async function copyProfile(source,destination){await mkdir(destination,{recursive:true,mode:0o700});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const from=join(source,entry.name),to=join(destination,entry.name);if(entry.isFile()&&(/^(?:blackboard|knowledge|workspace-graph|memory)\.sqlite(?:\..*)?$/u.test(entry.name)||/^(?:capabilities|codex-projects-v1)\.json$/u.test(entry.name)))await copyOne(from,to);if(entry.isDirectory()&&['memory.sqlite.mem0','workspace-graph.sqlite.memory','state'].includes(entry.name))await copyTree(from,to)}}
async function main(){
 await mkdir(output,{recursive:true,mode:0o700})
 const copy=await mkdtemp(join(await realpath(tmpdir()),'nova-workbench-offline-')),profile=join(copy,'profile')
 await copyProfile(realRoot,profile)
 const copiedAt=new Date().toISOString()
 app.setPath('userData',join(copy,'electron'))
 const personalPath=join(profile,'blackboard.sqlite.personal.json'),owner=JSON.parse(await readFile(personalPath,'utf8'))
 const sourceFile=JSON.parse(await readFile(personalPath+'.sources.json','utf8'))
 const sources=(sourceFile.sources??[]).map(record=>record.view)
 const tasksFile=JSON.parse(await readFile(personalPath+'.tasks.json','utf8').catch(()=>'{"tasks":[]}'))
 const gateway={complete:()=>Promise.reject(Error('offline_capture_model_disabled')),stream:()=>{throw Error('offline_capture_model_disabled')}}
 const client=new MemoryLedgerClient(join(profile,'workspace-graph.sqlite'))
 const memory=new SubstrateMemoryResource({client,userId:owner.user_scope,gateway,model:'disabled',inputConsent:false,consolidation:{enabled:false}})
 const host=new PersonalAgentHost({path:personalPath,userScope:owner.user_scope,memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let window
 try{
  await app.whenReady();await memory.open();await host.open()
  const snapshot=()=>({...host.snapshot(),sources})
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
  const shot=async(name,label)=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await writeFile(join(output,`${name}.png`),(await window.webContents.capturePage()).toPNG(),{mode:0o600});images.push({file:`${name}.png`,label,heading:await js("document.querySelector('.page-title')?.textContent??''"),suggestion_cards:await js("document.querySelectorAll('.workbench-suggestions .card').length")})}
  for(const [name,page,label] of [['01-todos','todos','待办'],['02-ideas','ideas','想法'],['03-goals','goals','目标'],['04-feeds','feeds','资讯'],['05-tasks','tasks','Agent 任务'],['06-profile','profile','关于我']]){await js(`document.querySelector('.rail-pages [data-page=${JSON.stringify(page)}]')?.click()`);await sleep(200);await shot(name,label)}
  await js("document.querySelector('.memory-section summary')?.click();document.querySelector('.memory-section')?.scrollIntoView({block:'start'})");await sleep(150);await shot('07-profile-memory-expanded','记忆总览展开')
  await js("document.querySelector('.memory-group-details summary')?.click();document.querySelector('.memory-group-details')?.scrollIntoView({block:'start'})");await sleep(150);await shot('08-profile-memory-detail','记忆详情')
  await js("document.querySelector('.rail-pages [data-page=\"todos\"]')?.click();document.querySelector('.chat-toggle')?.click()");await sleep(150);await shot('09-todos-chat-collapsed','待办 · 收起对话栏')
  await js('window.view.controller.collapse(true)');window.setSize(220,84);await sleep(200);await shot('10-desktop-orb','桌面悬浮入口')
  const report={capture_type:'real local data on isolated profile copy; offline Electron renderer',commit,copied_at:copiedAt,captured_at:new Date().toISOString(),source_count:sources.length,source_scan_state:sources.map(source=>({scope:source.scope,state:source.state,scan_pending:source.scan_pending??false,indexed:source.indexed??0})),indexed_files:sources.reduce((sum,source)=>sum+(source.indexed??0),0),images,model_calls:0,fixture_records:0,limitations:['This is the changed Electron renderer with a copied real local profile, not a connected production backend.','Model generation and external network calls were disabled; suggestions were not injected.']}
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
  const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
  await writeFile(join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Nova 工作台 · 真实数据离线截图</title><style>body{font:16px/1.6 system-ui;background:#12141b;color:#f2f4f8;margin:0;padding:40px;max-width:1450px}h1{font-size:28px}p{color:#aab1bf}section{margin:32px 0 55px}img{display:block;max-width:100%;border:1px solid #353c4a;border-radius:12px}code{color:#b5c8ff}</style><h1>Nova 工作台 · 真实数据离线截图</h1><p>真实本机资料的隔离副本；新版 Electron 渲染器；模型和外部网络调用关闭；没有注入示例记录或建议。提交：<code>${escape(commit.slice(0,12))}</code>。</p>${images.map((item,index)=>`<section><h2>${index+1}. ${escape(item.label)}</h2><p>${escape(item.heading)}${index<2?` · 当前建议卡片 ${item.suggestion_cards}`:''}</p><a href="${escape(item.file)}"><img src="${escape(item.file)}" alt="${escape(item.label)}"></a></section>`).join('')}</html>`,{mode:0o600})
  console.log(JSON.stringify({status:'passed',index:join(output,'index.html'),images:images.length,report:join(output,'report.json')}))
 }catch(error){console.error(JSON.stringify({status:'failed',error:error instanceof Error?error.stack:String(error),output}));process.exitCode=1}
 finally{await host.close().catch(()=>{});await memory.close().catch(()=>{});try{await rm(profile,{recursive:true,force:true})}catch(error){console.error('isolated_profile_cleanup_failed',error);process.exitCode=1}window?.destroy();await rm(copy,{recursive:true,force:true}).catch(()=>{});app.exit(process.exitCode??0)}
}
void main().catch(error=>{console.error(error);app.exit(1)})
