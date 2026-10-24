import assert from 'node:assert/strict'
import {readFile, mkdir, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as sleep} from 'node:timers/promises'

// shortcut: raw mono PCM16 input only; add WAV decoding when this becomes a product CLI.
const [model, inputPath, outputPath] = process.argv.slice(2)
assert.ok(['minicpm-o','personaplex'].includes(model) && inputPath && outputPath,
  'Usage: NATIVE_REALTIME_URL=ws://localhost:8000/v1/realtime node runtime/scripts/native-duplex-smoke.mjs minicpm-o|personaplex input-16k.pcm NEW_OUTPUT_DIRECTORY')
const input = await readFile(inputPath)
assert.ok(input.length > 0 && input.length % 2 === 0 && input.length <= 300*32000,'Input must be 1–300 seconds of mono 16 kHz PCM16')
const dist = process.env.NOVA_TEST_DIST ?? resolve(import.meta.dirname,'../dist')
const {SglangNativeDuplexAdapter,validateNativeRealtimeUrl} = await import(pathToFileURL(resolve(dist,'src/realtime/sglang-native.js')).href)
const url = validateNativeRealtimeUrl(process.env.NATIVE_REALTIME_URL ?? 'ws://127.0.0.1:8000/v1/realtime')
const capabilityUrl = new URL(url); capabilityUrl.protocol = capabilityUrl.protocol === 'wss:' ? 'https:' : 'http:'; capabilityUrl.pathname += '/capabilities'
const headers = process.env.NATIVE_REALTIME_API_KEY ? {Authorization:`Bearer ${process.env.NATIVE_REALTIME_API_KEY}`} : {}
const response = await fetch(capabilityUrl,{headers,signal:AbortSignal.timeout(10000),redirect:'error'})
assert.ok(response.ok,'Capabilities endpoint failed')
const capabilities = await response.json()
assert.equal(capabilities.native_full_duplex,true)
assert.equal(capabilities.input_audio_format?.rate,model === 'personaplex' ? 24000 : 16000)
assert.equal(capabilities.output_audio_format?.rate,24000)
await mkdir(outputPath)
const {webSocketRealtimeConnector} = await import(pathToFileURL(resolve(dist,'src/realtime/qwen-transport.js')).href)
const serverErrorCodes = []
const connector = async options => {
  const socket = await webSocketRealtimeConnector(options)
  return {send:payload=>socket.send(payload),close:()=>socket.close(),receive:async()=>{
    const payload = await socket.receive()
    try {
      const frame = JSON.parse(payload)
      if(frame.type === 'error' && /^[a-zA-Z0-9_]{1,80}$/.test(frame.error?.code ?? '') && serverErrorCodes.length < 16) serverErrorCodes.push(frame.error.code)
    } catch { /* The production adapter validates malformed frames. */ }
    return payload
  }}
}
const provider = new SglangNativeDuplexAdapter({model,url,apiKey:process.env.NATIVE_REALTIME_API_KEY,voice:process.env.NATIVE_REALTIME_VOICE,connector})
const signal = AbortSignal.timeout(360000)
const audio = [], events = [], transcripts = new Map(); let terminal = false, reader, failure
const start = performance.now()
try {
  await provider.connect({tools:[],signal})
  reader = (async () => {
    for await (const event of provider.events(signal)) {
      if (event.kind === 'response_audio_delta') audio.push(Buffer.from(event.pcm))
      if (event.kind === 'response_transcript_delta') transcripts.set(event.response_id,(transcripts.get(event.response_id)??'')+event.text)
      if (event.kind === 'response_transcript_final') transcripts.set(event.response_id,event.text)
      if (event.kind === 'response_terminal') { assert.equal(event.status,'completed'); terminal = true }
      events.push({...event,...(event.kind==='response_audio_delta'?{pcm:undefined,audio_bytes:event.pcm.length}:{}),elapsed_ms:Math.round(performance.now()-start)})
      if (event.kind === 'provider_error') throw Error(event.code)
    }
  })()
  void reader.catch(() => {})
  const timeline = Buffer.concat([input,Buffer.alloc(3*32000)])
  const replayStart = performance.now()
  for (let offset=0;offset<timeline.length;offset+=640) {
    await provider.sendAudio(timeline.subarray(offset,offset+640),signal)
    await sleep(Math.max(0,replayStart+(offset+640)/32-performance.now()),undefined,{signal})
  }
  await provider.endInput(signal)
  await reader
  assert.ok(audio.length && terminal,'No completed audio response received')
  console.log(JSON.stringify({model,input_seconds:input.length/32000,output_seconds:audio.reduce((n,b)=>n+b.length,0)/48000,outputPath}))
} catch(error) {failure=error instanceof Error?error.message:'probe_failed';throw error}
finally {
  await provider.close(); await reader?.catch(() => {})
  await writeFile(resolve(outputPath,failure?'partial-reply-24k.pcm':'reply-24k.pcm'),Buffer.concat(audio),{flag:'wx'})
  await writeFile(resolve(outputPath,'result.json'),JSON.stringify({model,capabilities,serverErrorCodes,status:failure?'failed':'completed',failure,transcript:[...transcripts.values()].join('\n'),events},null,2),{flag:'wx'})
}
