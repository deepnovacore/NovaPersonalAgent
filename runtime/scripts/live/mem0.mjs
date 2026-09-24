// Opt-in: stores synthetic facts with test identity in source metadata; real extraction, embeddings and Nova conversation.
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {resolve, join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {setTimeout as delay} from 'node:timers/promises'
import {parseEnv} from 'node:util'
import {loadSettings} from '../../dist/src/config/config.js'
import {personalMemoryFactory} from '../../dist/src/memory/factory.js'
import {buildProductionRealtimeAssembly, cascadedProviderRegistries} from '../../dist/src/composition/cascaded-realtime-assembly.js'
import {parseCapabilityRegistry} from '../../dist/src/config/capability-registry.js'
import {NullTelemetry} from '../../dist/src/realtime/telemetry.js'
import {RealClock} from '../../dist/src/core/clock.js'

assert.equal(process.env.NOVA_LIVE_MEM0, '1', 'Set NOVA_LIVE_MEM0=1 to admit synthetic data and call live models')
const root = resolve(import.meta.dirname, '../../..')
const environment = {...parseEnv(await readFile(join(root, '.env'), 'utf8')), ...process.env}
const output = resolve(environment.NOVA_LIVE_MEM0_REPORT ?? join(root, 'output/mem0-live/report.json'))
await mkdir(resolve(output, '..'), {recursive: true})
const settings = {...loadSettings({...environment, PIPELINE_MODE: 'cascaded',
  CASCADE_LLM_PROVIDER: 'qwen', CONVERSATION_VISION_ENABLED: 'false'}), executors: []}
assert.equal(settings.memory_connection, 'local')
assert.ok(settings.memory_provider === null || settings.memory_provider === 'mem0')
const path = settings.memory_path.startsWith('~/') ? resolve(homedir(), settings.memory_path.slice(2)) : resolve(settings.memory_path)
const ledgerPath = join(`${path}.mem0`, createHash('sha256').update(settings.memory_user_id).digest('hex'), 'ledger.db')
const runId = `nova-synthetic-mem0-${randomUUID()}`
const route = '白桦岭北坡线'
const report = {status: 'running', runId, sdk: 'mem0ai@3.2.0', path, userId: settings.memory_user_id,
  scope: 'Real mem0/LLM/embeddings and Nova service text input; digital audio delivery, no microphone or physical-speaker acceptance.',
  steps: [], seeds: [], recalls: [], conversations: []}
const save = () => writeFile(output, JSON.stringify(report, null, 2)+'\n', {mode: 0o600})
const step = async name => { report.steps.push(name); console.log(name); await save() }
const wait = async (name, check, timeout = 120_000) => {
  const end = Date.now()+timeout
  while (!(await check())) { if (Date.now()>end) throw Error(`${name}_timeout`); await delay(500) }
}
const seeds = [
  '我把书房起名叫青柚小屋。',
  '我负责的星桥项目编号是 QY-731。',
  '我每周三晚上八点参加读书会。',
]
let store, assembly, ledger
try {
  store = personalMemoryFactory(settings)()
  await store.open()
  ledger = new DatabaseSync(ledgerPath, {readOnly: true})
  for (const [index, text] of seeds.entries()) {
    const sourceId = `${runId}:${index+1}`
    await store.remember({sourceId, sessionId: runId, sequence: index+1, text, occurredAt: new Date().toISOString()})
    report.seeds.push({sourceId, text})
  }
  await step('synthetic_sources_durably_admitted')
  await wait('seed_learning', () => report.seeds.every(({sourceId}) => ledger.prepare('SELECT state FROM sources WHERE id=?').get(sourceId)?.state === 'learned'))
  await step('real_model_extraction_committed')
  await store.close(); store = personalMemoryFactory(settings)(); await store.open()
  for (const [query, expected] of [['我的书房叫什么', /青柚小屋/u], ['星桥项目编号', /QY-731/u], ['读书会时间', /(?:周三|星期三|Wednesday).*(?:八点|20:00|8:00\s*PM)/iu]]) {
    const result = await store.recall(query, {scope: 'any'})
    report.recalls.push({query, result})
    assert.ok(result.hits.some(hit => expected.test(hit.text)), `Missing ${expected}`)
    assert.ok(result.hits.every(hit => hit.evidenceIds.length > 0))
  }
  await store.close(); store = undefined
  await step('worker_restart_recall_with_provenance_passed')
  const capabilities = parseCapabilityRegistry({version: 1, modules: {
    coding: {enabled: false}, camera: {enabled: false}, search: {enabled: false}, knowledge: {enabled: false},
  }}, {})
  const runConversation = async (text, expected) => {
    const telemetry = new NullTelemetry({clock: new RealClock()})
    const spoken = []
    assembly = buildProductionRealtimeAssembly({settings, capabilities, telemetry,
      registries: {...cascadedProviderRegistries,
        endpointing: {auto: () => async () => ({async feed() {return []}, async reset() {}, async close() {}})},
      },
      onSpoken: value => spoken.push(value),
      onAudioFrame: frame => assembly.service.playbackStarted(frame.utterance_id, frame.generation_epoch),
      onAudioClear: (id, epoch) => queueMicrotask(() => assembly.service.playbackCleared(id, epoch, 0)),
      onAudioTerminal: (id, epoch) => queueMicrotask(() => assembly.service.playbackDone(id, epoch, null)),
    })
    await assembly.start()
    await assembly.service.submitText(text)
    try {
      await wait('nova_answer', () => spoken.length > 0 && assembly.service.session.providerIdle)
    } catch (error) {
      report.conversations.push({text, spoken, records: telemetry.diagnostics().records})
      await save()
      throw error
    }
    const records = telemetry.diagnostics().records
    report.conversations.push({text, spoken, records})
    await save()
    assert.ok(spoken.join('').includes(expected), `Missing expected answer: ${expected}`)
    assert.doesNotMatch(spoken.join(''), /虚构|验收|角色扮演|合成数据/u)
    return records
  }
  let records = await runConversation('我负责的星桥项目编号是多少？', 'QY-731')
  assert.ok(records.some(record => record.payload?.source === 'personal' && record.payload?.state === 'ok'), 'Nova must use personal memory, not session history')
  await assembly.stop(); assembly = undefined
  await step('nova_live_personal_tool_recall_passed')
  await runConversation(`我最近常走的登山路线叫${route}。`, route)
  await wait('conversation_learning', () => ledger.prepare("SELECT 1 FROM sources WHERE state='learned' AND payload LIKE ? LIMIT 1").get(`%我最近常走的登山路线叫${route}%`) !== undefined)
  await assembly.stop(); assembly = undefined
  await step('nova_final_user_transcript_learned')
  records = await runConversation('我最近常走的登山路线叫什么？', route)
  assert.ok(records.some(record => record.payload?.source === 'personal' && record.payload?.state === 'ok'))
  await step('fresh_nova_session_recalls_learned_fact')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1
} finally {
  await assembly?.stop(); await store?.close(); ledger?.close(); await save()
  console.log(`mem0 live: ${report.status}; report ${output}`)
}
