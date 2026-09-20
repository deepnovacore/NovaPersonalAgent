import assert from 'node:assert/strict'
import {mkdir,chmod,realpath,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {loadSettings,resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {createUnderstandingPipeline} from '../../dist/src/understanding/pipeline.js'
import {PersonalAgentHost} from '../../dist/src/personal-agent/host.js'
import {PersonalStore,initialState} from '../../dist/src/personal-agent/store.js'
import {SuggestionPool} from '../../dist/src/core/suggestions.js'
const output=resolve(process.argv[2]??'output/personal-understanding-live');await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);const directory=await realpath(output),path=join(directory,'personal.json')
const state=initialState(),conversation=state.conversations.items.find(c=>c.id===state.conversations.selected_id)
conversation.messages.push({id:'synthetic-user-1',conversation_id:conversation.id,role:'user',text:'我想在今年学会日语，以后去日本旅行时能自己沟通。请记下明天比较三门日语课。我喜欢用听力材料学习。朋友说他想学钢琴，那不是我的计划。',created_at:new Date().toISOString()})
const store=new PersonalStore(path);await store.read();await store.write(state)
const settings=loadSettings(),key=resolveModelApiKey(settings);assert.ok(key,'model credential required')
const gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()})
const make=()=>new PersonalAgentHost({path,userScope:'synthetic-live',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:createUnderstandingPipeline({gateway,model:settings.fast_model})})
let host=make();await host.open();const report={model:settings.fast_model,checks:[],synthetic:true}
const command=async(method,params={},request_id=crypto.randomUUID())=>{const r=await host.command({type:'personal.command',request_id,method,params});assert.equal(r.ok,true,JSON.stringify(r));return r.data}
try{
 await command('understanding.start');for(let i=0;i<700&&host.understanding.snapshot().status==='working';i++)await new Promise(r=>setTimeout(r,100))
 const snapshot=host.understanding.snapshot();assert.equal(snapshot.status,'ready');report.candidates=snapshot.items;assert.ok(snapshot.items.length>=2);assert.ok(snapshot.items.every(c=>!c.text.includes('钢琴')));assert.equal(host.life.snapshot().todos.length,0);report.checks.push('real extraction and judgement through host, no automatic writes')
 for(const item of snapshot.items){await command('understanding.action',{id:item.id,action:'accept',...(item.kind==='profile'?{expected_profile_version:host.life.snapshot().profile.version}:{})});await command('understanding.action',{id:item.id,action:'accept',...(item.kind==='profile'?{expected_profile_version:host.life.snapshot().profile.version}:{})})}
 const saved=host.life.snapshot();assert.ok(saved.todos.length+saved.goals.length+saved.ideas.length>0);report.checks.push('explicit acceptance and repeat idempotency')
 await host.close();host=make();await host.open();assert.deepEqual(host.life.snapshot(),saved);report.checks.push('accepted personal objects survive host restart')
 await command('understanding.start');for(let i=0;i<700&&host.understanding.snapshot().status==='working';i++)await new Promise(r=>setTimeout(r,100))
 const items=host.understanding.snapshot().items;if(items.length){await command('conversations.select',{id:'chat:proactive'});const r=await host.command({type:'personal.command',request_id:crypto.randomUUID(),method:'understanding.action',params:{id:items[0].id,action:'accept'}});assert.equal(r.ok,false);report.checks.push('switched conversation rejects stale candidate')}
 report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1}finally{await host.close();await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
