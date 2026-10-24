import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {initialState} from '../src/personal-agent/store.js'
import {createConversation,localBuildSchema} from '../src/personal-agent/conversations.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {SuggestionPool} from '../src/core/suggestions.js'

const build={project:'/test',plan_id:'p',plan_version:1,source_conversation_id:'chat:main',status:'paused' as const,reason:null,log_revision:0,approval:null}
test('legacy builds remain readable and computer state is strict',()=>{
 assert.equal(localBuildSchema.parse(build).computer_use,undefined)
 assert.deepEqual(localBuildSchema.parse({...build,computer_use:{enabled:true}}).computer_use,{enabled:true,direct:false})
 assert.equal(localBuildSchema.safeParse({...build,computer_use:{enabled:true,unknown:true}}).success,false)
})
test('computer switch requires local selected Build and fails closed without permissions/configuration',{timeout:10000},async t=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'darwin'});t.after(()=>Object.defineProperty(process,'platform',platform))
 const env=process.env;process.env={...env,COMPUTER_DISPLAY_ID:'1',COMPUTER_BASE_URL:'https://example.com/v1',COMPUTER_MODEL:'test',COMPUTER_MODEL_FAMILY:'qwen3-vl',COMPUTER_API_KEY:'test',COMPUTER_MAC_WINDOW_PID:'',COMPUTER_MAC_WINDOW_ID:''};t.after(()=>{process.env=env})
 const root=await mkdtemp(join(await realpath(tmpdir()),'computer-host-')),path=join(root,'state.json'),state=initialState()
 let ownedHost:PersonalAgentHost|undefined=undefined
 t.after(async()=>{try{await ownedHost?.close()}finally{await rm(root,{recursive:true,force:true})}})
 const item=createConversation('build','Build',null,'build:test');item.build=build;state.conversations.items.push(item);state.conversations.selected_id=item.id
 await writeFile(path,JSON.stringify(state),{mode:0o600})
 const host=new PersonalAgentHost({path,userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null})
 ownedHost=host
 await host.open()
 let n=0
 const command=(method:string,params:Record<string,unknown>,local=true)=>host.command({type:'personal.command',request_id:String(n++),method,params},{client_id:local?'desktop:local':'remote'}) as Promise<{ok:boolean;error?:string;data:{ok:boolean;state:{enabled:boolean;direct:boolean};missing:string[]}}>
 await command('presentation.set',{mode:'workbench'})
 assert.deepEqual(host.computerUseState(item.id),{enabled:false,direct:false})
 assert.equal((await command('build.computer_use',{conversation_id:item.id,enabled:true},false)).error,'local_workbench_required')
 const result=await command('build.computer_use',{conversation_id:item.id,enabled:true})
 assert.equal(result.ok,true);assert.equal(result.data.ok,false);assert.equal(result.data.state.enabled,false)
 assert.deepEqual(result.data.missing,['screen_permission','accessibility_permission','vision_model'])
 const delegated=await command('build.computer_use',{conversation_id:item.id,enabled:true,permissions:{screen:'granted',accessibility:'granted'}})
 assert.equal(delegated.data.ok,true);assert.equal(delegated.data.state.enabled,true);assert.equal(delegated.data.state.direct,false);assert.deepEqual(delegated.data.missing,['vision_model'])
 conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],cascade_llm_provider:'qwen',cascade_llm_model:'qwen3-vl-plus',dashscope_api_key:'test'})})
 const direct=await command('build.computer_use',{conversation_id:item.id,enabled:true,permissions:{screen:'granted',accessibility:'granted'}})
 assert.equal(direct.data.state.direct,true);assert.deepEqual(direct.data.missing,[])
 const badge=()=>host.conversationSnapshot().items.find(value=>value.id===item.id)!.build!.computer_use
 assert.equal(badge().direct,true)
 host.setWorkbenchModel({provider:'self-hosted',model:'text-only'})
 assert.equal(badge().enabled,true);assert.equal(badge().direct,false)
 assert.equal(host.snapshot().conversations.items.find(value=>value.id===item.id)!.build!.computer_use.direct,false)
 host.setWorkbenchModel({provider:'qwen',model:'qwen3-vl-plus'})
 assert.equal(badge().direct,true)
 const thumbnail={media_type:'image/jpeg' as const,data_base64:'dGh1bWI=',width:480,height:300,captured_at:'2026-10-21T00:00:00Z'}
 const imageRead=t.mock.method(host.workbench,'thumbnail',(id:string,generation:number,ref:string)=>{
  assert.equal(id,item.id);assert.equal(generation,item.generation);assert.equal(ref,'frame-ref');return Promise.resolve(thumbnail)
 })
 assert.deepEqual((await command('build.details',{id:item.id,view:'image',image_ref:'frame-ref'})).data,thumbnail)
 assert.equal(imageRead.mock.callCount(),1)
 assert.equal((await command('build.details',{id:item.id,view:'image',image_ref:'frame-ref'},false)).error,'local_workbench_required')
 assert.equal(imageRead.mock.callCount(),1)
 let stopped=false,aborted=false
 host.setConversationRuntime(()=>Promise.resolve({runTurn:(_text,signal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>{aborted=true;resolve({assistant:'stopped'})},{once:true})}),stopBuild:()=>{stopped=true;assert.equal(host.computerUseState(item.id).enabled,false);return Promise.resolve()},close:()=>Promise.resolve()}),()=>{/* no frame observer */})
 await command('build.resume',{id:item.id})
 assert.equal((await command('build.computer_use',{conversation_id:'chat:main',enabled:true})).error,'build_not_found')
 assert.deepEqual((await command('build.computer_use',{conversation_id:item.id,enabled:false})).data,{ok:true,state:{enabled:false,direct:false},missing:[]})
 assert.equal(stopped,true);assert.equal(aborted,true)
 conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],cascade_llm_provider:'self-hosted',cascade_llm_model:null})})
 assert.equal(host.computerUseState(item.id).direct,false)

 Object.defineProperty(process,'platform',{value:'linux'});process.env.COMPUTER_BASE_URL='invalid'
 const unsupported=await command('build.computer_use',{conversation_id:item.id,enabled:true})
 assert.deepEqual(unsupported.data.missing,['platform','configuration','vision_model']);assert.equal(unsupported.data.ok,false)
})
