import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {SuggestionPool} from '../src/core/suggestions.js'
import {settingsSchema} from '../src/config/config.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {createConversation} from '../src/personal-agent/conversations.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {realtimeCapabilities} from '../src/realtime/capabilities.js'
import type {HostContextItem,RealtimeProvider,RealtimeProviderEvent} from '../src/realtime/protocol.js'
import {realtimeServiceHarness} from './support/realtime-service-harness.js'

/**
 * A voice conversation must survive a recoverable provider drop without
 * silently listening at a dead transport: the user gets a visible notice,
 * the provider session is replaced, and the next utterance still arms a
 * response on the new epoch. These tests drive the real service loops through
 * a scripted provider so notification ordering is exercised, not assumed.
 */

/** Pull-based event stream: `push` wakes the service loop, `end` closes it. */
function scriptedEvents<T = unknown>() {
  const pending: T[] = []
  let wake: (()=>void)|null = null
  let ended = false
  const stream = async function*(signal:AbortSignal): AsyncGenerator<T> {
    while (!signal.aborted) {
      if (pending.length === 0) {
        if (ended) return
        await new Promise<void>(resolve => {
          const done = (): void => { signal.removeEventListener('abort', done); wake = null; resolve() }
          wake = done
          signal.addEventListener('abort', done, {once: true})
        })
      }
      if (signal.aborted || ended) return
      const event = pending.shift()
      if (event !== undefined) yield event
    }
  }
  return {
    stream,
    push(event: T): void { pending.push(event); wake?.() },
    end(): void { ended = true; wake?.() },
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function count(values: readonly string[], value: string): number {
  return values.filter(candidate => candidate === value).length
}

test('a recoverable provider drop announces the gap, reconnects, and re-arms the next voice turn',{timeout:15000},async t => {
  const events = scriptedEvents<RealtimeProviderEvent>()
  const notifications: RealtimeProviderEvent[] = []
  const {service,actions} = realtimeServiceHarness('pipeline', {
    userResponseMode: 'requested',
    onProviderEvent: event => notifications.push(event),
    providerEvents: signal => events.stream(signal),
  })
  t.after(async () => { events.end(); await service.close().catch(() => { /* already stopped */ }) })
  await service.start()
  const push = (event: RealtimeProviderEvent): void => events.push(event)
  const announcements = (): RealtimeProviderEvent[] => notifications.filter(event =>
    event.kind === 'provider_error' || event.kind === 'provider_reconnected')
  const firstTurn = (epoch: number,itemId: string,text: string,expected: number): Promise<void> => {
    push({kind: 'user_speech_started',session_epoch: epoch,speech_id: `speech-${itemId}`,provider_item_id: itemId})
    push({kind: 'user_speech_ended',session_epoch: epoch,speech_id: `speech-${itemId}`,provider_item_id: itemId})
    push({kind: 'user_transcript_final',session_epoch: epoch,item_id: itemId,text})
    return waitFor(() => count(actions, 'ensure_response') >= expected, `response request #${expected}`)
  }

  await firstTurn(1, 'user-1', '你好', 1)
  // The provider drops mid-conversation with its one recoverable transport error.
  push({kind: 'provider_error',session_epoch: 1,code: 'disconnected',recoverable: true})
  await waitFor(() => count(actions, 'connect') === 2, 'provider replacement connect')
  await waitFor(() => notifications.some(event => event.kind === 'provider_reconnected' && event.session_epoch === 2), 'reconnect confirmation')

  // Ordering is the whole contract: the gap is announced before the recovery,
  // because the service notifies lifecycle owners before it starts replacing.
  const seen = announcements()
  const reconnectError = seen.findIndex(event => event.kind === 'provider_error' && event.recoverable === true)
  const recovered = seen.findIndex(event => event.kind === 'provider_reconnected' && event.session_epoch === 2)
  assert.ok(reconnectError >= 0, 'the recoverable transport error reached lifecycle owners')
  assert.ok(recovered > reconnectError, 'recovery is reported after the disconnect it closes')
  assert.equal(seen[recovered]?.kind, 'provider_reconnected')
  assert.equal(service.stopped, false, 'a recoverable drop must not stop the conversation service')

  // The next utterance is accepted on the fresh epoch and arms a new response:
  // this is the "listening but no reply" hang the user reported, asserted as a
  // deterministic recoverable state rather than by waiting for a real model.
  await firstTurn(2, 'user-2', '再说一次', 2)
  assert.equal(count(actions, 'ensure_response'), 2, 'the next voice turn asked the new session for a response')
  assert.equal(service.stopped, false)
})

test('a failed provider replacement tells lifecycle owners instead of hanging the voice session',{timeout:15000},async t => {
  const events = scriptedEvents<RealtimeProviderEvent>()
  const notifications: RealtimeProviderEvent[] = []
  const {service,actions} = realtimeServiceHarness('pipeline', {
    userResponseMode: 'requested',
    failReconnect: true,
    onProviderEvent: event => notifications.push(event),
    providerEvents: signal => events.stream(signal),
  })
  t.after(async () => { events.end(); await service.close().catch(() => { /* already stopped */ }) })
  await service.start()
  events.push({kind: 'provider_error',session_epoch: 1,code: 'disconnected',recoverable: true})
  await waitFor(() => service.stopped, 'service stop after failed replacement')
  const failed = notifications.find(event =>
    event.kind === 'provider_error' && event.code === 'reconnect_failed' && event.recoverable === false)
  assert.ok(failed, 'the failed replacement surfaced as a non-recoverable provider error')
  assert.equal(count(actions, 'connect'), 2, 'the replacement was attempted exactly once')
})

type RuntimeFrames = Record<string, unknown>[]

function voiceProvider(events: ReturnType<typeof scriptedEvents<RealtimeProviderEvent>>, counters: {connects: number;ensure: number}) {
  const provider: RealtimeProvider = {
    capabilities: realtimeCapabilities.cascaded,
    userResponseMode: 'requested',
    connect: () => {
      counters.connects += 1
      return Promise.resolve({epoch: counters.connects,provider_session_id: `scripted-${counters.connects}`})
    },
    sendAudio: () => Promise.resolve(),
    injectHostItem: (item: HostContextItem) => Promise.resolve({
      session_epoch: counters.connects,
      host_item_id: item.host_item_id,
      provider_item_id: `provider:${item.host_item_id}`,
    }),
    createResponse: () => Promise.resolve(),
    ensureResponse: () => { counters.ensure += 1; return Promise.resolve(true) },
    cancelResponse: () => Promise.resolve(),
    close: () => Promise.resolve(),
    events: signal => events.stream(signal),
  }
  return provider
}

test('a live voice conversation emits reconnect and recovery notices and keeps accepting the next turn',{timeout:20000},async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()),'nova-voice-reconnect-'))
  const host = new PersonalAgentHost({path: join(dir,'personal.json'),userScope: 'test',memory: () => undefined,pool: new SuggestionPool(),evidence: () => null})
  const events = scriptedEvents<RealtimeProviderEvent>()
  const counters = {connects: 0,ensure: 0}
  const frames: RuntimeFrames = []
  let runtime: Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>> | undefined
  t.after(async () => {
    events.end()
    await runtime?.close().catch(() => { /* runtime already closed */ })
    await host.close()
    await rm(dir,{recursive: true,force: true})
  })
  try {
    await host.open()
    const conversation = createConversation('chat','Voice reconnect')
    const factory = conversationRuntimeFactory({
      host,
      memory: () => undefined,
      settings: settingsSchema.parse({
        executors: [],
        camera_module_enabled: false,
        cascade_llm_provider: 'qwen',
        dashscope_api_key: 'test',
        deepseek_api_key: 'test',
      }),
      createVoiceProvider: () => voiceProvider(events,counters),
      searchTransport: {search: () => Promise.reject(Error('unused'))},
    })
    runtime = await factory(conversation,frame => { frames.push(frame) },'voice')
    assert.equal(counters.connects,1)

    events.push({kind: 'provider_error',session_epoch: 1,code: 'disconnected',recoverable: true})
    await waitFor(() => counters.connects === 2,'conversation provider replacement')
    await waitFor(() => frames.some(frame => frame.type === 'conversation.notice'
      && frame.code === 'voice_provider_recovered'),'voice recovery notice')

    const noticeCodes = frames.filter(frame => frame.type === 'conversation.notice').map(frame => frame.code)
    assert.deepEqual(noticeCodes,['voice_provider_reconnecting','voice_provider_recovered'],
      'the user is told the gap started before being told it recovered')
    const reconnecting = frames.find(frame => frame.type === 'conversation.notice' && frame.code === 'voice_provider_reconnecting')
    assert.equal(reconnecting?.message,'语音连接中断，正在重连…')
    const recovered = frames.find(frame => frame.type === 'conversation.notice' && frame.code === 'voice_provider_recovered')
    assert.equal(recovered?.message,'语音连接已恢复，请再说一次')

    // The caption reset belongs to the gap, not to the recovery: an empty final user caption after the
    // recovery notice would make the desktop treat it as a fresh utterance and erase the notice.
    await new Promise(resolve => setTimeout(resolve,100))
    const recoveredAt = frames.findIndex(frame => frame.type === 'conversation.notice' && frame.code === 'voice_provider_recovered')
    assert.equal(frames.slice(recoveredAt + 1).some(frame => frame.type === 'caption'
      && frame.role === 'user' && frame.final === true && !frame.text),false,
      'no empty final user caption may follow the recovery notice')

    // No user turn was lost: an utterance into the fresh epoch still arms a
    // provider response. A silent dead session would leave `ensure` at zero.
    events.push({kind: 'user_speech_started',session_epoch: 2,speech_id: 'speech-after',provider_item_id: 'user-after'})
    events.push({kind: 'user_speech_ended',session_epoch: 2,speech_id: 'speech-after',provider_item_id: 'user-after'})
    events.push({kind: 'user_transcript_final',session_epoch: 2,item_id: 'user-after',text: '再说一次'})
    await waitFor(() => counters.ensure >= 1,'response request after reconnect')
    assert.equal(frames.some(frame => frame.type === 'conversation.notice' && frame.code === 'voice_provider_failed'),false,
      'a recoverable gap never reports the terminal voice failure')
  } finally {
    await runtime?.close().catch(() => { /* cleanup */ })
    runtime = undefined
  }
})
