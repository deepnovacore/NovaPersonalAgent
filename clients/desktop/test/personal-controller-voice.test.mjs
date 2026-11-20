import assert from 'node:assert/strict'
import test from 'node:test'

import {PersonalController} from '../src/renderer/personal-controller.mjs'

function makeController({voiceId='chat:main'}={}) {
  const sent=[]
  const controller=new PersonalController({send:frame=>{sent.push(frame);return true},start:async()=>{},stop:async()=>{},changed:()=>{}})
  controller.connected=true
  controller.snapshot={type:'personal.state',conversations:{selected_id:'chat:main',voice_id:voiceId,items:[{id:'chat:main',generation:1,kind:'chat',mode:'chat'}],messages:[]}}
  controller.mode='voice'
  return {controller,sent}
}

// Commands the controller issues (e.g. disabling voice on failure) are never answered here;
// drop their 30s timeout timers so they cannot keep the test process alive.
function settle(controller) {
  for(const entry of controller.pending.values())clearTimeout(entry.timer)
  controller.pending.clear()
}

test('voice reconnect notices reach the conversation state and the voice notice copy', () => {
  const {controller}=makeController()
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_reconnecting',message:'语音连接中断，正在重连…'})
  assert.equal(controller.voiceState,'reconnecting')
  assert.equal(controller.voiceNotice,'语音连接中断，正在重连…')
  assert.equal(controller.state('chat:main').notice,'语音连接中断，正在重连…')
  assert.equal(controller.voicePhase,'reconnecting')
  // A reconnect notice must not be reported as a fatal conversation error.
  assert.equal(controller.state('chat:main').error,'')

  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_recovered',message:'语音连接已恢复，请再说一次'})
  assert.equal(controller.voiceState,'recovered')
  assert.equal(controller.voiceNotice,'语音连接已恢复，请再说一次')

  // The next user utterance consumes the recovery hint instead of leaving stale copy.
  controller.receive({type:'caption',conversation_id:'chat:main',role:'user',final:true,text:'继续'})
  assert.equal(controller.state('chat:main').notice,'')
  assert.equal(controller.voiceNotice,'')
  assert.equal(controller.voiceState,null)
})

test('an unrecoverable voice failure ends voice mode and surfaces an actionable error', () => {
  const {controller,sent}=makeController()
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_failed',message:'语音连接已断开，请重新开启语音；若仍失败，请在设置中检查语音服务配置'})
  assert.equal(controller.voiceState,'failed')
  assert.equal(controller.mode,'text')
  assert.match(controller.voiceNotice,/语音连接已断开/)
  assert.match(controller.state('chat:main').error,/语音服务配置/)
  assert.ok(sent.some(frame=>frame.type==='conversation.notice')===false, 'renderer does not echo the notice back to the host')
  assert.ok(sent.some(frame=>frame.type==='personal.command'&&frame.method==='conversations.voice'&&frame.params.enabled===false), 'voice is disabled on the host')
  settle(controller)
})

test('starting a new voice session clears a stale reconnect notice', async () => {
  const {controller}=makeController()
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_reconnecting',message:'语音连接中断，正在重连…'})
  controller.voiceState='reconnecting'
  controller.voiceNotice='语音连接中断，正在重连…'
  controller.connected=false
  await controller.stopVoice()
  assert.equal(controller.voiceState,null)
  assert.equal(controller.voiceNotice,'')
})

test('an empty caption reset does not erase the recovery notice', () => {
  const {controller}=makeController()
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_recovered',message:'语音连接已恢复，请再说一次'})
  controller.receive({type:'caption',conversation_id:'chat:main',role:'user',final:true,text:''})
  assert.equal(controller.voiceState,'recovered')
  assert.equal(controller.voiceNotice,'语音连接已恢复，请再说一次')
})

test('a late voice failure does not cancel an in-progress dictation', () => {
  const {controller,sent}=makeController()
  controller.mode='dictation'
  controller.dictationId='dictation-1'
  controller.dictationConversationId='chat:main'
  const generation=controller.generation
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_failed',message:'语音连接已断开'})
  assert.equal(controller.mode,'dictation','the dictation capture keeps running')
  assert.equal(controller.dictationId,'dictation-1')
  assert.equal(controller.generation,generation,'no generation bump may stale the dictation startup')
  assert.match(controller.voiceNotice,/语音连接已断开/)
  assert.equal(sent.some(frame=>frame.type==='personal.command'),false,'no voice-disabling command is sent for the dictation')
  settle(controller)
})

test('a terminal voice failure invalidates an in-flight voice startup', () => {
  const {controller}=makeController()
  controller.mode='starting'
  const before=controller.generation
  controller.receive({type:'conversation.notice',conversation_id:'chat:main',code:'voice_provider_failed',message:'语音连接已断开'})
  assert.ok(controller.generation>before, 'pending voice() must see a stale generation and not re-enter voice mode')
  assert.equal(controller.mode,'text')
  settle(controller)
})

function startingVoice() {
  const {controller,sent}=makeController({voiceId:null})
  controller.mode='text'
  const started=controller.voice()
  const request=sent.find(frame=>frame.type==='personal.command'&&frame.method==='conversations.voice')
  return {controller,sent,started,request}
}

test('a superseded voice start still surfaces a real provider failure', async () => {
  const {controller,started,request}=startingVoice()
  controller.generation++ // a newer action took ownership while the host was connecting
  controller.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'realtime_auth_rejected'})
  await assert.rejects(started,error=>/密钥/.test(error.message)&&error.refusal_code==='realtime_auth_rejected')
  settle(controller)
})

test('a superseded voice start stays quiet when the failure is only the cancellation', async () => {
  for(const code of ['realtime_connect_aborted','conversation_runtime_closed','conversation_cleared']){
    const {controller,started,request}=startingVoice()
    controller.generation++
    controller.receive({type:'personal.result',request_id:request.request_id,ok:false,error:code})
    assert.equal(await started,undefined,code)
    settle(controller)
  }
  const {controller,started}=startingVoice()
  controller.disconnect()
  assert.equal(await started,undefined,'a disconnect rejection is not a provider failure')
})

for(const mode of ['chat','plan','build','delegate'])test(`orb freezes the workbench ${mode} composer and conversation before presentation handoff`,async()=>{
  const {controller,sent}=makeController({voiceId:null}),commands=[]
  controller.mode='text'
  controller.snapshot.conversations.items.push({id:'source',kind:'topic',mode:['plan','delegate'].includes(mode)?'plan':'chat'})
  controller.snapshot.conversations.selected_id='source'
  if(['build','delegate'].includes(mode))controller.state('source').execution=mode
  await controller.applyMode('workbench')
  let release
  controller.command=async(method,params)=>{
    commands.push({method,params})
    if(method==='presentation.set')await new Promise(resolve=>{release=resolve})
    return {mode:params.mode}
  }
  const switching=controller.setPresentation('orb')
  assert.deepEqual(commands[0].params,{mode:'orb',conversation_id:'source',voice_mode:mode})
  controller.snapshot.conversations.selected_id='chat:main'
  delete controller.state('source').execution
  release();await switching
  await controller.voice({wake:false})
  assert.deepEqual(commands[1],{method:'conversations.voice',params:{id:'source',enabled:true,voice_mode:mode}})
  assert.equal(sent.at(-1).conversation_id,'source')
})

test('direct orb entry defaults to delegate on chat:main and keeps that binding through background',async()=>{
  const {controller}=makeController({voiceId:null}),commands=[]
  controller.mode='text'
  controller.snapshot.conversations.selected_id='another'
  controller.command=async(method,params)=>{commands.push({method,params});return {mode:params.mode}}
  await controller.setPresentation('orb')
  await controller.setPresentation('background')
  await controller.setPresentation('orb')
  await controller.voice({wake:false})
  assert.deepEqual(commands.at(-1),{method:'conversations.voice',params:{id:'chat:main',enabled:true,voice_mode:'delegate'}})
})

test('retrying an orb handoff keeps its original binding when workbench intent changed after failure',async()=>{
  const {controller}=makeController({voiceId:null}),commands=[]
  controller.mode='text'
  controller.snapshot.conversations.items[0].mode='plan'
  controller.state('chat:main').execution='delegate'
  await controller.applyMode('workbench')
  let fail=true
  controller.command=async(method,params)=>{commands.push({method,params});if(fail)throw Error('presentation failed');return {mode:params.mode}}
  await assert.rejects(controller.setPresentation('orb'),/presentation failed/)
  delete controller.state('chat:main').execution
  controller.snapshot.conversations.items[0].mode='chat'
  fail=false;await controller.setPresentation('orb');await controller.voice()
  assert.equal(commands[1].params.voice_mode,'delegate')
  assert.equal(commands[2].params.voice_mode,'delegate')
})
