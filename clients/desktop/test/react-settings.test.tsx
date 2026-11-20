import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,fireEvent,waitFor,cleanup,act,within}=await import('@testing-library/react')
const {default:SettingsApp}=await import('../src/renderer/react/settings.tsx')
const {default:SetupApp}=await import('../src/renderer/react/setup.tsx')
const {SETTINGS_CATEGORIES}=await import('../src/renderer/settings-categories.mjs')
afterEach(()=>{cleanup();dom.window.localStorage.clear()})
function base(extra:any={}){return {language:'zh-CN',startupView:'workbench',pipelineMode:'integrated',integratedProvider:'qwen',integratedModel:'qwen-audio-3.1-realtime-plus',integratedVoice:'longanqian_v3.1',cascadedAsrProvider:'volcengine',cascadedLlmProvider:'deepseek',cascadedLlmModels:{deepseek:'deepseek-flash'},cascadedTtsProvider:'volcengine',cascadedTtsVoice:'zh_female_vv_uranus_bigtts',codexBinaryMode:'auto',codexApprovalMode:'ask',proactivity:'balanced',codexHeartbeatSeconds:30,settingsApplyStatus:'applied',backendStatus:'connected',secretsPresent:{dashscopeApiKey:true},secretSources:{},capabilitiesDocument:{version:1},capabilities:{},...extra}}
function bridge(view=base(),set?:any){let push:any;const calls:any[]=[];let off=0;const api={get:async()=>view,onChanged:(fn:any)=>{push=fn;return()=>{off++}},personalCommand:async()=>({settings:{},capabilities:{}}),feishuCommand:async()=>({available:false,configured:false}),voiceprint:async()=>({healthy:false}),set:async(commit:any)=>{calls.push(structuredClone(commit));return set?set(commit):base({...view,...commit.settingsPatch,saved:true,restarted:false})}};return {api,bridge:{settings:api,wakeWord:{activity(){}},camera:{requestPermission:async()=> 'granted',listDevices:async()=>[]}},calls,push:(v:any)=>push(v),off:()=>off}}
test('settings roving category navigation stages public fields and uses the existing commit envelope',async()=>{const b=bridge();const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));fireEvent.change(v.container.querySelector('#startup-view')!,{target:{value:'last'}});fireEvent.keyDown(v.getByRole('button',{name:'通用'}),{key:'End'});assert.equal(v.getByRole('button',{name:SETTINGS_CATEGORIES.at(-1).label}).getAttribute('aria-current'),'true');fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));assert.deepEqual(b.calls[0],{settingsPatch:{startupView:'last'}});v.unmount();assert.equal(b.off(),1)})
test('the startup notice carries its stage so the main process can confirm a credential prompt was painted',async()=>{const b=bridge(base({startup:{stage:'credentials'}}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-status') as HTMLElement).dataset.stage,'credentials'));await act(async()=>b.push(base({startup:{stage:'failed'}})));await waitFor(()=>assert.equal((v.container.querySelector('#startup-status') as HTMLElement).dataset.stage,'failed'));await act(async()=>b.push(base()));await waitFor(()=>assert.equal((v.container.querySelector('#startup-status') as HTMLElement).dataset.stage,''));v.unmount()})
test('settings secrets remain write only and newer password edits survive an older save response',async()=>{let resolve:any;const b=bridge(base(),()=>new Promise(r=>{resolve=r}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#dashscopeApiKey') as HTMLInputElement).hidden,true));fireEvent.click(v.container.querySelector('#category-secrets')!);const input=v.container.querySelector('#dashscopeApiKey') as HTMLInputElement;assert.equal(input.value,'');fireEvent.click(v.container.querySelector('button.clear[data-key="dashscopeApiKey"]')!);fireEvent.input(input,{target:{value:'first-secret'}});fireEvent.click(v.container.querySelector('#settings-save')!);assert.equal(b.calls[0].settingsPatch.secrets.dashscopeApiKey,'first-secret');assert.equal(v.container.textContent?.includes('first-secret'),false);fireEvent.input(input,{target:{value:'new-secret'}});await act(async()=>resolve(base({saved:true,restarted:false,secretsPresent:{dashscopeApiKey:true}})));assert.equal(input.value,'new-secret');assert.equal(input.hidden,false);assert.equal((v.container.querySelector('#settings-save') as HTMLButtonElement).disabled,false)})
test('failed settings writes retain secret inputs, including additional provider keys',async()=>{const b=bridge(base(),async()=>{throw Error('offline')});const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));const input=v.container.querySelector('#stepfunApiKey') as HTMLInputElement;fireEvent.input(input,{target:{value:'step-key'}});fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(v.container.querySelector('#status')?.textContent,'保存失败'));assert.equal(input.value,'step-key');assert.equal(b.calls[0].settingsPatch.secrets.stepfunApiKey,'step-key');assert.equal((v.container.querySelector('#settings-save') as HTMLButtonElement).disabled,false)})
test('live main pushes preserve settings drafts and .env managed keys cannot be cleared',async()=>{const b=bridge(base({secretSources:{dashscopeApiKey:'dotenv'}}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));assert.equal((v.container.querySelector('button.clear[data-key="dashscopeApiKey"]') as HTMLButtonElement).disabled,true);fireEvent.change(v.container.querySelector('#startup-view')!,{target:{value:'orb'}});await act(async()=>b.push(base({startupView:'last',backendStatus:'starting'})));assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'orb')})
test('endpoint origin changes clear only the scoped write-only key in the save payload',async()=>{const b=bridge(base({pipelineMode:'cascaded',cascadedLlmProvider:'self-hosted',selfHostedLlmBaseUrl:'https://old.example/v1',secretsPresent:{selfHostedLlmApiKey:true}}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#selfHostedLlmBaseUrl') as HTMLInputElement).value,'https://old.example/v1'));fireEvent.change(v.container.querySelector('#selfHostedLlmBaseUrl')!,{target:{value:'https://new.example/v1'}});fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));assert.deepEqual(b.calls[0].settingsPatch,{selfHostedLlmBaseUrl:'https://new.example/v1',secrets:{selfHostedLlmApiKey:''}})})
test('setup requires only the conversation model key, tests keys, saves exact choice, and recovers from restart failure',async()=>{let push:any;const calls:any[]=[];let off=0;const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:(f:any)=>{push=f;return()=>{off++}},testKey:async(key:string,value:string)=>{calls.push(['probe',key,value]);return {status:'ok'}},save:async(choice:any)=>{calls.push(['save',structuredClone(choice)]);return {saved:true,rejectedSecrets:[]}}};const v=render(<SetupApp api={api} onClose={()=>{}}/>);await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));fireEvent.click(v.container.querySelector('#start')!);assert.ok(v.getByText('请填写 DeepSeek API Key'));fireEvent.change(v.container.querySelector('#deepseekApiKey')!,{target:{value:'setup-key'}});fireEvent.click(v.container.querySelector('[data-key="deepseekApiKey"] .key-test') as HTMLButtonElement);await waitFor(()=>assert.ok(v.getByText('密钥有效'),'key probe should become valid'));fireEvent.click(v.container.querySelector('#start')!);await waitFor(()=>assert.equal(calls.filter(c=>c[0]==='save').length,1));assert.deepEqual(calls.find(c=>c[0]==='save')[1],{pipelineMode:'integrated',cascadedLlmProvider:'deepseek',secrets:{deepseekApiKey:'setup-key'}});await act(async()=>push({backendStatus:'connected',secretsPresent:{deepseekApiKey:true}}));assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,true);await act(async()=>{push({backendStatus:'starting'});push({backendStatus:'authentication_failed'})});assert.ok(v.getByText('启动失败，请检查密钥后重试'));assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false);v.unmount();assert.equal(off,1)})
test('settings category panels are visible and run their exact personal and permission commands',async()=>{const calls:any[]=[];const b=bridge();b.api.personalCommand=async(method:string,params:any)=>{calls.push([method,params]);return {settings:{diary_enabled:true},capabilities:{discovery:true},sources:[],connectors:{available:false}}};const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));fireEvent.click(v.container.querySelector('#category-diary')!);await waitFor(()=>assert.ok(v.getByLabelText('写每日日记'),'diary controls should appear'));fireEvent.click(v.getByLabelText('写每日日记'));await waitFor(()=>assert.ok(calls.some(c=>c[0]==='discovery.configure'&&c[1].diary_enabled===false),'diary preference should be submitted'));fireEvent.click(v.container.querySelector('#category-connectors')!);await act(async()=>{});assert.ok(v.container.querySelector('#connectors-home'),'connectors entry page should appear');assert.ok(calls.some(c=>c[0]==='state'));fireEvent.click(v.container.querySelector('#category-privacy')!);assert.equal((v.container.querySelector('#privacy-section') as HTMLElement).hidden,false)})
test('merged React brief form refuses a brief inside quiet hours before saving',async()=>{
 const calls:string[]=[];const b=bridge(base({focusCategory:'diary'}));
 b.api.personalCommand=async(method:string)=>{calls.push(method);return {settings:{briefing_outlook_enabled:true,briefing_outlook_time:'08:30',briefing_weekdays:[1],quiet_start:'22:00',quiet_end:'09:00'},capabilities:{discovery:true}}};
 const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.equal(v.container.querySelector<HTMLInputElement>('[aria-label="免打扰结束"]')?.value,'09:00'));
 fireEvent.click(v.getByRole('button',{name:'保存简报设置'}));
 await waitFor(()=>assert.ok(v.getByText('简报时间在免打扰时段内，不会发送。请调整简报时间或免打扰时段。')));
 assert.equal(calls.includes('discovery.configure'),false);
})
test('capability edits use the separate revisioned capability document envelope',async()=>{const b=bridge(base({capabilitiesRevision:'rev-a',capabilitiesDocument:{version:1,modules:{knowledge:{enabled:false}}}}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));fireEvent.click(v.container.querySelector('#category-capabilities')!);fireEvent.click(v.getByLabelText('知识库'));fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));assert.deepEqual(b.calls[0],{settingsPatch:{},capabilitiesDocument:{version:1,modules:{knowledge:{enabled:true}}},capabilitiesBaseRevision:'rev-a'})})
test('old phone deep links use Space without retired pairing APIs',async()=>{const b=bridge(base({focusCategory:'hub'}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal(v.container.querySelector('#category-space')?.getAttribute('aria-current'),'true'));assert.equal((v.container.querySelector('#space-host-section') as HTMLElement).hidden,false);assert.ok(v.getAllByRole('heading',{name:'设备'}).length>0);assert.ok(!v.container.querySelector('#category-phone'));assert.ok(!v.container.querySelector('#category-hub'))})
test('coding category is the coding sub-tab of 执行器 with an icon rescan and retains drafts while hidden',async()=>{const calls:string[]=[];const view=base({focusCategory:'codex',codexBinaryMode:'manual',codexStatus:{status:'ready',version:'codex-cli 0.165.0'}});const b=bridge(view);(b.api as any).rescanCodex=async()=>{calls.push('rescan');return view};const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal(v.container.querySelector('#codex-projects')?.tagName,'SECTION'));assert.equal(v.container.querySelector('#category-capabilities')?.getAttribute('aria-current'),'true');assert.equal(v.container.querySelector('#executor-tab-coding')?.getAttribute('aria-selected'),'true');assert.ok(v.getByRole('heading',{name:'编程'}));assert.ok(v.getByRole('heading',{name:'编程执行器'}));assert.ok(v.getByRole('heading',{name:'工作区'}));assert.ok(v.container.querySelector('#codex-rescan svg'),'rescan must carry a visible icon');const input=v.container.querySelector('#codexBinaryPath') as HTMLInputElement;assert.ok(input);fireEvent.change(input,{target:{value:'/opt/codex'}});fireEvent.click(v.container.querySelector('#category-general')!);assert.equal((v.container.querySelector('#codex-projects') as HTMLElement).hidden,true);fireEvent.click(v.container.querySelector('#category-capabilities')!);assert.equal((v.container.querySelector('#codexBinaryPath') as HTMLInputElement).value,'/opt/codex');fireEvent.click(v.container.querySelector('#codex-rescan')!);await waitFor(()=>assert.ok(calls.includes('rescan')));assert.equal(v.container.querySelector('#codex-status')?.getAttribute('data-ready'),'1')})
test('setup cascaded choice saves only its provider keys and preserves rejected input',async()=>{const calls:any[]=[];const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:()=>()=>{},save:async(choice:any)=>{calls.push(structuredClone(choice));return {saved:false,rejectedSecrets:['arkApiKey']}}};const v=render(<SetupApp api={api} onClose={()=>{}}/>);await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));fireEvent.click(v.container.querySelector('input[value="cascaded"]')!);fireEvent.change(v.container.querySelector('#llm-provider')!,{target:{value:'ark'}});fireEvent.change(v.container.querySelector('#arkApiKey')!,{target:{value:'ark-key'}});fireEvent.change(v.container.querySelector('#doubaoBigmodelApiKey')!,{target:{value:'voice-key'}});fireEvent.click(v.container.querySelector('#start')!);await waitFor(()=>assert.ok(v.getByText('密钥未能保存，请检查后重试'),'rejected-key message should appear'));assert.deepEqual(calls[0],{pipelineMode:'cascaded',cascadedLlmProvider:'ark',secrets:{arkApiKey:'ark-key',doubaoBigmodelApiKey:'voice-key'}});assert.equal((v.container.querySelector('#arkApiKey') as HTMLInputElement).value,'ark-key')})
test('setup discards key probe replies after that password changes',async()=>{let resolve:any;const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:()=>()=>{},testKey:()=>new Promise(r=>{resolve=r})};const v=render(<SetupApp api={api} onClose={()=>{}}/>);await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));const input=v.container.querySelector('#deepseekApiKey')!;fireEvent.input(input,{target:{value:'old-key'}});fireEvent.click(v.container.querySelector('[data-key="deepseekApiKey"] .key-test') as HTMLButtonElement);fireEvent.input(input,{target:{value:'new-key'}});await act(async()=>resolve({status:'ok'}));assert.equal(v.queryByText('密钥有效'),null)})
test('setup keeps password inputs and submits the conversation key plus the selected voice key after switching modes',async()=>{const calls:any[]=[];const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:()=>()=>{},save:async(choice:any)=>{calls.push(structuredClone(choice));return {saved:false}}};const v=render(<SetupApp api={api} onClose={()=>{}}/>);await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));const input=v.container.querySelector('#dashscopeApiKey') as HTMLInputElement;fireEvent.input(input,{target:{value:'retained-secret'}});fireEvent.click(v.container.querySelector('input[value="cascaded"]')!);const deepseek=v.container.querySelector('#deepseekApiKey') as HTMLInputElement;fireEvent.input(deepseek,{target:{value:'inactive-secret'}});fireEvent.change(v.container.querySelector('#llm-provider')!,{target:{value:'ark'}});fireEvent.change(v.container.querySelector('#llm-provider')!,{target:{value:'deepseek'}});assert.ok(v.container.querySelector('#deepseekApiKey')===deepseek,'provider input remains mounted');assert.equal(deepseek.value,'inactive-secret');fireEvent.click(v.container.querySelector('input[value="integrated"]')!);assert.ok(v.container.querySelector('#dashscopeApiKey')===input,'DashScope input remains mounted');assert.equal(input.value,'retained-secret');fireEvent.click(v.container.querySelector('#start')!);await waitFor(()=>assert.equal(calls.length,1));assert.deepEqual(calls[0],{pipelineMode:'integrated',cascadedLlmProvider:'deepseek',secrets:{deepseekApiKey:'inactive-secret',dashscopeApiKey:'retained-secret'}})})
test('setup onboarding reveals the key and shows a clear starting state',async()=>{
 let resolveSave:any;const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:()=>()=>{},testKey:async()=>({status:'ok'}),save:()=>new Promise(r=>{resolveSave=r})};
 const v=render(<SetupApp api={api} onClose={()=>{}}/>);
 await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));
 const input=v.container.querySelector('#deepseekApiKey') as HTMLInputElement,row=v.container.querySelector('[data-key="deepseekApiKey"]') as HTMLElement;
 assert.equal(input.type,'password');
 fireEvent.click(row.querySelector('button[aria-label="显示密钥"]')!);
 assert.equal(input.type,'text');
 fireEvent.click(row.querySelector('button[aria-label="隐藏密钥"]')!);
 assert.equal(input.type,'password');
 fireEvent.input(input,{target:{value:'sk-test'}});
 fireEvent.click(row.querySelector('.key-test')!);
 await waitFor(()=>assert.equal(row.querySelector('.key-result')?.getAttribute('data-status'),'ok'));
 fireEvent.click(v.container.querySelector('#start')!);
 await waitFor(()=>assert.equal(v.container.querySelector('#start')?.getAttribute('aria-busy'),'true'));
 assert.match(v.container.querySelector('#start')?.textContent??'',/正在启动/);
 await act(async()=>resolveSave({saved:true}));
})
test('settings localizes developer-owned layout attributes in English',async()=>{const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en');try{const b=bridge(base({language:'en'}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));assert.equal(v.container.querySelector('#knowledgePath')?.getAttribute('placeholder'),'Leave blank to use the default location');assert.equal(v.container.querySelector('label[for="auto-hide-seconds"]')?.getAttribute('title'),'Idle time before sleeping; 0 disables auto-sleep.')}finally{setLanguage('zh-CN')}})

const {default:userEvent}=await import('@testing-library/user-event')
test('Add Account clears the selected existing account before login',async()=>{
 const calls:any[]=[];const account={id:'existing-account',email:'local@example.test',connected:true,planEnabled:true};
 const b=bridge(base({focusCategory:'secrets'}));(b.bridge as any).chatgpt={action:async(action:string,value:any)=>{calls.push([action,value]);return {active:account.id,accounts:[account],model:'test-model'}}};
 const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.ok(v.container.querySelector('#chatgpt-settings'),'ChatGPT settings should appear'));
 const details=v.container.querySelector('#chatgpt-settings') as HTMLDetailsElement;details.open=true;fireEvent(details,new dom.window.Event('toggle'));
 await waitFor(()=>assert.equal((v.getByLabelText('账号') as HTMLSelectElement).value,account.id));
 fireEvent.change(v.getByLabelText('账号'),{target:{value:''}});assert.equal((v.getByLabelText('账号') as HTMLSelectElement).value,'');
 fireEvent.click(v.getByRole('button',{name:'Continue with ChatGPT'}));await waitFor(()=>assert.ok(calls.some(c=>c[0]==='login'),'ChatGPT login should be requested'));assert.deepEqual(calls.find(c=>c[0]==='login'),['login',null]);
})
test('idle seconds supports clear and real keyboard typing and refuses partial invalid saves atomically',async()=>{
 const b=bridge(base({autoHideSeconds:60}));const v=render(<SettingsApp bridge={b.bridge}/>);const user=userEvent.setup({document:dom.window.document});
 await waitFor(()=>assert.equal((v.container.querySelector('#auto-hide-seconds') as HTMLInputElement).value,'60'));
 const input=v.container.querySelector('#auto-hide-seconds') as HTMLInputElement;
 await user.clear(input);await user.type(input,'120');assert.equal(input.value,'120');await user.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));assert.equal(b.calls[0].settingsPatch.autoHideSeconds,120);
 await user.clear(input);await user.type(input,'12');fireEvent.change(v.container.querySelector('#startup-view')!,{target:{value:'orb'}});await user.click(v.container.querySelector('#settings-save')!);assert.equal(b.calls.length,1);assert.equal(input.value,'12');assert.equal(input.validity.valid,false);
 await user.clear(input);await user.type(input,'0');await user.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,2));assert.deepEqual(b.calls[1].settingsPatch,{startupView:'orb',autoHideSeconds:0});
})
const routeCatalog={providers:[
 {id:'qwen',label:'Qwen',keyName:'DASHSCOPE_API_KEY',capabilities:['text','vision']},
 {id:'self-hosted',label:'Self-hosted',keyName:'SELF_HOSTED_LLM_API_KEY',capabilities:['text']},
 {id:'stepfun',label:'StepFun',keyName:'STEPFUN_API_KEY',capabilities:['text','vision']},
 {id:'openai',label:'OpenAI',keyName:'OPENAI_API_KEY',capabilities:['text','vision']},
 {id:'dashscope',label:'DashScope',keyName:'DASHSCOPE_API_KEY',capabilities:['embedding']}
],models:[{id:'catalog-model',label:'Catalog model',provider:'qwen',capabilities:['text','vision']},{id:'embedding-model',label:'Embedding',provider:'dashscope',capabilities:['embedding']}]};
test('legacy category deep links resolve and connectors, permissions and model pipeline controls stay reachable',async()=>{
 const b=bridge(base({focusCategory:'connections'}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal(v.container.querySelector('#category-connectors')?.getAttribute('aria-current'),'true'));
 assert.equal((v.container.querySelector('#connectors-home') as HTMLElement).hidden,false);assert.ok(v.getByRole('heading',{name:'连接器'}));await act(async()=>{});
 fireEvent.click(v.container.querySelector('#category-permissions')!);assert.equal((v.container.querySelector('#desktop-permissions-section') as HTMLElement).hidden,false);assert.equal((v.container.querySelector('#codex-approval-section') as HTMLElement).hidden,false);
 await act(async()=>b.push(base({focusCategory:'pipeline'})));assert.equal(v.container.querySelector('#category-models')?.getAttribute('aria-current'),'true');fireEvent.click(v.container.querySelector('#model-tab-pipeline')!);await act(async()=>{});assert.equal((v.container.querySelector('#pipeline') as HTMLElement).hidden,false);assert.equal((v.container.querySelector('#model-routes') as HTMLElement).hidden,true);
})
test('model routes save exact custom catalog IDs, keyless local models and explicit follow without replacing other lanes',async()=>{
 const b=bridge(base({focusCategory:'models',modelCatalog:routeCatalog,secretsPresent:{dashscopeApiKey:true,stepfunApiKey:true,openaiApiKey:true},modelRoutes:{support:{provider:'qwen',model:'keep-support'},compressor:{provider:'qwen',model:'keep-compressor'}}}));
 const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.ok(v.container.querySelector('[data-lane-provider="conversationText"]'),'conversation model controls should appear'));
 const provider=v.container.querySelector('[data-lane-provider="conversationText"]') as HTMLSelectElement;
 assert.ok(![...provider.options].some(o=>o.value==='stepfun'));assert.ok([...provider.options].some(o=>o.value==='self-hosted'));
 fireEvent.change(provider,{target:{value:'qwen'}});fireEvent.change(v.container.querySelector('[data-lane-model="conversationText"]')!,{target:{value:'__custom__'}});fireEvent.change(v.getByLabelText('对话文本自定义模型 ID'),{target:{value:'my/custom-model'}});
 fireEvent.change(v.container.querySelector('[data-lane-provider="fast"]')!,{target:{value:'self-hosted'}});fireEvent.change(v.getByLabelText('记忆提取自定义模型 ID'),{target:{value:'local-model'}});
 fireEvent.change(v.container.querySelector('[data-lane-provider="support"]')!,{target:{value:''}});fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));
 const {normalizeSettings}=await import('../src/main/settings-store.mjs');const normalized=normalizeSettings(b.calls[0].settingsPatch,normalizeSettings({modelRoutes:{compressor:{provider:'qwen',model:'keep-compressor'}}}));assert.deepEqual(normalized.modelRoutes.compressor,{provider:'qwen',model:'keep-compressor'});assert.deepEqual(normalized.modelRoutes.fast,{provider:'self-hosted',model:'local-model'});assert.deepEqual(normalized.modelRoutes.conversationText,{provider:'qwen',model:'my/custom-model'});
 assert.deepEqual(b.calls[0].settingsPatch,{modelRoutes:{conversationText:{provider:'qwen',model:'my/custom-model'},fast:{provider:'self-hosted',model:'local-model'},support:null},cascadedLlmProvider:'qwen',cascadedLlmModels:{qwen:'my/custom-model'}});
 const watch=v.container.querySelector('[data-lane-provider="watch"]') as HTMLSelectElement;assert.ok(![...watch.options].some(o=>o.value==='openai'));
})

test('Space model choices save separately from API keys and preserve the first edited Host version', async () => {
 const host={version:4,applied_version:4,source:'space',locked:false};
 const initial=base({focusCategory:'models',modelCatalog:routeCatalog,hostModelRoutes:host,modelRoutes:{}});
 const b=bridge(initial,async(commit:any)=>base({...initial,saved:commit.settingsPatch.modelRoutes===undefined,restarted:false,operationStatus:commit.settingsPatch.modelRoutes?'invalid':'applied',problems:['模型选择已在其他设备修改，请重新读取后再保存。']}));
 const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.ok(v.getByRole('button',{name:'保存模型选择'})));
 assert.equal((v.container.querySelector('[data-lane-provider="conversationText"]') as HTMLSelectElement).value,'','Space does not display the stale global conversation model');
 fireEvent.change(v.container.querySelector('[data-lane-provider="fast"]')!,{target:{value:'qwen'}});
 fireEvent.input(v.container.querySelector('#dashscopeApiKey')!,{target:{value:'new-key'}});
 await act(async()=>b.push(base({...initial,hostModelRoutes:{...host,version:5},modelRoutes:{support:{provider:'qwen',model:'phone-model'}}})));
 fireEvent.click(v.getByRole('button',{name:'保存模型选择'}));
 await waitFor(()=>assert.equal(b.calls.length,1));
 assert.deepEqual(b.calls[0],{settingsPatch:{modelRoutes:{fast:{provider:'qwen',model:'catalog-model'}},hostModelRoutesVersion:4}});
 await waitFor(()=>assert.ok(v.getByText('模型选择已在其他设备修改，请重新读取后再保存。')));
 assert.equal((v.container.querySelector('#dashscopeApiKey') as HTMLInputElement).value,'new-key');
 fireEvent.click(v.container.querySelector('#settings-save')!);
 await waitFor(()=>assert.equal(b.calls.length,2));
 assert.deepEqual(b.calls[1],{settingsPatch:{secrets:{dashscopeApiKey:'new-key'}}});
})

test('Space operator routes disable model editing while reload remains available',async()=>{
 const b=bridge(base({focusCategory:'models',modelCatalog:routeCatalog,modelRoutes:{fast:{provider:'qwen',model:'qwen-plus'}},hostModelRoutes:{version:1,applied_version:1,source:'environment',locked:true}}));
 const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.ok(v.getByText('模型选择由启动配置管理，当前只读。')));
 for(const input of v.container.querySelectorAll('#model-routes select,#model-routes input'))assert.equal((input as HTMLInputElement).disabled,true);
 assert.equal((v.getByRole('button',{name:'保存模型选择'}) as HTMLButtonElement).disabled,true);
 assert.equal((v.getByRole('button',{name:'重新读取模型选择'}) as HTMLButtonElement).disabled,false);
 assert.equal(b.calls.length,0);
})

test('an unfinished Space model draft cannot block saving an unrelated API key',async()=>{
 const b=bridge(base({focusCategory:'models',modelCatalog:routeCatalog,modelRoutes:{},hostModelRoutes:{version:1,applied_version:1,source:'space',locked:false}}));
 const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.ok(v.getByRole('button',{name:'保存模型选择'})));
 fireEvent.change(v.container.querySelector('[data-lane-provider="fast"]')!,{target:{value:'self-hosted'}});
 assert.equal((v.getByLabelText('记忆提取自定义模型 ID') as HTMLInputElement).checkValidity(),false);
 fireEvent.input(v.container.querySelector('#dashscopeApiKey')!,{target:{value:'new-key'}});
 fireEvent.click(v.container.querySelector('#settings-save')!);
 await waitFor(()=>assert.equal(b.calls.length,1));
 assert.deepEqual(b.calls[0],{settingsPatch:{secrets:{dashscopeApiKey:'new-key'}}});
 assert.equal((v.getByLabelText('记忆提取自定义模型 ID') as HTMLInputElement).value,'');
})

test('a newer idle edit survives a pending save response',async()=>{
 let resolve:any;const b=bridge(base({autoHideSeconds:60}),()=>new Promise(r=>{resolve=r}));const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.equal((v.container.querySelector('#auto-hide-seconds') as HTMLInputElement).value,'60'));
 const input=v.container.querySelector('#auto-hide-seconds') as HTMLInputElement;fireEvent.change(input,{target:{value:'120'}});fireEvent.click(v.container.querySelector('#settings-save')!);assert.equal(b.calls.length,1);fireEvent.change(input,{target:{value:'240'}});
 await act(async()=>resolve(base({autoHideSeconds:120,saved:true,restarted:false})));assert.equal(input.value,'240');assert.equal((v.container.querySelector('#settings-save') as HTMLButtonElement).disabled,false);
})

test('an unfinished local model blocks every settings write until fixed or explicitly cleared',async()=>{
 const b=bridge(base({focusCategory:'models',modelCatalog:routeCatalog}));const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.ok(v.container.querySelector('[data-lane-provider="fast"]'),'local model controls should appear'));fireEvent.change(v.container.querySelector('[data-lane-provider="fast"]')!,{target:{value:'self-hosted'}});
 fireEvent.click(v.container.querySelector('#category-general')!);fireEvent.change(v.container.querySelector('#startup-view')!,{target:{value:'orb'}});fireEvent.click(v.container.querySelector('#settings-save')!);assert.equal(b.calls.length,0);assert.equal(v.container.querySelector('#category-models')?.getAttribute('aria-current'),'true');
 fireEvent.change(v.container.querySelector('[data-lane-provider="fast"]')!,{target:{value:''}});fireEvent.click(v.container.querySelector('#settings-save')!);await waitFor(()=>assert.equal(b.calls.length,1));assert.deepEqual(b.calls[0].settingsPatch,{modelRoutes:{fast:null},startupView:'orb'});
})

test('leaving an untouched idle input does not create a settings draft',async()=>{
 const b=bridge(base({autoHideSeconds:60}));const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#auto-hide-seconds') as HTMLInputElement).value,'60'));
 fireEvent.focus(v.container.querySelector('#auto-hide-seconds')!);fireEvent.blur(v.container.querySelector('#auto-hide-seconds')!);assert.equal((v.container.querySelector('#settings-save') as HTMLButtonElement).disabled,true);
})

test('configured StepFun survives the real settings controller and is selectable only in supported lanes',async()=>{
 const b=bridge(base({focusCategory:'models',modelCatalog:routeCatalog,secretsPresent:{stepfunApiKey:true}}));const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.ok(v.container.querySelector('[data-lane-provider="support"]'),'supported model lanes should appear'));
 for(const lane of ['support','fast','compressor','watch']){
  const select=v.container.querySelector(`[data-lane-provider="${lane}"]`) as HTMLSelectElement;
  const option=[...select.options].find(o=>o.value==='stepfun');assert.ok(option,`configured StepFun missing from ${lane}`);assert.equal(option.disabled,false);
  fireEvent.change(select,{target:{value:'stepfun'}});assert.equal(select.value,'stepfun');
 }
 for(const lane of ['conversationText','embedding'])assert.ok(![...(v.container.querySelector(`[data-lane-provider="${lane}"]`) as HTMLSelectElement).options].some(o=>o.value==='stepfun'));
})

test('all settings categories have decorative Lucide icons and permission rows share their cards',async()=>{
 const b=bridge(base({focusCategory:'permissions'}));(b.bridge as any).welcome={get:async()=>({permissions:{microphone:'granted',screen:'granted',accessibility:'granted'}}),onChanged:()=>()=>{}};
 const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal(v.container.querySelector('#category-permissions')?.getAttribute('aria-current'),'true'));
 const tabs=[...v.container.querySelectorAll('.settings-nav .nav-item')];assert.equal(tabs.length,SETTINGS_CATEGORIES.length);for(const tab of tabs)assert.ok(tab.querySelector('svg[aria-hidden="true"]'),tab.textContent??'category');
 await waitFor(()=>assert.equal(v.container.querySelectorAll('.permission-icon svg').length,3));
 const permissionActions=v.container.querySelector('#desktop-permissions-section .permission-actions');assert.ok(permissionActions,'permission note and refresh share one action row');assert.ok(permissionActions!.querySelector('.permission-note'));assert.ok(within(permissionActions as HTMLElement).getByRole('button',{name:'重新检查权限'}));
 const states=[...v.container.querySelectorAll('#desktop-permissions-section .permission-state')];assert.equal(states.length,3);assert.ok(states.every(node=>node.getAttribute('data-status')));
 for(const button of v.container.querySelectorAll('#desktop-permissions-section .permission-settings')){assert.ok(button.getAttribute('aria-label'));assert.equal(button.getAttribute('title'),'打开系统设置');assert.ok(button.querySelector('svg'),'去设置 is an icon button')}
 const advanced=v.container.querySelector('#desktop-permissions-section details.computer-configuration');assert.ok(advanced,'高级配置 disclosure card');assert.equal(advanced!.querySelector('summary')?.textContent,'高级配置');assert.ok(advanced!.querySelector('p'));
})
test('news preferences save through settings with the original revision and retain conflicts across category navigation',async()=>{
 const b=bridge();let state:any={news:{enabled:true,explore:false,interests:[{text:'科学'}],profile_version:8}},calls:any[]=[];
 (b.api as any).personalCommand=async(method:string,params:any)=>{if(method==='state')return state;calls.push([method,params]);throw Error('version_conflict')};
 const v=render(<SettingsApp bridge={b.bridge}/>);await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'));fireEvent.click(v.container.querySelector('#category-diary')!);
 await waitFor(()=>assert.ok(v.queryByRole('heading',{name:'你的资讯兴趣'}),'news interest editor should appear'));fireEvent.click(v.getByRole('button',{name:'调整兴趣'}));fireEvent.change(v.getByLabelText('自定义兴趣'),{target:{value:'音乐'}});fireEvent.click(v.getByRole('button',{name:'添加'}));
 fireEvent.click(v.container.querySelector('#category-general')!);state={...state,news:{...state.news,profile_version:9}};fireEvent.click(v.container.querySelector('#category-diary')!);
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'完成调整'}),'interest draft should remain open after navigation'));fireEvent.click(v.getByRole('button',{name:'完成调整'}));await waitFor(()=>assert.ok(v.container.textContent?.includes('调整已保留'),'conflicting interest changes should remain available'));
 assert.deepEqual(calls,[['news.configure',{enabled:true,explore:false,interests:['科学','音乐'],expected_version:8}]]);assert.ok(v.getByLabelText('自定义兴趣'));
})

test('system notifications render through the settings bridge and toggle the persisted setting',async()=>{
 const b=bridge(base({focusCategory:'general'})),calls:boolean[]=[];let enabled=true
 Object.assign(b.api,{systemNotifications:async()=>({supported:true,enabled,state:'unverified',platform:'darwin'}),setSystemNotifications:async(value:boolean)=>{calls.push(value);enabled=value},openNotificationSettings:async()=>true})
 const v=render(<SettingsApp bridge={b.bridge}/>);
 await waitFor(()=>assert.equal((v.getByLabelText('弹出系统通知') as HTMLInputElement).disabled,false))
 fireEvent.click(v.getByLabelText('弹出系统通知'))
 await waitFor(()=>assert.deepEqual(calls,[false]))
 await waitFor(()=>assert.equal((v.getByLabelText('弹出系统通知') as HTMLInputElement).checked,false))
})

test('appearance form is a renderer-owned setting saved without a backend restart',async()=>{
 const b=bridge(base({focusCategory:'themes'}))
 const v=render(<SettingsApp bridge={b.bridge}/>)
 await waitFor(()=>assert.ok(v.container.querySelector('#orb-skin-section')))
 const select=[...v.container.querySelectorAll('#orb-skin-section select')].find((node:any)=>node.getAttribute('aria-label')==='形象') as HTMLSelectElement
 assert.ok(select,'appearance select should exist')
 assert.equal(select.value,'pet')
 fireEvent.change(select,{target:{value:'orb'}})
 fireEvent.click(v.container.querySelector('#settings-save')!)
 await waitFor(()=>assert.equal(b.calls.length,1))
 assert.deepEqual(b.calls[0],{settingsPatch:{companionForm:'orb'}})
})

test('setup starts with only the conversation model key; the voice key is optional and sent only when filled',async()=>{
 const calls:any[]=[];const api={status:async()=>({pipelineMode:'integrated',secretsPresent:{}}),onChanged:()=>()=>{},save:async(choice:any)=>{calls.push(structuredClone(choice));return {saved:true,rejectedSecrets:[]}}};
 const v=render(<SetupApp api={api} onClose={()=>{}}/>);
 await waitFor(()=>assert.equal((v.container.querySelector('#start') as HTMLButtonElement).disabled,false));
 assert.ok(v.getByText('你的个人助手，语音对话是可选能力。'));
 assert.ok(v.container.querySelector('[data-key="dashscopeApiKey"] .key-optional'),'the voice key is marked optional');assert.equal(v.container.querySelector('[data-key="deepseekApiKey"] .key-optional'),null);
 fireEvent.change(v.container.querySelector('#deepseekApiKey')!,{target:{value:'only-text'}});
 fireEvent.click(v.container.querySelector('#start')!);
 await waitFor(()=>assert.equal(calls.length,1));
 assert.deepEqual(calls[0],{pipelineMode:'integrated',cascadedLlmProvider:'deepseek',secrets:{deepseekApiKey:'only-text'}})
})

test('display settings render one label, select and hint per row without nested field wrappers',async()=>{
 const b=bridge(base({focusCategory:'general'}));const v=render(<SettingsApp bridge={b.bridge}/>)
 await waitFor(()=>assert.ok(v.container.querySelector('#display-section')))
 const section=v.container.querySelector('#display-section') as HTMLElement
 const rows=[...section.querySelectorAll(':scope > .field')]
 assert.equal(rows.length,2)
 assert.equal(section.querySelectorAll('.field .field').length,0,'no field nested inside a field')
 for(const row of rows){assert.equal(row.querySelectorAll('label').length,1);assert.equal(row.querySelectorAll('select').length,1);assert.equal(row.querySelectorAll('small').length,1)}
 assert.deepEqual(rows.map(r=>r.querySelector('label')!.textContent),['工作步骤展示','工作步骤收起时机'])
 assert.deepEqual([...section.querySelectorAll('#display-steps option')].map(o=>(o as HTMLOptionElement).value),['compact','standard','detailed'])
})
