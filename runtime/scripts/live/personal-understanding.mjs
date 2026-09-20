import assert from 'node:assert/strict'
import {mkdir,chmod,realpath,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {loadSettings,resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {GatewaySurrogate} from '../../dist/src/model/model-adapters.js'
import {PersonalAgentHost} from '../../dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../dist/src/core/suggestions.js'
const output=resolve(process.argv[2]??'output/personal-understanding-live');await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);const directory=await realpath(output),path=join(directory,'personal.json')
const settings=loadSettings(),key=resolveModelApiKey(settings);assert.ok(key,'model credential required')
const gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()})
const make=()=>new PersonalAgentHost({path,userScope:'synthetic-live',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:new GatewaySurrogate({gateway,model:settings.fast_model,proactivityPreset:settings.proactivity_preset,jevApiKey:settings.openrouter_api_key??undefined}).understand})
let host=make();await host.open();const report={extraction_model:settings.fast_model,judgment_model:'typesafe/jev-1.13',checks:[],synthetic:true}
const command=async(method,params={},request_id=crypto.randomUUID())=>{const r=await host.command({type:'personal.command',request_id,method,params});assert.equal(r.ok,true,JSON.stringify(r));return r.data}
try{
 host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'收到'}),close:()=>Promise.resolve()}),()=>{});await host.submitConversationText('chat:main','请记下明天比较三门日语课。我想今年能用日语完成旅行对话。朋友说他想学钢琴，那不是我的计划。',crypto.randomUUID());for(let i=0;i<700&&host.understanding.snapshot().status==='working';i++)await new Promise(r=>setTimeout(r,100))
 const snapshot=host.understanding.snapshot();assert.equal(snapshot.status,'ready');report.candidates=snapshot.items;assert.ok(snapshot.items.length>=1);assert.ok(snapshot.items.every(c=>!c.text.includes('钢琴')));assert.ok(host.life.snapshot().todos.length>=1);assert.ok(snapshot.recorded.length>=1);report.checks.push('new complete message automatically records explicit todo; other facets remain optional')
 for(const item of snapshot.items){await command('understanding.action',{id:item.id,action:'accept',...(item.kind==='profile'?{expected_profile_version:host.life.snapshot().profile.version}:{})});await command('understanding.action',{id:item.id,action:'accept',...(item.kind==='profile'?{expected_profile_version:host.life.snapshot().profile.version}:{})})}
 const saved=host.life.snapshot();assert.ok(saved.todos.length+saved.goals.length+saved.ideas.length>0);report.checks.push('explicit acceptance and repeat idempotency')
 await host.close();host=make();await host.open();assert.deepEqual(host.life.snapshot(),saved);assert.equal(host.understanding.snapshot().items.length,0);report.checks.push('accepted personal objects survive host restart without replay')
 host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'收到'}),close:()=>Promise.resolve()}),()=>{});await host.submitConversationText('chat:main','我想学画画，或许先试试水彩。',crypto.randomUUID());for(let i=0;i<700&&host.understanding.snapshot().status==='working';i++)await new Promise(r=>setTimeout(r,100))
 const items=host.understanding.snapshot().items;if(items.length){await command('conversations.select',{id:'chat:proactive'});const r=await host.command({type:'personal.command',request_id:crypto.randomUUID(),method:'understanding.action',params:{id:items[0].id,action:'accept'}});assert.equal(r.ok,false);report.checks.push('switched conversation rejects stale candidate')}
 report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1}finally{await host.close();await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
