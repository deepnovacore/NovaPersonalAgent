import assert from 'node:assert/strict'
import {test} from 'node:test'
import {SglangNativeDuplexAdapter, validateNativeRealtimeUrl, type NativeDuplexModel} from '../src/realtime/sglang-native.js'
import {RealtimeProviderSession} from '../src/realtime/provider-session.js'
import {realtimeCapabilities} from '../src/realtime/capabilities.js'
import {loadSettings, requireIntegratedRealtime, describeMissingBlockingCredentials} from '../src/config/config.js'
import {buildIntegratedRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import type {RealtimeSocket} from '../src/realtime/transport.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'

class Socket implements RealtimeSocket {
  sent: {type:string; event_id:string; session?:unknown; audio?:string; sglang?:{seq:number}}[] = []
  frames: unknown[] = [{type:'session.created',session:{id:'native-1'}},{type:'session.updated'}]
  closed = false
  send(payload: string) { this.sent.push(JSON.parse(payload) as Socket['sent'][number]); return Promise.resolve() }
  receive() { const next = this.frames.shift(); return next ? Promise.resolve(JSON.stringify(next)) : Promise.reject(Error('EOF')) }
  close() { this.closed = true; return Promise.resolve() }
}
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const events: T[] = []; for await (const event of stream) events.push(event); return events }
const signal = () => new AbortController().signal
function setup(model: NativeDuplexModel = 'personaplex') {
  const socket = new Socket()
  const provider = new SglangNativeDuplexAdapter({model,url:'ws://127.0.0.1:8000/v1/realtime', connector:() => Promise.resolve(socket)})
  return {socket,provider,session:new RealtimeProviderSession(provider)}
}

for (const model of ['minicpm-o','personaplex'] as const) test(`${model}: tools withheld, correct PCM rate, continuous input and actual terminal`, async () => {
  const {socket,provider,session} = setup(model)
  await session.connect([{type:'function',name:'must_not_send'}])
  assert.equal(typeof socket.sent[0]?.event_id,'string')
  assert.deepEqual(socket.sent[0]?.session,{output_modalities:['audio']})
  assert.equal(socket.sent[0]?.type,'session.update')
  await session.sendAudio(new Uint8Array(3200))
  await session.sendAudio(new Uint8Array(3200))
  const bytes = socket.sent.slice(1).map(frame => Buffer.from(frame.audio!,'base64').length)
  assert.deepEqual(bytes, model === 'personaplex' ? [4798,4800] : [3200,3200])
  assert.deepEqual(socket.sent.slice(1).map(frame => frame.sglang?.seq), [0,1])
  socket.frames.push(
    {type:'response.created',response:{id:'r1',status:'in_progress',output:[]}},
    {type:'response.output_audio.delta',response_id:'r1',delta:'AAA='},
    {type:'response.output_audio_transcript.delta',response_id:'r1',delta:'hello'},
    {type:'response.done',response:{id:'r1',status:'completed'}},
    {type:'sglang.input_audio.drained'},
  )
  await provider.endInput(signal())
  const events = await collect(session.events())
  assert.deepEqual(events.map(event => event.kind), ['response_started','response_audio_delta','response_transcript_delta','response_terminal'])
  assert.equal(socket.sent.at(-1)?.type,'session.close')
  assert.equal(socket.closed,true)
  await session.close()
})

test('native operations fail explicitly, and invalid / ended PCM cannot enter the stream', async () => {
  const {provider,session,socket} = setup()
  await session.connect()
  await assert.rejects(session.submitText('hi'), /text input unavailable/)
  await assert.rejects(session.cancelResponse('r1'), /cancellation unavailable/)
  await assert.rejects(provider.createResponse(), /unavailable/)
  await assert.rejects(provider.injectHostItem(), /unavailable/)
  await assert.rejects(provider.sendAudio(new Uint8Array(3), signal()))
  await provider.endInput(signal())
  await assert.rejects(provider.sendAudio(new Uint8Array(2),signal()), /ended/)
  assert.equal(socket.sent.filter(frame => frame.type === 'input_audio_buffer.append').length,0)
  await session.close()
})

test('native malformed audio and foreign response identities fail closed without reconnect claims', async () => {
  for (const frame of [
    {type:'response.output_audio.delta',response_id:'r1',delta:'bad-base64'},
    {type:'response.output_audio.delta',response_id:'other',delta:'AAA='},
    {type:'response.function_call_arguments.done',call_id:'tool1'},
  ]) {
    const {socket,session} = setup()
    await session.connect()
    socket.frames.push({type:'response.created',response:{id:'r1',status:'in_progress',output:[]}},frame)
    const events = await collect(session.events())
    assert.deepEqual(events.map(event => event.kind),['response_started','provider_error'])
    const last = events.at(-1); assert.ok(last?.kind === 'provider_error'); assert.equal(last.recoverable,false)
    await session.close()
  }
})

test('handshake abort closes the acquired socket', async () => {
  const socket = new Socket()
  socket.receive = () => new Promise(() => undefined)
  const provider = new SglangNativeDuplexAdapter({model:'minicpm-o',url:'ws://localhost:8000/v1/realtime',connector:() => Promise.resolve(socket)})
  const controller = new AbortController()
  const connecting = provider.connect({tools:[],signal:controller.signal})
  controller.abort()
  await assert.rejects(connecting,/handshake failed/)
  assert.equal(socket.closed,true)
})

test('pure dialogue rejects unsolicited normalized tool events at the shared boundary', async () => {
  const provider: RealtimeProvider = {
    capabilities:realtimeCapabilities['sglang-personaplex'],
    connect({tools}) { assert.deepEqual(tools,[]); return Promise.resolve({epoch:1,provider_session_id:'s1'}) },
    sendAudio:() => Promise.resolve(), injectHostItem:() => Promise.resolve(), createResponse:() => Promise.resolve(), cancelResponse:() => Promise.resolve(), close:() => Promise.resolve(),
    async *events() { yield await Promise.resolve({kind:'tool_call_ready',session_epoch:1,call_id:'c1',item_id:'i1',name:'danger',arguments:{},response_id:null}) },
  }
  const session = new RealtimeProviderSession(provider)
  await session.connect([{name:'danger'}])
  await assert.rejects(collect(session.events()), /tool event from a conversation-only provider/)
  await session.close()
})

test('native config uses only its own credential and disallows insecure remote endpoints', () => {
  for (const model of ['minicpm-o','personaplex']) {
    const settings = loadSettings({INTEGRATED_PROVIDER:model,NATIVE_REALTIME_API_KEY:'local-only',DASHSCOPE_API_KEY:'cloud-only'})
    assert.equal(requireIntegratedRealtime(settings).apiKey,'local-only')
    assert.deepEqual(describeMissingBlockingCredentials(settings).missing,[])
    assert.throws(() => requireIntegratedRealtime({...settings,native_realtime_url:'ws://remote.example/v1/realtime'}))
  }
  for (const url of ['https://localhost','wss://user:pass@remote.example','wss://remote.example/?token=secret']) assert.throws(() => validateNativeRealtimeUrl(url))
})

for (const model of ['minicpm-o','personaplex']) test(`${model}: assembly works without cloud LLM credentials`, async () => {
  const assembly = buildIntegratedRealtimeAssembly({settings:loadSettings({INTEGRATED_PROVIDER:model,MEMORY_CONNECTION:'disabled',TAVILY_API_KEY:'test-only'}),connector:() => Promise.resolve(new Socket())})
  assert.ok(assembly.provider instanceof SglangNativeDuplexAdapter)
  assert.equal(assembly.provider.capabilities.model.functionCalling,false)
  // The complete host constructs its wrapper and strips tools before native handshake.
  await assembly.session.connect({tools:[{type:'function',name:'not-a-native-tool'}]})
  const before = assembly.session.snapshot()
  await assembly.service.localSpeechOnset('local-vad')
  assert.deepEqual(assembly.session.snapshot(),before,'native VAD must not fence the continuous response')
  await assembly.providerSession.close()
})


test('MiniCPM model turn boundaries permit several responses on one continuous audio timeline', async () => {
  const {socket,provider,session} = setup('minicpm-o')
  await session.connect()
  for (const id of ['first','second']) socket.frames.push(
    {type:'response.created',response:{id,status:'in_progress'}},
    {type:'response.output_audio.delta',response_id:id,delta:'AAA='},
    {type:'response.done',response:{id,status:'completed'}},
  )
  await provider.endInput(signal())
  socket.frames.push({type:'sglang.input_audio.drained'})
  const events = await collect(session.events())
  assert.equal(events.filter(event => event.kind === 'response_terminal').length,2)
  assert.equal(provider.capabilities.protocol.responseBoundary,'turn')
  assert.equal(realtimeCapabilities['sglang-personaplex'].protocol.responseBoundary,'session')
  await session.close()
})


test('native concurrent connects are refused and queued old audio cannot cross a reconnect', async () => {
  const {provider,socket} = setup()
  const connecting = provider.connect({tools:[],signal:signal()})
  await assert.rejects(provider.connect({tools:[],signal:signal()}),/overlapping/)
  await connecting
  const queued = provider.sendAudio(new Uint8Array(2),signal())
  void queued.catch(() => undefined)
  await provider.close()
  socket.frames.push({type:'session.created',session:{id:'native-2'}},{type:'session.updated'})
  await provider.connect({tools:[],signal:signal()})
  await assert.rejects(queued,/stale/)
  assert.equal(socket.sent.filter(frame => frame.type === 'input_audio_buffer.append').length,0)
  await provider.close()
})

test('native final transcript accepts long calls but enforces a 64 KiB UTF-8 bound', async () => {
 for(const [text,accepted] of [['语'.repeat(10000),true],['语'.repeat(22000),false]] as const) {
  const {socket,session}=setup()
  await session.connect()
  socket.frames.push({type:'response.created',response:{id:'long',status:'in_progress'}},{type:'response.output_audio_transcript.done',response_id:'long',transcript:text})
  const events=await collect(session.events())
  assert.equal(events.some(event=>event.kind==='response_transcript_final'),accepted)
  await session.close()
 }
})
