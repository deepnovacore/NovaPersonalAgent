import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

/** Nearest-rank latency percentiles; starts count all settled runs, including aborts. */
export function summarize(events) {
  const completed = events.filter(event => event.kind === 'memory.prerecall.completed')
  const injected = events.filter(event => event.kind === 'memory.prerecall.injected')
  const durations = completed.map(event => event.payload.duration_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const percentile = rank => durations.length ? durations[Math.ceil(durations.length * rank) - 1] : null
  return {starts: completed.length, p50_ms: percentile(.5), p95_ms: percentile(.95),
    injected_ratio: injected.length ? injected.filter(event => event.payload.injected).length / injected.length : 0,
    reused_ratio: injected.length ? injected.filter(event => event.payload.reused).length / injected.length : 0}
}

const scripts = [
  [...Array.from({length: 8}, (_, i) => ({after: i ? 80 : 0, text: `project deployment notes ${i}`, final: false})), {after: 400, text: 'project deployment notes 7', final: true}],
  [{after: 0, text: 'project deployment notes', final: false}, {after: 1000, text: 'project deployment notes', final: true}],
  [{after: 0, text: 'project deployment notes', final: true}],
]

async function replay(Adapter, script, delayMs) {
  const events = []
  let serial = 0, started = false
  const adapter = new Adapter({
    idFactory: () => `latency-${++serial}`,
    telemetry: {record: (kind, payload) => events.push({kind, payload}), close() {}},
    prerecallMeta: {embedding: 'none'},
    prerecall: async (_query, signal) => {await delay(delayMs, undefined, {signal}); return async () => 'possible memory'},
    endpointing: {feed: async () => {if (started) return []; started = true; return [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}]}, reset() {}, close: async () => {}},
    asr: {open: async () => ({append: async () => {}, finish: async () => {}, close: async () => {}, async *events(signal) {for (const step of script) {await delay(step.after, undefined, {signal}); yield {text: step.text, final: step.final}}}})},
    llm: {async *stream() {yield {kind: 'response_started', response_id: 'reply'}; yield {kind: 'response_completed', response_id: 'reply'}}, close: async () => {}, abandonPendingResponse: async () => {}},
    tts: {open: async () => ({sendText: async () => {}, finish: async () => {}, cancel: async () => {}, close: async () => {}, async *events() {}})},
  })
  const signal = AbortSignal.timeout(10000)
  try {
    await adapter.connect({tools: [], signal})
    const finished = (async () => {for await (const event of adapter.events(signal)) {
      if (event.kind === 'user_transcript_final') await adapter.ensureResponse(signal, event.item_id)
      if (event.kind === 'response_terminal') return
    }})()
    await adapter.sendAudio(new Uint8Array([0, 0]), signal)
    await finished
  } finally {await adapter.close()}
  return events
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const dist = option('--dist'), runs = Number(option('--runs', '3'))
  const delays = option('--delay-ms', '100,250,800,2000').split(',').map(Number)
  if (!dist || !Number.isSafeInteger(runs) || runs < 1 || delays.some(value => !Number.isSafeInteger(value) || value < 0)) throw Error('Usage: --dist <isolated runtime/dist> [--runs 3] [--delay-ms 100,250,800,2000]')
  const {CascadedRealtimeAdapter} = await import(pathToFileURL(resolve(dist, 'src/realtime/cascaded/adapter.js')).href)
  for (const delayMs of delays) {
    const events = []
    for (let run = 0; run < runs; run++) for (const script of scripts) events.push(...await replay(CascadedRealtimeAdapter, script, delayMs))
    console.log(JSON.stringify({delay_ms: delayMs, ...summarize(events)}))
  }
}
