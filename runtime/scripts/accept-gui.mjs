// Opt-in real Nova text frontend -> task host/controller -> guarded GUI -> Midscene.
// Usage: node accept-gui.mjs env-file browser|computer model-json target instruction output-json
// model-json: {baseUrl,model,modelFamily,apiKey}; never store it in the repository.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {HostApprovalController} from '../dist/src/core/approval.js';
import {RealClock} from '../dist/src/core/clock.js';
import {ComputerExecutor,loadComputerConfig} from '../dist/src/executors/computer.js';
import {BrowserExecutor,loadBrowserConfig} from '../dist/src/executors/browser.js';
import {loadSettings} from '../dist/src/config/config.js';
import {parseCapabilityRegistry} from '../dist/src/config/capability-registry.js';
import {conversationRuntimeFactory} from '../dist/src/personal-agent/conversation-runtime.js';
import {PersonalAgentHost} from '../dist/src/personal-agent/host.js';
import {resolveGuiFrame} from '../dist/src/executors/gui-evidence.js';
import {SuggestionPool} from '../dist/src/core/suggestions.js';
import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NullTelemetry} from '../dist/src/realtime/telemetry.js';
const [envFile,kind,modelFile,target,instruction,output]=process.argv.slice(2);
if(!envFile||!['browser','computer'].includes(kind)||!modelFile||!target||!instruction||!output)throw Error('usage: accept-gui.mjs env-file browser|computer model-json target instruction output-json');
const model=JSON.parse(await readFile(modelFile,'utf8')),prefix=kind.toUpperCase();
const env={...process.env,...parseEnv(await readFile(envFile,'utf8')),PIPELINE_MODE:'cascaded',EXECUTORS:kind,WATCH_MODEL:model.model,
 [`${prefix}_BASE_URL`]:model.baseUrl,[`${prefix}_MODEL`]:model.model,[`${prefix}_MODEL_FAMILY`]:model.modelFamily,[`${prefix}_API_KEY`]:model.apiKey,
 [`${prefix}_MAX_STEPS`]:'20',[`${prefix}_TIMEOUT_SECONDS`]:'600',[`${prefix}_SETTLE_MS`]:'1000',
 ...(kind==='browser'?{BROWSER_URL:target,BROWSER_ENGINE:model.engine??'webkit',BROWSER_HEADLESS:'true'}:{COMPUTER_DISPLAY_ID:target})};
const fixtureAuto=process.argv[8]==='--fixture-auto';
if(fixtureAuto&&(kind!=='browser'||target!=='http://127.0.0.1:18765'))throw Error('fixture_auto_requires_local_browser');
const settings=loadSettings(env),clock=new RealClock(),telemetry=new NullTelemetry({clock}),approvals=new HostApprovalController({clock,idFactory:randomUUID});
const executor=kind==='browser'?new BrowserExecutor(loadBrowserConfig(env),approvals):new ComputerExecutor(loadComputerConfig(env),approvals);
const evidence={started:new Date().toISOString(),kind:`Nova-production-text-${kind}`,scope:'Real frontend and GUI models, guarded coordinates and screen observation; digital audio acknowledgements, no microphone acceptance',instruction,target,approvals:[],spoken:[],tasks:[],terminal:null};
await mkdir(dirname(output),{recursive:true,mode:0o700});const checkpoint=()=>writeFile(output,JSON.stringify(evidence,null,2),{mode:0o600});
const rl=createInterface({input:process.stdin});let pending=null,host,stopping=false;
rl.on('line',line=>{if(pending&&['accept','decline'].includes(line.trim())){const decision=line.trim()==='accept'?'accept':'decline';evidence.approvals.push({...pending,decision});approvals.release();approvals.acceptDecision({approvalId:pending.id,decision});pending=null;void checkpoint();}else if(host)void host.submitConversationText('chat:main',line.trim());});
process.on('SIGINT',()=>{stopping=true;void executor.close();});
const seen=new Set();const unsubscribe=approvals.observe(view=>{if(view.pending_approval&&!view.pending_approval_busy&&!seen.has(view.pending_approval_id)){
 seen.add(view.pending_approval_id);pending={id:view.pending_approval_id,summary:view.operation_summary,detail:view.local_detail};
 if(fixtureAuto){queueMicrotask(()=>{if(!pending||approvals.view.pending_approval_id!==pending.id)return;const scope=pending.detail?.scope??'',colon=scope.indexOf(':');let params={};try{params=JSON.parse(scope.slice(colon+1));}catch{}const action=scope.slice(0,colon),center=params.locate?.center;
 const allowed=(action==='Navigate'&&params.url===target)||(action==='Input'&&params.value==='Nova 实机验收')||(action==='Tap'&&Array.isArray(center)&&center.length===2&&center[0]>=0&&center[0]<1280&&center[1]>=0&&center[1]<800)||(action==='Scroll'&&params.scrollType==='singleAction'&&params.distance>0&&params.distance<=1280)||(action==='KeyboardPress'&&['Enter','Tab','Meta+A','Command+A','Control+A','Home','End'].includes(params.keyName));
 const decision=allowed?'accept':'decline';evidence.approvals.push({...pending,decision});console.log(JSON.stringify({fixture_approval:pending,decision}));approvals.acceptDecision({approvalId:pending.id,decision});pending=null;void checkpoint();});}
 else{approvals.hold();console.log(JSON.stringify({approval:pending}));}
}});
const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},camera:{enabled:false},search:{enabled:false},knowledge:{enabled:false}}},{});
try{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-gui-host-'));
 host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'gui-acceptance',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 await host.open();
 host.setConversationRuntime(conversationRuntimeFactory({settings,capabilities,clock,telemetry,executors:[executor],agentDescriptors:[executor.descriptor],additionalAgentControllers:port=>[executor.controller(port)],executorApproval:approvals,host,memory:()=>undefined,
 onDiagnostic:code=>console.log(JSON.stringify({diagnostic:code})),
 onExecutorProgress:(progress,result)=>{if(result)console.log(JSON.stringify({result}));}}),frame=>{if(typeof frame.text==='string'){evidence.spoken.push(frame.text);console.log(JSON.stringify({frontend:frame.type,text:frame.text}));}});
 await host.submitConversationText('chat:main',instruction);
 const deadline=Date.now()+660000;
 while(Date.now()<deadline&&!stopping){evidence.tasks=host.tasks.list();const task=evidence.tasks.at(-1);if(task&&['completed','cancelled','waiting'].includes(task.phase)&&!host.tasks.activeWork(task.id).length){evidence.terminal={phase:task.phase,evidence:host.tasks.evidence(task.id)};break;}await delay(200);}
 if(!evidence.terminal)throw Error('gui_terminal_timeout');
 for(const task of evidence.tasks)for(const item of host.tasks.evidence(task.id))for(const event of item.observations){try{const data=JSON.parse(event.text),work=task.works.find(w=>w.work_id===item.work_id);if(work?.target&&work.session_id&&data.image_ref){const image=resolveGuiFrame(data.image_ref,{work:work.work_id,session:work.session_id,target:work.target});if(image){const path=output+'.png';await writeFile(path,image.payload,{mode:0o600});evidence.screenshot=path;}}}catch{}}
 console.log(JSON.stringify({terminal:evidence.terminal,tasks:evidence.tasks}));
 if(evidence.terminal.phase!=='completed')process.exitCode=1;
}catch(error){evidence.error=error.message;console.log(JSON.stringify({error:evidence.error}));process.exitCode=1;}
finally{await executor.close();await host?.close();unsubscribe();rl.close();evidence.finished=new Date().toISOString();await checkpoint();}
