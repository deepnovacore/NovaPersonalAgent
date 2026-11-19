import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {SuggestionPool} from '../src/core/suggestions.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import type {ConversationRuntime} from '../src/personal-agent/conversations.js'

const supported = ['darwin', 'win32'].includes(process.platform)

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-voice-owner-'))
  const host = new PersonalAgentHost({path: join(root, 'personal.json'), userScope: 'local-test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const runtime: ConversationRuntime = {runTurn: () => Promise.resolve({assistant: 'ok'}), close: () => Promise.resolve()}
  host.setConversationRuntime(() => Promise.resolve(runtime), () => { /* frames are not asserted here */ })
  let request = 0
  const command = (method: string, params: Record<string, unknown> = {}) =>
    host.command({type: 'personal.command', request_id: 'r' + request++, method, params}, {client_id: 'desktop:local'}) as Promise<{ok: boolean; error?: string; data?: unknown}>
  await host.open()
  assert.equal((await command('presentation.set', {mode: 'workbench'})).ok, true)
  assert.equal((await command('conversations.voice', {id: 'chat:main', enabled: true})).ok, true)
  return {root, host, command, close: async () => {await host.close(); await rm(root, {recursive: true, force: true})}}
}

test('starting a local Build ends voice ownership instead of leaving a ghost owner', {skip: !supported}, async () => {
  const f = await fixture()
  try {
    assert.equal(f.host.conversationSnapshot().voice_id, 'chat:main')
    const result = await f.command('build.begin', {text: 'implement the change', project: f.root})
    assert.equal(result.ok, true, result.error)
    assert.equal(f.host.conversationSnapshot().voice_id, null)
    await assert.rejects(f.host.sendConversationAudio('chat:main', new Uint8Array([1, 2])), /voice_not_owned/u)
    const buildId = f.host.conversationSnapshot().selected_id
    // Voice on the active Build would clear its runtime; it must be refused rather than abort the run.
    assert.equal((await f.command('conversations.voice', {id: buildId, enabled: true})).error, 'conversation_busy')
    // Another conversation keeps voice available while the Build runs.
    assert.equal((await f.command('conversations.voice', {id: 'chat:main', enabled: true})).ok, true)
    // The emergency Stop must still work from the floating orb, where the overlay is visible.
    assert.equal((await f.command('presentation.set', {mode: 'orb'})).ok, true)
    assert.equal((await f.command('build.stop', {id: buildId})).ok, true)
  } finally {
    await f.close()
  }
})

for(const mode of ['chat','plan','build','delegate'] as const)test(`orb announcement and microphone share the frozen ${mode} workbench binding`,async()=>{
 const f=await fixture(),created:{id:string;overrides:unknown}[]=[],delivered:string[]=[]
 const service={} as never
 let emitVoice:(frame:Record<string,unknown>)=>void=()=>{}
 f.host.setConversationRuntime((item,emit,_mode,_lifetime,_recovery,_execution,overrides)=>{emitVoice=emit;created.push({id:item.id,overrides});return Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),deliverSuggestion:()=>{delivered.push(item.id)},bridgeService:service,close:()=>Promise.resolve()})},()=>{})
 try{
  await f.command('conversations.voice',{id:'chat:main',enabled:false})
  await f.command('conversations.create',{title:'Frozen source'})
  const source=f.host.conversationSnapshot().selected_id
  if(['plan','delegate'].includes(mode))assert.equal((await f.command('conversations.mode',{id:source,mode:'plan'})).ok,true)
  assert.equal((await f.command('presentation.set',{mode:'orb',conversation_id:source,voice_mode:mode})).ok,true)
  await f.command('conversations.select',{id:'chat:main'})
  const pool=new SuggestionPool(),suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:'Ready'},salience:40,expires_at:1e15})
  f.host.routePersonalSuggestion(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
  for(let i=0;i<100&&!delivered.length;i++)await new Promise(resolve=>setTimeout(resolve,10))
  const overrides={voice_mode:mode,...(mode==='delegate'?{chat:false}:{})}
  assert.deepEqual(created,[{id:source,overrides}])
  assert.deepEqual(delivered,[source]);assert.equal(f.host.voiceService(),service)
  assert.equal(f.host.conversationSnapshot().voice_id,null)
  emitVoice({type:'conversation.delivered',role:'assistant',text:'Task result',final:true,turn_id:'orb-result'})
  await f.command('conversations.select',{id:source})
  assert.ok(f.host.conversationSnapshot().messages.some(message=>message.text==='Task result'),'implicit voice results stay in the frozen conversation')
  assert.equal((await f.command('conversations.voice',{id:source,enabled:true,voice_mode:mode})).ok,true)
  assert.deepEqual(created.at(-1),{id:source,overrides})
  assert.equal((await f.command('conversations.voice',{id:source,enabled:true,voice_mode:mode==='delegate'?'chat':'delegate'})).error,'conversation_busy')
  assert.equal((await f.command('conversations.mode',{id:source,mode:'chat'})).error,'local_workbench_required')
 }finally{await f.close()}
})

test('direct orb announcement defaults to delegate but an explicit Chat binding remains Chat after voice stops',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-orb-default-')),pool=new SuggestionPool(),created:unknown[]=[]
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool,evidence:()=>null})
 let request=0,delivered=0
 const command=(method:string,params:Record<string,unknown>)=>host.command({type:'personal.command',request_id:'orb-'+request++,method,params},{client_id:'desktop:local'}) as Promise<{ok:boolean;error?:string}>
 host.setConversationRuntime((_item,_emit,_mode,_lifetime,_recovery,_execution,overrides)=>{created.push(overrides);return Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),deliverSuggestion:()=>{delivered++},close:()=>Promise.resolve()})},()=>{})
 const announce=async()=>{const before=delivered,suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:'Ready'},salience:40,expires_at:1e15});host.routePersonalSuggestion(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id});for(let i=0;i<100&&delivered===before;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(delivered,before+1)}
 try{
  await host.open();assert.equal((await command('presentation.set',{mode:'orb'})).ok,true)
  await announce();assert.deepEqual(created,[{voice_mode:'delegate',chat:false}])
  assert.equal((await command('conversations.voice',{id:'chat:main',enabled:true})).ok,true)
  assert.deepEqual(created.at(-1),{voice_mode:'delegate',chat:false})
  await command('conversations.voice',{id:'chat:main',enabled:false})
  assert.equal((await command('conversations.voice',{id:'chat:main',enabled:true,voice_mode:'invalid'})).ok,false)
  assert.equal((await command('conversations.voice',{id:'chat:main',enabled:true,voice_mode:'chat'})).ok,true)
  await command('conversations.voice',{id:'chat:main',enabled:false})
  await announce();assert.deepEqual(created.slice(2),[{voice_mode:'chat'},{voice_mode:'chat'}])
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})
