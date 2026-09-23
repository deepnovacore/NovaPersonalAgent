// Run after the runtime build: electron clients/desktop/scripts/profile-warmup-smoke.mjs
// Real renderer + host; generation and RSS are deterministic fixtures, no personal data or network.
import {app,BrowserWindow,ipcMain,nativeTheme} from 'electron'
import {mkdtemp,realpath,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
async function main(){
const root=fileURLToPath(new URL('../../../',import.meta.url)),output=resolve(process.env.NOVA_WARMUP_OUTPUT??join(root,'output/profile-warmup'))
const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-ui-'));app.setPath('userData',join(dir,'electron'));await mkdir(output,{recursive:true})
const date=new Date().toISOString(),entry={id:'voice',version:1,content:'我研究语音交互，喜欢阅读科技产品和设计资讯。',origin:'stated',evidence_refs:['fixture:voice'],kind:'fact',source_refs:[{type:'conversation',ref:'conversation:fixture',observed_at:date}],observed_at:date,recorded_at:date,topic:'voice',status:'active',corrected_to:null,confidence_note:null}
const refs=[{entry_id:entry.id,version:entry.version}],draft={about:{text:'我研究语音交互，关注科技产品与设计。',refs},interests:[{text:'语音交互',refs},{text:'科技产品',refs},{text:'设计',refs}]}
let release,failSave=false,window
const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'warmup-fixture',memory:()=>({list:async()=>({entries:[entry],cursor:null}),get:async()=>entry,canProcessEvidence:async()=>true}),pool:new SuggestionPool(),evidence:()=>null,generateProfile:()=>new Promise(resolve=>{release=()=>resolve(draft)})})
host.news.options.fetcher=async()=>new Response('<rss><channel><item><title>让语音交互更自然的设计方法</title><link>https://example.com/voice</link><description>围绕反馈、打断和等待，设计更清晰的对话体验。</description></item></channel></rss>')
host.news.options.rank=async(interests,articles)=>articles.map(a=>({id:a.id,matches:[{interest_id:interests[0].id,score:.9,quote:'语音交互'}],reason:'与你关注的语音交互相关'}))
const report={checks:[],errors:[],screenshots:[]}
const unsubscribe=host.subscribe(()=>window?.webContents.send('warmup-frame',host.snapshot()))
ipcMain.handle('warmup-command',async(_event,frame)=>{if(failSave&&frame.method==='news.configure')return {type:'personal.result',request_id:frame.request_id,ok:false,error:'test_save_failure'};return host.command(frame)})
ipcMain.handle('warmup-state',()=>host.snapshot())
const preload=join(dir,'preload.cjs');await writeFile(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('space',{command:f=>ipcRenderer.invoke('warmup-command',f),state:()=>ipcRenderer.invoke('warmup-state'),listen:cb=>ipcRenderer.on('warmup-frame',(_,f)=>cb(f))});")
const module=pathToFileURL(join(root,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(root,'clients/desktop/src/renderer/workbench.css')).href
const html=join(dir,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';window.view=mountPersonalView({send:f=>{window.space.command(f).then(r=>window.view.receive(r));return true},start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle(){}},orbMenu:{openSettings(){}}}});window.space.listen(f=>window.view.receive(f));window.view.controller.connect();window.view.receive({type:'client.ready',input_instance_id:'warmup-fixture',capabilities:['text_input']});window.view.receive(await window.space.state());window.ready=true;</script>`)
const js=code=>window.webContents.executeJavaScript(code)
const wait=async predicate=>{for(let i=0;i<200;i++){if(await js(predicate))return;await new Promise(r=>setTimeout(r,50))}throw Error('UI timeout: '+predicate)}
const click=label=>js(`(()=>{const b=[...document.querySelectorAll('button')].findLast(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('button unavailable: '+${JSON.stringify(label)});b.click()})()`)
const capture=async name=>{await new Promise(r=>setTimeout(r,150));await writeFile(join(output,name),(await window.webContents.capturePage()).toPNG());report.screenshots.push(name)}
try{
 await app.whenReady();console.log('Electron ready');nativeTheme.themeSource='light';await host.open();console.log('Host ready')
 window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
 window.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message)})
 await window.loadFile(html);await wait('window.ready===true');await click('Profile')
 await wait("document.querySelector('.warmup-spinner')!==null");assert.equal(host.life.snapshot().profile.about,'');assert.equal(host.news.snapshot().enabled,false);await capture('profile-warming.png');report.checks.push('real pending generation shows a spinner without writing facts or consent')
 release();await host.profileWarmup.refresh();await wait("document.querySelector('.profile-preview')!==null&&!document.querySelector('.warmup-spinner')");await capture('profile-ready.png')
 assert.equal(await js("document.querySelectorAll('.preference-card textarea').length"),0);report.checks.push('generated profile and topics render as preview cards with no textareas')
 await click('编辑介绍');await js("(()=>{const input=document.querySelector('[aria-label=\"关于我\"]');input.value='我的手动介绍';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()})()")
 await host.refreshMemory();await wait("document.querySelector('[aria-label=\"关于我\"]').value==='我的手动介绍'")
 await click('保存介绍');await wait("window.view.controller.snapshot.life.profile.about==='我的手动介绍'");report.checks.push('background state updates preserve the profile edit and explicit save persists it')
 await click('Feeds');await click('调整兴趣');await js("(()=>{const b=document.querySelector('[aria-label=\"设计\"]');b.focus();b.click()})()");assert.equal(await js("document.activeElement?.getAttribute('aria-label')"),'设计');report.checks.push('tag toggles preserve keyboard focus');await js("document.querySelector('[aria-label=\"自定义兴趣\"]').focus()")
 await js("(()=>{const i=document.querySelector('[aria-label=\"自定义兴趣\"]');i.value='交互设计';i.dispatchEvent(new Event('input',{bubbles:true}))})()");await click('添加')
 failSave=true;await click('完成调整');await wait("document.querySelector('.preference-error')!==null");assert.ok(await js("document.querySelector('[aria-label=\"选择兴趣\"]').textContent.includes('交互设计')"));report.checks.push('failed save retains adjusted topics and offers retry')
 failSave=false;await click('完成调整');await wait("window.view.controller.snapshot.news.interests.some(i=>i.text==='交互设计')")
 await click('开启资讯');await wait("window.view.controller.snapshot.news.enabled&&!window.view.controller.snapshot.news.refreshing");assert.ok(host.news.snapshot().items.length);await capture('feeds-ready.png');report.checks.push('one explicit enable action uses prepared topics and obtains fixture news')
 await click('Profile');nativeTheme.themeSource='dark';await new Promise(r=>setTimeout(r,150));await capture('profile-dark.png')
 await click('收起对话栏');window.setSize(620,900);await new Promise(r=>setTimeout(r,150));assert.equal(await js('document.documentElement.scrollWidth>window.innerWidth'),false);await capture('profile-narrow.png');report.checks.push('dark theme and narrow window render without horizontal page overflow')
 assert.deepEqual(report.errors,[]);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack}
finally{unsubscribe();await host.close();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));window?.destroy();app.exit(report.status==='passed'?0:1)}

}
void main().catch(error=>{console.error(error);app.exit(1)})
