/** Synthetic conversation history acceptance; reports no credentials or model response bodies. */
import {readFile,writeFile} from 'node:fs/promises'
import {parseEnv,parseArgs} from 'node:util'
import {randomUUID} from 'node:crypto'
import {loadSettings} from '../dist/src/config.js'
import {environmentContract} from '../dist/src/environment-contract.js'
import {RealClock} from '../dist/src/clock.js'
import {buildCascadedTextProvider} from '../dist/src/cascaded-text-provider.js'
import {setTimeout as delay} from 'node:timers/promises'
import {cascadedProviderRegistries} from '../dist/src/cascaded-realtime-assembly.js'
import {requireSelectedCascadedRealtimeConfig} from '../dist/src/cascaded-realtime-config.js'
import {buildConversationVoiceProvider} from '../dist/src/conversation-voice-provider.js'
const {values}=parseArgs({options:{'env-file':{type:'string'},output:{type:'string'}}})
const environment=values['env-file']?parseEnv(await readFile(values['env-file'],'utf8')):{}
for(const entry of environmentContract)if(entry.owner.startsWith('retired_'))delete environment[entry.name]
async function questionAudio(settings,signal){
 const config=requireSelectedCascadedRealtimeConfig({...settings,pipeline_mode:'cascaded'})
 const source=await cascadedProviderRegistries.tts.volcengine({config:config.tts,ids:{next:()=>randomUUID()}}).openClient().open(signal)
 const chunks=[]
 const reader=(async()=>{for await(const frame of source.events(signal))chunks.push(Buffer.from(frame.pcm))})()
 try{await source.sendText('我之前告诉你的本次测试代号是什么？请只回答代号。',signal);await source.finish(signal);await reader}
 finally{await source.close()}
 const original=Buffer.concat(chunks),pcm=Buffer.alloc(Math.floor(original.length/3)*2)
 for(let i=0;i<pcm.length/2;i++){const position=i*1.5,left=Math.floor(position),right=Math.min(left+1,original.length/2-1),fraction=position-left;pcm.writeInt16LE(Math.round(original.readInt16LE(left*2)*(1-fraction)+original.readInt16LE(right*2)*fraction),i*2)}
 return Buffer.concat([Buffer.alloc(32000),pcm,Buffer.alloc(64000)])
}
const report={scope:'synthetic history restoration and generated transcription; no microphone or physical playback',cases:[]}
for(const mode of ['text','integrated']){
 let provider
 const signal=AbortSignal.timeout(45000),events=[]
 try{
  const secret='松果'+String(Math.floor(Math.random()*900000)+100000)
  const settings=loadSettings({...environment,CASCADE_LLM_PROVIDER:'qwen',PIPELINE_MODE:mode==='text'?'cascaded':'integrated'})
  provider=(mode==='text'?buildCascadedTextProvider:buildConversationVoiceProvider)({settings,clock:new RealClock(),idFactory:randomUUID,history:[{user:'本次测试的代号是'+secret+'。',assistant:'记住了这个代号。'}]})
  const input=mode==='integrated'?await questionAudio(loadSettings({...environment,PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'qwen'}),signal):null
  const started=Date.now()
  await provider.connect({tools:[],signal})
  let answer='',audioBytes=0,userTranscript=false
  const reader=(async()=>{for await(const event of provider.events(signal)){
   events.push(event.kind)
   if(event.kind==='user_transcript_final'){userTranscript=event.text.trim().length>0;await provider.ensureResponse(signal,event.item_id)}
   if(event.kind==='response_transcript_delta')answer+=event.delta??event.text??''
   if(event.kind==='response_transcript_final')answer=event.text
   if(event.kind==='response_audio_delta')audioBytes+=event.pcm.byteLength
   if(event.kind==='provider_error')throw Error('provider_error')
   if(event.kind==='response_terminal'){if(event.status!=='completed')throw Error('response_'+event.status);return}
  }})()
  if(mode==='text')await provider.submitText('请只回答此前告诉你的本次测试代号，不要猜。',signal)
  else{for(let offset=0;offset<input.length;offset+=1024){await provider.sendAudio(input.subarray(offset,offset+1024),signal);await delay(32,undefined,{signal})}}

  await reader
  const historyRecovered=answer.replace(/\s/gu,'').includes(secret)
  const ok=historyRecovered&&userTranscript&&(mode!=='text'||audioBytes===0)
  report.cases.push({mode,status:ok?'passed':'failed',historyRecovered,userTranscript,audioBytes,elapsedMs:Date.now()-started,eventKinds:[...new Set(events)]})
 }catch(error){report.cases.push({mode,status:'failed',error:error?.name??'Error',...(typeof error?.code==='string'&&/^[a-z_]+$/.test(error.code)?{code:error.code}:{}),...(error?.name==='ConfigurationError'?{configurationError:error.message}:{}),eventKinds:[...new Set(events)]})}
 finally{await provider?.close()}
}
if(values.output)await writeFile(values.output,JSON.stringify(report,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify(report,null,2))
if(report.cases.some(item=>item.status!=='passed'))process.exitCode=1
