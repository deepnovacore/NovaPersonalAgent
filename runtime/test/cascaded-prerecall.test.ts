import assert from 'node:assert/strict'
import {test, type TestContext} from 'node:test'
import type {JsonValue} from '../src/core/events.js'
import {CascadedRealtimeAdapter, type CascadedRealtimeAdapterOptions} from '../src/realtime/cascaded/adapter.js'
import type {AsrTranscript} from '../src/realtime/cascaded/ports.js'
import type {CascadedLlmSession} from '../src/realtime/cascaded/llm.js'

async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve() }
async function fixture(t: TestContext, options: Pick<CascadedRealtimeAdapterOptions, 'prerecall' | 'prerecallPolicy' | 'prerecallMeta'> = {}) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1000})
  t.mock.method(performance, 'now', () => Date.now())
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms)
    return controller.signal
  })
  const events: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
  const transcripts: (AsrTranscript | Error)[] = []
  const providerEvents: string[] = []
  let wake: (() => void) | undefined, closed = false, fed = false, serial = 0
  const calls: Parameters<CascadedLlmSession['stream']>[0][] = []
  const adapter = new CascadedRealtimeAdapter({
    ...options,
    idFactory: () => `prerecall-${++serial}`,
    telemetry: {record: (kind, payload) => events.push({kind, payload}), close() { /* fixture owns no resources */ }},
    endpointing: {feed: () => {if (fed) return Promise.resolve([]); fed = true; return Promise.resolve([{kind: 'speech_start', pcm: new Uint8Array([0, 0])}])}, reset() { /* no endpoint state */ }, close: () => Promise.resolve()},
    asr: {open: () => {closed = false; return Promise.resolve({append: () => Promise.resolve(), finish: () => Promise.resolve(), close: () => {closed = true; wake?.(); return Promise.resolve()}, async *events() {
      while (!closed) {
        if (transcripts.length) {
          const transcript = transcripts.shift()!
          if (transcript instanceof Error) throw transcript
          yield transcript
        } else await new Promise<void>(resolve => {wake = resolve})
      }
    }})}},
    llm: {async *stream(input) {await Promise.resolve(); calls.push(input); yield {kind: 'response_started', response_id: 'reply'}; yield {kind: 'response_completed', response_id: 'reply'}}, close: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve()},
    tts: {open: () => Promise.resolve({sendText: () => Promise.resolve(), finish: () => Promise.resolve(), cancel: () => Promise.resolve(), close: () => Promise.resolve(), async *events() {await Promise.resolve()}})},
  })
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})
  const collecting = (async () => {for await (const event of adapter.events(signal)) {
    providerEvents.push(event.kind)
    if (event.kind === 'user_transcript_final') await adapter.ensureResponse(signal, event.item_id)
  }})()
  await adapter.sendAudio(new Uint8Array([0, 0]), signal)
  await flush()
  t.after(async () => {await adapter.close(); await collecting})
  return {
    adapter, events, calls, providerEvents,
    async failAsr() {transcripts.push(Error('fixture ASR failure')); wake?.(); await flush()},
    async nextUtterance() {fed = false; await adapter.sendAudio(new Uint8Array([0, 0]), signal); await flush()},
    async transcript(text: string, final = false) {transcripts.push({text, final, replace: true}); wake?.(); await flush()},
    async tick(ms: number) {t.mock.timers.tick(ms); await flush()},
    injected: () => events.find(event => event.kind === 'memory.prerecall.injected')?.payload,
    completed: () => events.filter(event => event.kind === 'memory.prerecall.completed').map(event => event.payload),
  }
}

const context = () => Promise.resolve('possible memory')

test('prerecall off: no prerecall telemetry and no partial timers', async t => {
  const f = await fixture(t)
  const timers = t.mock.method(globalThis, 'setTimeout')
  for (let i = 0; i < 10; i++) {await f.transcript(`partial text ${i}`); await f.tick(50)}
  assert.equal(timers.mock.callCount(), 0)
  await f.transcript('final text', true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.events.filter(event => event.kind.startsWith('memory.prerecall.')).length, 0)
})

test('throttles partial starts to one per 300ms with trailing start', async t => {
  const queries: string[] = []
  const f = await fixture(t, {prerecall: query => {queries.push(query); return Promise.resolve(context)}})
  for (let i = 0; i < 10; i++) {await f.transcript(`partial text ${i}`); await f.tick(50)}
  await f.tick(100)
  assert.equal(queries.length, 3)
  assert.equal(queries.at(-1), 'partial text 9')
})

test('ASR stream failure clears trailing prerecall before it can start retrieval', async t => {
  const starts: number[] = []
  const f = await fixture(t, {prerecall: () => {starts.push(Date.now()); return Promise.resolve(context)}})
  await f.transcript('first partial')
  await f.tick(80)
  const timers = t.mock.method(globalThis, 'setTimeout')
  const cleared = t.mock.method(globalThis, 'clearTimeout')
  await f.transcript('pending partial')
  assert.equal(timers.mock.callCount(), 1)
  const trailing = timers.mock.calls[0]!
  assert.equal(trailing.arguments[1], 220)
  await f.tick(20)
  await f.failAsr()
  assert(f.providerEvents.includes('user_transcript_failed'))
  assert(cleared.mock.calls.some(call => call.arguments[0] === trailing.result), 'no partial timer remains after ASR failure')
  assert.deepEqual(starts, [1000])
  await f.tick(300)
  assert.deepEqual(starts, [1000], 'no retrieval starts after user_transcript_failed through 400ms')
})

test('new utterance starts immediately instead of inheriting the previous item throttle', async t => {
  const queries: string[] = []
  const f = await fixture(t, {prerecall: query => {queries.push(query); return Promise.resolve(context)}})
  await f.transcript('first utterance')
  await f.transcript('first utterance', true)
  await f.tick(50)
  await f.nextUtterance()
  await f.transcript('second utterance')
  assert.deepEqual(queries, ['first utterance', 'second utterance'])
})

test('partial minimum uses the configured minChars rather than a second six-character gate', async t => {
  const queries: string[] = []
  const f = await fixture(t, {prerecallPolicy: {minChars: 3}, prerecall: query => {queries.push(query); return Promise.resolve(context)}})
  await f.transcript('ab')
  assert.deepEqual(queries, [])
  await f.transcript('abc')
  assert.deepEqual(queries, ['abc'])
})

test('aborts previous speculative run on text change including replacement', async t => {
  const signals: AbortSignal[] = []
  const f = await fixture(t, {prerecall: async (_query, signal) => {signals.push(signal); return new Promise(() => { /* pending until abort */ })}})
  await f.transcript('long partial text')
  await f.tick(300)
  await f.transcript('shorter')
  assert.equal(signals.length, 2)
  assert.equal(signals[0]!.aborted, true)
  assert.equal(f.completed()[0]?.outcome, 'aborted')
})

test('reuses speculative result at final when text matches and clears trailing timer', async t => {
  let starts = 0
  const f = await fixture(t, {prerecall: () => {starts++; return Promise.resolve(context)}})
  await f.transcript('matching text')
  await f.transcript('pending different text')
  await f.transcript('matching text', true)
  await f.tick(300)
  assert.equal(starts, 1)
  assert.deepEqual(f.injected(), {injected: true, reused: true, source: 'speculative', wait_ms: 0, query_length: 13})
  assert.match(f.calls[0]!.responseAdaptation!, /possible memory/)
})

test('slow speculative (800ms) started 1s before final is reused', async t => {
  let starts = 0
  const f = await fixture(t, {prerecall: async () => {starts++; await new Promise(resolve => setTimeout(resolve, 800)); return context}})
  await f.transcript('matching text')
  await f.tick(800)
  await f.tick(200)
  await f.transcript('matching text', true)
  assert.equal(starts, 1)
  assert.equal(f.injected()?.injected, true)
  assert.equal(f.injected()?.reused, true)
  assert.equal(f.completed()[0]?.duration_ms, 800)
})

test('delay above finalWait after final is not injected and run is aborted', async t => {
  let signal: AbortSignal | undefined
  const f = await fixture(t, {prerecall: async (_query, input) => {signal = input; return new Promise(() => { /* pending until abort */ })}})
  await f.transcript('matching text')
  await f.transcript('matching text', true)
  await f.tick(250)
  assert.equal(f.injected()?.injected, false)
  assert.equal(f.injected()?.wait_ms, 250)
  assert.equal(signal?.aborted, true)
  assert.equal(f.completed()[0]?.outcome, 'aborted')
  assert.equal(f.calls.length, 1)
})

test('completed telemetry carries duration, source, code-point query length and safe class labels', async t => {
  const f = await fixture(t, {prerecall: () => Promise.resolve(context), prerecallMeta: {embedding: 'remote', invalid: 'not-a-class'}})
  await f.transcript('final 😀 text', true)
  assert.deepEqual(f.completed(), [{embedding: 'remote', duration_ms: 0, source: 'final', query_length: 12, outcome: 'ok'}])
  assert.equal(f.injected()?.reused, false)
})

test('epoch teardown cancels trailing partial and reports aborted without injection', async t => {
  let starts = 0
  const f = await fixture(t, {prerecall: async () => {starts++; return new Promise(() => { /* pending until abort */ })}})
  await f.transcript('initial partial')
  await f.transcript('pending partial')
  await f.adapter.close()
  await f.tick(500)
  assert.equal(starts, 1)
  assert.equal(f.completed()[0]?.outcome, 'aborted')
  assert.equal(f.injected(), undefined)
})

for (const outcome of ['empty', 'error', 'timeout'] as const) test(`completed telemetry classifies ${outcome}`, async t => {
  const f = await fixture(t, {prerecall: async () => {
    if (outcome === 'error') throw Error('fixture')
    if (outcome === 'timeout') return new Promise(() => { /* pending until abort */ })
    return null
  }})
  await f.transcript('partial query')
  await f.tick(1500)
  assert.equal(f.completed()[0]?.outcome, outcome)
})

import {buildCascadedRealtimeAssembly, cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {configuredMemoryConsumer} from '../src/composition/realtime-assembly.js'
import {loadSettings} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import type {UnifiedRetrievalResult} from '../src/memory/retrieval.js'

for (const fingerprint of [undefined, 'authorized-voice-recipient']) for (const enabled of [false, true]) test(`production cascaded voice assembly late-bound prerecall enabled=${enabled}, override=${fingerprint !== undefined}`, async t => {
  const settings = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'fixture', DOUBAO_BIGMODEL_API_KEY: 'fixture', EXECUTORS: '', CAMERA_MODULE_ENABLED: 'false', MEMORY_CONNECTION: 'disabled', MEMORY_PRERECALL_ENABLED: String(enabled)})
  const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}})
  let adaptation: string | null | undefined
  const telemetry: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
  const llm: CascadedLlmSession = {async *stream(input) {adaptation = input.responseAdaptation; await Promise.resolve(); yield {kind: 'response_started', response_id: 'assembly-reply'}; yield {kind: 'response_completed', response_id: 'assembly-reply'}}, close: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve()}
  let fed = false
  const graph = buildCascadedRealtimeAssembly({settings, capabilities, prerecallPolicy: {minChars: 50}, ...(fingerprint ? {memoryConsumerFingerprint: fingerprint} : {}), telemetry: {record: (kind, payload) => telemetry.push({kind, payload}), close() { /* fixture */ }}}, {
    ...cascadedProviderRegistries,
    endpointing: {auto: () => () => Promise.resolve({feed: () => {if (fed) return Promise.resolve([]); fed = true; return Promise.resolve([{kind: 'speech_start' as const, pcm: new Uint8Array([0, 0])}])}, reset() { /* fixture */ }, close: () => Promise.resolve()})},
    asr: {...cascadedProviderRegistries.asr, volcengine: () => ({openClient: () => ({open: () => Promise.resolve({append: () => Promise.resolve(), finish: () => Promise.resolve(), close: () => Promise.resolve(), async *events() {await Promise.resolve(); yield {text: 'assembly voice query', final: false}; yield {text: 'assembly voice query', final: true}}})})})},
    llm: {...cascadedProviderRegistries.llm, qwen: () => ({open: () => llm})},
    tts: {...cascadedProviderRegistries.tts, volcengine: () => ({openClient: () => ({open: () => Promise.reject(Error('no speech emitted'))})})},
  })
  const empty: UnifiedRetrievalResult = {state: 'empty', scope: 'any', degraded: false, entries: [], snippets: []}
  const authorized = fingerprint ?? configuredMemoryConsumer(settings, 'voice')
  const recalled: UnifiedRetrievalResult = {...empty, state: 'ok', snippets: [{evidence_id: 'voice-evidence', source_kind: 'file', locator: 'notes', text: 'assembly voice query', observed_at: '2026-09-12T00:00:00Z', trust: 'untrusted_external'}]}
  const recall = t.mock.method(graph.retrieval, 'recall', (_query: string, options: Parameters<typeof graph.retrieval.recall>[1]) => Promise.resolve(options?.consumer === authorized ? recalled : empty))
  t.mock.method(graph.retrieval, 'revalidate', (result: UnifiedRetrievalResult) => Promise.resolve(result))
  const signal = new AbortController().signal
  try {
    await graph.provider.connect({tools: [], signal})
    const terminal = (async () => {for await (const raw of graph.provider.events(signal)) {
      const event = raw as {kind: string; item_id?: string}
      if (event.kind === 'user_transcript_final') await graph.provider.ensureResponse!(signal, event.item_id)
      if (event.kind === 'response_terminal') return
    }})()
    await graph.provider.sendAudio(new Uint8Array([0, 0]), signal)
    await terminal
    assert.equal(recall.mock.callCount(), enabled ? 1 : 0)
    if (enabled) {
      assert.equal(recall.mock.calls[0]!.arguments[0], 'assembly voice query')
      assert.equal(recall.mock.calls[0]!.arguments[1]?.consumer, authorized)
      assert.match(adaptation!, /assembly voice query/)
      const injected = telemetry.find(event => event.kind === 'memory.prerecall.injected')?.payload
      assert.equal(injected?.injected, true)
      assert.equal(injected?.embedding, 'remote')
      assert.equal(injected?.source, 'final', 'assembly forwards minChars policy to suppress this short partial')
    }
  } finally {await graph.provider.close(); await graph.stop()}
})


test('tool-output continuation does not rerecall or report another injection', async t => {
  let starts = 0
  const f = await fixture(t, {prerecall: () => {starts++; return Promise.resolve(context)}})
  await f.transcript('original question', true)
  assert.equal(f.injected()?.injected, true)
  const signal = new AbortController().signal
  const item = {kind: 'tool_output' as const, host_item_id: 'tool-result', event_id: 'tool-result', call_id: 'tool-call', content: '{}'}
  await f.adapter.injectHostItem(item, {confirmationTimeout: null, asUserActivation: false, signal})
  await f.adapter.createResponse({kind: 'tool_result', item, task_summary: null, origin_spoken: false}, signal)
  await flush()
  assert.equal(f.calls.length, 2)
  assert.equal(starts, 1)
  assert.equal(f.events.filter(event => event.kind === 'memory.prerecall.injected').length, 1)
  assert.doesNotMatch(f.calls[1]!.responseAdaptation ?? '', /possible memory/)
})
