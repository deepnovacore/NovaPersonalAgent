/* eslint-disable @typescript-eslint/require-await -- Fetch doubles model the asynchronous network boundary. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createCompatibleAsrFactory, createCompatibleTtsFactory} from '../src/realtime/cascaded/openai-compatible-speech.js'
import type {UsageReport} from '../src/realtime/usage.js'

const config={endpoint:'https://speech.example/v1/',apiKey:'synthetic-secret',model:'test-model',voice:'test-voice'}
const pcm=()=>new Response(Uint8Array.of(1,0,2,0),{headers:{'content-type':'application/octet-stream'}})
async function collect<T>(events:AsyncIterable<T>):Promise<T[]> {const result:T[]=[];for await(const event of events)result.push(event);return result}

test('compatible ASR uploads copied PCM as mono 16kHz WAV only on finish',async()=>{
 let calls=0;const reports:UsageReport[]=[]
 const session=await createCompatibleAsrFactory({...config,onUsage:r=>reports.push(r),fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://speech.example/v1/audio/transcriptions');assert.equal(init?.redirect,'error')
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-secret')
  assert.equal(new Headers(init?.headers).has('content-type'),false)
  assert.ok(init?.body instanceof FormData);assert.equal(init.body.get('model'),'test-model');assert.equal(init.body.get('response_format'),'json')
  const file=init.body.get('file');assert.ok(file instanceof Blob)
  const wav=Buffer.from(await file.arrayBuffer());assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000)
  assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);assert.deepEqual([...wav.subarray(44)],[1,0,2,0])
  return Response.json({text:'你好'})
 }}).openClient().open()
 const input=Uint8Array.of(1,0);await session.append(input);input[0]=9;await session.append(Uint8Array.of(2,0));assert.equal(calls,0)
 const events=collect(session.events());await session.finish();assert.deepEqual(await events,[{text:'你好',final:true}])
 assert.equal(reports[0]?.provider,'custom');assert.equal(reports[0]?.service,'asr');assert.equal(reports[0]?.reportedCostUsd,undefined)
 await assert.rejects(session.append(Uint8Array.of(0,0)));await session.close()
})

test('compatible TTS requests PCM and preserves odd HTTP fragments, producing audio before finish',async()=>{
 const reports:UsageReport[]=[]
 const session=await createCompatibleTtsFactory({...config,onUsage:r=>reports.push(r),fetchImpl:async(url,init)=>{
  assert.equal(url,'https://speech.example/v1/audio/speech');assert.equal(init?.redirect,'error')
  assert.deepEqual(JSON.parse(init?.body as string),{model:'test-model',input:'你好🙂',voice:'test-voice',response_format:'pcm'})
  return new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.of(1));c.enqueue(Uint8Array.of(0,2));c.enqueue(Uint8Array.of(0));c.close()}}))
 }}).openClient().open()
 const iterator=session.events()[Symbol.asyncIterator]();const first=iterator.next();await session.sendText('你好🙂')
 const firstAudio=await first;assert.equal(firstAudio.done,false);if(!firstAudio.done)assert.deepEqual([...firstAudio.value.pcm],[1,0,2,0])
 await session.finish();assert.equal((await iterator.next()).done,true)
 assert.equal(reports[0]?.characters,3);assert.equal(reports[0]?.provider,'custom');await session.close()
})

test('SiliconFlow sample rate is explicit while OpenAI gets no extension fields',async()=>{
 const session=await createCompatibleTtsFactory({...config,sampleRate:24000,fetchImpl:async(_url,init)=>{
  assert.equal((JSON.parse(init?.body as string) as {sample_rate:number}).sample_rate,24000);return pcm()
 }}).openClient().open()
 await session.sendText('hello');await session.close()
})

test('ASR handles silence and close before finish without a request',async()=>{
 const factory=createCompatibleAsrFactory({...config,fetchImpl:async()=>{assert.fail('unexpected request')}})
 const empty=await factory.openClient().open();const events=collect(empty.events());await empty.finish();assert.deepEqual(await events,[{text:'',final:true}]);await empty.close()
 const closed=await factory.openClient().open();const pending=collect(closed.events());await closed.close();assert.deepEqual(await pending,[])
})

for(const kind of ['asr','tts'] as const)test(`${kind} cancellation stops a stalled fetch and discards/cancels its late response`,async()=>{
 let release!:(r:Response)=>void;let started!:()=>void;let signal:AbortSignal|undefined|null;let cancelled=false
 const began=new Promise<void>(r=>started=r),reports:UsageReport[]=[]
 const options={...config,onUsage:(r:UsageReport)=>reports.push(r),fetchImpl:async(_url:unknown,init?:RequestInit)=>{signal=init?.signal;started();return new Promise<Response>(r=>release=r)}}
 const session=kind==='asr'?await createCompatibleAsrFactory(options).openClient().open():await createCompatibleTtsFactory(options).openClient().open()
 const events=collect<unknown>(session.events());const result='append' in session?(await session.append(Uint8Array.of(0,0)),session.finish()):session.sendText('hello')
 const rejected=assert.rejects(result,/aborted/);await began;await session.close();await rejected
 assert.equal(signal?.aborted,true);assert.deepEqual(await events,[])
 release(new Response(new ReadableStream({cancel(){cancelled=true}})))
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.deepEqual(reports,[])
})

test('TTS cancellation between headers and body releases the response',async()=>{
 let started!:()=>void;let cancelled=false;const began=new Promise<void>(r=>started=r)
 const session=await createCompatibleTtsFactory({...config,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.of(1,0));started()},cancel(){cancelled=true}}))}).openClient().open()
 const events=collect(session.events());const rejected=assert.rejects(session.sendText('hello'),/aborted/)
 await began;await session.cancel();await rejected;assert.deepEqual(await events,[]);assert.equal(cancelled,true)
})

test('TTS cancellation releases a stalled body reader and drops partial audio',async()=>{
 let started!:()=>void;let cancelled=false;let pulls=0;const began=new Promise<void>(r=>started=r)
 const session=await createCompatibleTtsFactory({...config,fetchImpl:async()=>new Response(new ReadableStream({pull(c){if(pulls++===0)c.enqueue(Uint8Array.of(1,0));else started()},cancel(){cancelled=true}}))}).openClient().open()
 const events=collect(session.events());const rejected=assert.rejects(session.sendText('hello'),/aborted/)
 await began;await session.cancel();await rejected;assert.deepEqual(await events,[]);assert.equal(cancelled,true)
})

test('speech rejects malformed responses and redacts upstream and network errors',async()=>{
 for(const response of [new Response('synthetic-secret',{status:403}),Response.json({text:12}),Response.json({text:'x'.repeat(4001)}),new Response('{private')]){
  const session=await createCompatibleAsrFactory({...config,fetchImpl:async()=>response}).openClient().open()
  await session.append(Uint8Array.of(0,0));await assert.rejects(session.finish(),/^Error: Compatible speech (?:http_403|invalid_response)$/)
  await assert.rejects(collect(session.events()));await session.close()
 }
 for(const response of [new Response(Uint8Array.of(1)),new Response(),Response.json({error:'synthetic-secret'}),new Response(Uint8Array.of(1,0),{headers:{'content-length':'999999999'}})]){
  const session=await createCompatibleTtsFactory({...config,fetchImpl:async()=>response}).openClient().open()
  await assert.rejects(session.sendText('hello'),/^Error: Compatible speech (?:invalid_audio|invalid_response|response_too_large)$/);await session.close()
 }
 const session=await createCompatibleTtsFactory({...config,fetchImpl:async()=>{throw Error('synthetic-secret')}}).openClient().open()
 await assert.rejects(session.sendText('hello'),/^Error: Compatible speech invalid_response$/);await session.close()
})

test('speech bounds caller input, response bodies and queued audio',async()=>{
 const asr=await createCompatibleAsrFactory(config).openClient().open()
 await assert.rejects(asr.append(Uint8Array.of(1)),/invalid_audio/);await assert.rejects(asr.append(new Uint8Array(16000*2*64+2)),/invalid_audio/);await asr.close()
 const tts=await createCompatibleTtsFactory({...config,fetchImpl:async()=>pcm()}).openClient().open()
 await assert.rejects(tts.sendText('a'.repeat(4001)),/text_too_large/)
 await tts.sendText('a');await tts.close();await assert.rejects(tts.sendText('a'),/aborted|session_finished/)
 let cancelled=false
 const tooLarge=await createCompatibleAsrFactory({...config,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537))},cancel(){cancelled=true}}))}).openClient().open()
 await tooLarge.append(Uint8Array.of(0,0));await assert.rejects(tooLarge.finish(),/response_too_large/);assert.equal(cancelled,true);await tooLarge.close()
 const backlog=await createCompatibleTtsFactory({...config,fetchImpl:async()=>pcm()}).openClient().open()
 for(let i=0;i<8;i++)await backlog.sendText('hello')
 await assert.rejects(backlog.sendText('hello'),/audio_backlog/);await backlog.close()
})
