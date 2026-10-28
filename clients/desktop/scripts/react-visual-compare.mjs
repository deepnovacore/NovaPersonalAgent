import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createServer} from 'node:http'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname,extname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {build} from 'esbuild'

// Reproduce with: node clients/desktop/scripts/react-visual-compare.mjs --phase before|after
// All generated files, git exports and browser artifacts stay in the explicit /tmp root.
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const run=promisify(execFile)
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1]}
const phase=option('--phase','before'),output=resolve(option('--output','/tmp/nova-react-validation'))
const skipSettings=args.includes('--skip-settings')
assert.ok(['before','after'].includes(phase),'phase must be before or after')
assert.ok(output.startsWith('/tmp/'),'Visual output must use the user approved /tmp filesystem')
const phaseRoot=join(output,phase),baselineSource=join(output,'before/source')
await mkdir(phaseRoot,{recursive:true})
if(phase==='before'){
 await mkdir(baselineSource,{recursive:true})
 const archive=join(phaseRoot,'baseline.tar')
 await run('git',['archive','--output',archive,option('--base','ea0fd201'),'clients/desktop/src/renderer'],{cwd:repo})
 await run('tar',['-xf',archive,'-C',baselineSource])
}
const baselineRenderer=join(baselineSource,'clients/desktop/src/renderer')
const renderer=phase==='before'?baselineRenderer:resolve(option('--renderer',join(output,'after')))
const sourceRenderer=join(repo,'clients/desktop/src/renderer')
const fixturePath=join(repo,'clients/desktop/test/react-fixtures/personal-state.mjs')
const browserFixture=`
${phase==='after'?`import '@radix-ui/themes/styles.css';`:''}
import {personalState,settingsView} from ${JSON.stringify(fixturePath)};
import {mountPersonalView} from ${JSON.stringify(phase==='before'?join(baselineRenderer,'personal-view.mjs'):join(sourceRenderer,'react/personal-view.tsx'))};
const callbacks={},frames=[],held=[],settingsCalls=[];
let hold=false,rejectNext=false;
const noop=()=>{};
const endpoint=new Proxy({}, {get:(_,key)=>{
 if(String(key).startsWith('on'))return callback=>{callbacks[key]=callback;return noop};
 if(key==='get')return async()=>structuredClone(settingsView);
 if(key==='set')return async patch=>{settingsCalls.push(patch);return {...structuredClone(settingsView),saved:true}};
 return async()=>({});
}});
window.novaPersonalAgentDesktop={personal:endpoint,orbMenu:endpoint,windowControls:endpoint,windowDrag:endpoint,settings:endpoint,chatgpt:endpoint,wakeWord:endpoint};
if(location.pathname.endsWith('settings.html')){
 ${skipSettings?'':`await import(${JSON.stringify(phase==='before'?join(baselineRenderer,'settings.mjs'):join(sourceRenderer,'react/entries/settings.tsx'))});`}
 window.visualFixture={frames,callbacks,settingsView,settingsCalls};
}else{
 let view;
 const reply=frame=>{
  if(frame.type==='personal.command'){
   if(rejectNext){rejectNext=false;view.receive({type:'personal.result',request_id:frame.request_id,ok:false,error:'version_conflict'});return}
   let data=frame.method==='presentation.set'?{mode:frame.params.mode}:frame.method?.startsWith('conversations.')?personalState().conversations:{};
   view.receive({type:'personal.result',request_id:frame.request_id,ok:true,data});
  }
  if(frame.type==='input.text')view.receive({type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true});
 };
 const send=frame=>{frames.push(frame);if(hold&&frame.method==='life.mutate')held.push(frame);else queueMicrotask(()=>reply(frame));return true};
 view=mountPersonalView({send,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[],taskAction:async()=>{},api:window.novaPersonalAgentDesktop,speakingLevel:()=>0});
 await view.controller.connect();
 view.receive({type:'desktop.capabilities',input_instance_id:'visual-fixture',capabilities:['text_input','dictation']});
 view.receive(personalState());
 window.visualFixture={view,frames,state:personalState,hold:()=>{hold=true},release:()=>{hold=false;for(const frame of held.splice(0))reply(frame)},rejectNext:()=>{rejectNext=true},disconnect:()=>view.controller.disconnect(),connect:async()=>{await view.controller.connect();view.receive({type:'desktop.capabilities',input_instance_id:'visual-fixture',capabilities:['text_input','dictation']});view.receive(personalState(2));}};
}
document.documentElement.dataset.fixtureReady='true';
`
await build({stdin:{contents:browserFixture,resolveDir:repo,sourcefile:'visual-fixture.mjs'},bundle:true,format:'esm',platform:'browser',target:'chrome140',jsx:'automatic',outfile:join(phaseRoot,'visual-fixture.mjs'),nodePaths:[join(repo,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'})
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.mp4':'video/mp4'}
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const production=pathname.startsWith('/production/');
  let file=resolve(renderer,'.'+(production?pathname.slice('/production'.length):pathname));
  if(!file.startsWith(renderer+'/'))throw Error('invalid path');
  if(pathname==='/visual-fixture.mjs'||pathname==='/visual-fixture.css')file=join(phaseRoot,pathname.slice(1));
  if(pathname.endsWith('.html')&&!production){
   // Use each production document for settings; workbench uses unchanged shell geometry
   // while the isolated view has its own host. No audio/video/camera runtime is started.
   let html=await readFile(join(pathname==='/settings.html'?renderer:baselineRenderer,pathname.slice(1)),'utf8');
   html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
   if(phase==='after'&&pathname==='/index.html')html=html.replace('</head>','<link rel="stylesheet" href="./theme.css"><link rel="stylesheet" href="./visual-fixture.css"></head>').replace('<body>','<body><div id="personal-root"></div><div id="personal-orb-host"></div>');
   if(phase==='after'&&pathname==='/settings.html')html=html.replace('</head>','<link rel="stylesheet" href="./visual-fixture.css"></head>');
   res.writeHead(200,{'content-type':'text/html'});res.end(html.replace('</body>','<script type="module" src="./visual-fixture.mjs"></script></body>'));return;
  }
  const bytes=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream'});res.end(bytes);
 }catch{res.writeHead(404);res.end('not found')}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:option('--chromium','/usr/bin/chromium'),args:['--no-sandbox']});
const results={phase,base:option('--base','ea0fd201'),viewport:{width:1440,height:1000},captures:[],production:[],checks:[],errors:[]};
const measure=()=>{
 const selectors=['#personal-workspace','.nova-column','.workspace','.workspace-topbar','#chat-pane','.composer','.composer textarea','.composer-actions','#workbench-panel','.workbench-page h2','.personal-card','.timeline-card','.conversation-task','.profile-split','#settings-nav','body main','body header','body footer','.setting-section:not([hidden])'];
 return Object.fromEntries(selectors.map(selector=>{const node=document.querySelector(selector);if(!node)return [selector,null];const r=node.getBoundingClientRect();return [selector,{x:r.x,y:r.y,width:r.width,height:r.height}]}));
};
async function capture(page,name,scheme){
 const screenshot=join(phaseRoot,`${name}-${scheme}.png`);await page.screenshot({path:screenshot,fullPage:false,animations:'disabled'});
 results.captures.push({name,scheme,screenshot,geometry:await page.evaluate(measure),typography:await page.evaluate(()=>Object.fromEntries(['.timeline-title','.personal-card h3','.chat-message'].map(selector=>{const n=document.querySelector(selector),s=n&&getComputedStyle(n);return [selector,s?{fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,textAlign:s.textAlign}:null]}))),text:await page.locator('body').innerText()});
}
try{
 for(const scheme of ['light','dark']){
  const context=await browser.newContext({viewport:results.viewport,colorScheme:scheme,reducedMotion:'reduce',locale:'en-US',timezoneId:'UTC'});
  const page=await context.newPage();page.on('pageerror',error=>results.errors.push({scheme,message:error.message}));
  await page.clock.install({time:new Date('2026-10-28T12:00:00.000Z')});
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('html[data-fixture-ready=true]',{timeout:15000});
  for(const tab of ['timeline','ideas','goals','feeds','tasks','profile']){
   await page.locator(`#workspace-tab-${tab}`).click();
   await page.waitForTimeout(80);await capture(page,tab,scheme);
  }
  const timeline=page.locator('#workspace-tab-timeline');await timeline.focus();await timeline.press('ArrowRight');
  results.checks.push({scheme,name:'workspace keyboard ArrowRight selects ideas',pass:await page.locator('#workspace-tab-ideas').getAttribute('aria-selected')==='true'});
  await page.locator('#workspace-tab-profile').focus();await page.keyboard.press('Home');
  results.checks.push({scheme,name:'workspace keyboard Home selects timeline',pass:await timeline.getAttribute('aria-selected')==='true'});
  const draft=page.locator('.composer textarea');await draft.fill('Composing text');
  const sentBefore=await page.evaluate(()=>window.visualFixture.frames.filter(f=>f.type==='input.text').length);
  await draft.dispatchEvent('compositionstart',{data:'文'});await draft.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true});
  results.checks.push({scheme,name:'IME Enter does not submit',pass:await page.evaluate(n=>window.visualFixture.frames.filter(f=>f.type==='input.text').length===n,sentBefore)});
  await draft.dispatchEvent('compositionend',{data:'文'});await draft.fill('Submit after composition');await draft.press('Enter');
  await page.waitForTimeout(50);
  results.checks.push({scheme,name:'normal Enter submits through controller',pass:await page.evaluate(n=>window.visualFixture.frames.filter(f=>f.type==='input.text').length===n+1,sentBefore)});
  await draft.fill('Preserved draft');await page.evaluate(()=>window.visualFixture.disconnect());
  results.checks.push({scheme,name:'disconnect preserves draft',pass:await draft.inputValue()==='Preserved draft'});
  await capture(page,'disconnected',scheme);
  await page.evaluate(()=>window.visualFixture.connect());
  await page.locator('#workspace-tab-ideas').click();
  await page.locator('[data-life-id="idea:one"]').getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('textbox',{name:'想法标题',exact:true}).fill('Updated synthetic idea');
  await page.locator('#workspace-tab-tasks').click();await page.locator('#workspace-tab-ideas').click();
  results.checks.push({scheme,name:'unsaved idea title survives Ideas to Tasks to Ideas navigation',pass:await page.getByRole('textbox',{name:'想法标题',exact:true}).inputValue()==='Updated synthetic idea'});
  await capture(page,'preserved-idea-draft',scheme);
  await page.evaluate(()=>window.visualFixture.hold());
  const save=page.getByRole('button',{name:'保存修改',exact:true});await save.click();await page.waitForTimeout(30);
  results.checks.push({scheme,name:'mutation pending disables repeat action',pass:await save.isDisabled()});
  results.checks.push({scheme,name:'mutation carries original expected_version',pass:await page.evaluate(()=>window.visualFixture.frames.some(f=>f.method==='life.mutate'&&f.params.id==='idea:one'&&f.params.expected_version===3&&f.params.title==='Updated synthetic idea'))});
  await capture(page,'pending-mutation',scheme);await page.evaluate(()=>window.visualFixture.release());
  await page.locator('[data-life-id="idea:one"]').getByRole('button',{name:'编辑',exact:true}).click();
  await page.evaluate(()=>window.visualFixture.rejectNext());await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.waitForTimeout(30);
  results.checks.push({scheme,name:'conflict shows recoverable error',pass:(await page.locator('.page-error').allTextContents()).some(t=>t.includes('更新'))});
  await capture(page,'conflict',scheme);
  if(!skipSettings){
   await page.goto(`${origin}/settings.html`);await page.waitForSelector('html[data-fixture-ready=true]',{timeout:15000});await page.waitForTimeout(150);
   results.checks.push({scheme,name:'settings main occupies column right of sidebar',pass:await page.evaluate(()=>{const nav=document.querySelector('#settings-nav').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return main.x>=nav.right+20&&main.width>=650&&main.y<150})});
   await capture(page,'settings',scheme);
   for(const category of ['diary','themes','usage','pipeline','skills','capabilities','im','connections','privacy','knowledge','secrets','hub','phone','codex']){
    await page.locator(`#category-${category}`).click();await page.waitForTimeout(50);await capture(page,`settings-${category}`,scheme);
   }
   await page.locator('#category-general').click();await page.locator('#category-general').focus();await page.keyboard.press('ArrowDown');
   results.checks.push({scheme,name:'settings ArrowDown selects diary',pass:await page.locator('#category-diary').getAttribute('aria-current')==='true'});
   await page.locator('#category-secrets').click();
   results.checks.push({scheme,name:'stored secret stays write-only',pass:await page.locator('#dashscopeApiKey').inputValue()===''});
  }
  await context.close();
 }
 if(args.includes('--production-smoke')){
  const context=await browser.newContext({viewport:results.viewport,colorScheme:'light',reducedMotion:'reduce',locale:'en-US',timezoneId:'UTC'});
  await context.addInitScript(()=>{
   const noop=()=>{},snapshot={language:'zh-CN',preferences:{enabled:true,mode:'focus',motion:false,hardware:true,ai:true,opacity:.8},hardware:{cpu:24,memoryUsed:8*2**30,memoryTotal:16*2**30,disk:42,updatedAt:Date.now()},ai:{state:'idle',backend:'connected',model:'Synthetic public model',usage:{rows:[],requests:0}},state:'working',action:'click',point:{x:400,y:200}};
   const endpoint=new Proxy({}, {get:(_,key)=>{
    if(key==='language')return 'zh-CN';
    if(String(key).startsWith('on'))return ()=>noop;
    if(key==='snapshot')return async()=>snapshot;
    if(key==='get')return async()=>({pipelineMode:'integrated',integratedProvider:'qwen',secretsPresent:{},permissions:{}});
    if(key==='status')return async()=>({pipelineMode:'integrated',backendStatus:'configuration_required',secretsPresent:{}});
    if(key==='request')return async()=>({backend_generation:1,channels:[{name:'conversation',items:[],item_count:0,has_more:false}],diagnostics:{version:1,records:[]}});
    return async()=>({rows:0,taskRows:0,suppressed:true,taskHeightCss:0});
   }});
   window.releaseCameraReports=[];
   window.novaPersonalAgentDesktop={bootstrap:async()=>({startupPresentation:'workbench',backendStatus:'stopped',startup:{stage:'ready'},cameraSource:'off',audioMode:'browser',platform:'linux',settings:{},wakeWord:{state:'active'}}),onBackendStatus:()=>noop,onBackendExit:()=>noop,onBackendReady:()=>noop,windowLayout:endpoint,windowDrag:endpoint,windowControls:endpoint,camera:endpoint,nativeAudio:endpoint,wakeWord:endpoint,microphone:endpoint,personal:endpoint,settings:endpoint,orbMenu:endpoint,setup:endpoint,visor:endpoint,memoryBoard:endpoint,computerUse:endpoint,releaseCamera:{report:result=>window.releaseCameraReports.push(result)}};
   window.visor=endpoint;window.computerOverlay=endpoint;
  });
  for(const name of ['index','setup','visor','visor-controls','computer-bar','computer-edge','memory-board','release-camera']){
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   if(name==='release-camera')await page.addInitScript(()=>{HTMLMediaElement.prototype.canPlayType=()=>''});
   await page.clock.install({time:new Date('2026-10-28T12:00:00.000Z')});
   await page.goto(`${origin}/production/${name}.html`);await page.waitForTimeout(300);
   const screenshot=join(phaseRoot,`production-${name}.png`);await page.screenshot({path:screenshot,animations:'disabled'});
   const reports=await page.evaluate(()=>window.releaseCameraReports);
   results.production.push({name,screenshot,errors,reports,text:await page.locator('body').innerText()});
   results.checks.push({scheme:'light',name:`production ${name} entry renders without pageerrors`,pass:errors.length===0&&await page.locator('.renderer-failure').count()===0});
   if(name==='release-camera')results.checks.push({scheme:'light',name:'release-camera unsupported codec reports exactly once',pass:reports.length===1&&reports[0]==='chromium_codec_unavailable'});
   await page.close();
  }
  await context.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
if(phase==='after'){
 const before=JSON.parse(await readFile(join(output,'before/results.json'),'utf8'));
 results.geometryComparison=results.captures.map(next=>{const prev=before.captures.find(v=>v.name===next.name&&v.scheme===next.scheme);return {name:next.name,scheme:next.scheme,deltas:Object.fromEntries(Object.entries(next.geometry).filter(([selector,value])=>value&&prev?.geometry[selector]).map(([selector,value])=>[selector,Object.fromEntries(Object.entries(value).map(([key,n])=>[key,Math.round((n-prev.geometry[selector][key])*100)/100]))]))}});
 for(const scheme of ['light','dark']){
  const anchors=['#personal-workspace','.nova-column','.workspace','.workspace-topbar','#chat-pane','#workbench-panel','.composer-actions'];
  const captures=results.geometryComparison.filter(c=>c.scheme===scheme&&!c.name.startsWith('settings')&&!['conflict','pending-mutation'].includes(c.name));
  results.checks.push({scheme,name:'workbench anchors preserve before geometry within 1px',pass:captures.every(c=>anchors.every(selector=>c.deltas[selector]&&Object.values(c.deltas[selector]).every(delta=>Math.abs(delta)<=1)))});
  const content={timeline:'.timeline-card',ideas:'.personal-card',goals:'.personal-card',feeds:'.personal-card',tasks:'.conversation-task',profile:'.profile-split'};
  results.checks.push({scheme,name:'workspace content preserves before x and width within 1px',pass:Object.entries(content).every(([name,selector])=>{const delta=results.geometryComparison.find(c=>c.scheme===scheme&&c.name===name)?.deltas[selector];return delta&&Math.abs(delta.x)<=1&&Math.abs(delta.width)<=1})});
  if(!skipSettings)results.checks.push({scheme,name:'all settings categories preserve main x y and width within 1px',pass:results.geometryComparison.filter(c=>c.scheme===scheme&&c.name.startsWith('settings')).every(c=>{const delta=c.deltas['body main'];return delta&&['x','y','width'].every(key=>Math.abs(delta[key])<=1)})});
 }
 const names=[...new Set(results.captures.map(c=>c.name)),...results.production.map(c=>`production:${c.name}`)];
 const review=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Desktop React comparison</title><style>body{margin:24px;font:16px system-ui;background:#e9edf2;color:#20252c}header{display:flex;align-items:center;gap:16px}main{display:flex;gap:16px}figure{margin:12px 0;width:50%}img{width:100%;border:1px solid #8993a0}figcaption{margin:8px 0;font-weight:600}select{font:inherit;padding:6px}</style><header><h1>Desktop React comparison</h1><select id="view">${names.map(n=>`<option>${n}</option>`).join('')}</select><select id="scheme"><option>light</option><option>dark</option></select></header><main><figure><figcaption>Before · ea0fd201</figcaption><img id="before"></figure><figure><figcaption>After · React</figcaption><img id="after"></figure></main><script>const view=document.querySelector('#view'),scheme=document.querySelector('#scheme');function update(){const production=view.value.startsWith('production:');scheme.disabled=production;for(const phase of ['before','after'])document.getElementById(phase).src=phase+'/'+(production?'production-'+view.value.slice(11):view.value+'-'+scheme.value)+'.png'}view.onchange=scheme.onchange=update;update()</script></html>`;
 await writeFile(join(output,'comparison.html'),review);
}
await writeFile(join(phaseRoot,'results.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({phase,captures:results.captures.length,checks:results.checks,errors:results.errors,results:join(phaseRoot,'results.json')},null,2));
if(results.errors.length||results.checks.some(check=>!check.pass))process.exitCode=1;
