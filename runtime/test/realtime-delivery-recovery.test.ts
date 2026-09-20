import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {PlaybackRegistry} from '../src/realtime/playback.js'
import {RealtimeSession, type SessionProvider} from '../src/realtime/session.js'
import type {HostContextItem} from '../src/realtime/protocol.js'

function harness(requested: boolean) {
  let seq = 0
  const idFactory = () => `id-${++seq}`
  const clock = new VirtualClock()
  const injected: HostContextItem[] = []
  const provider: SessionProvider = {
    userResponseMode: requested ? 'requested' : 'automatic',
    connect: () => Promise.resolve({epoch: 1}),
    injectHostItem: item => {injected.push(item); return Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id})},
    createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
  }
  const playback = new PlaybackRegistry({idFactory, onFrame: () => undefined, onClear: () => undefined})
  const session = new RealtimeSession({provider, playback, clock, idFactory})
  async function result(id: string, text: string, options: {source?: HostContextItem['source']; spoken?: boolean} = {}) {
    const item: HostContextItem = {kind: 'final', event_id: id, host_item_id: id, content: text, call_id: null, ...(options.source === undefined ? {} : {source: options.source})}
    await session.deliverHostResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false})
    await session.accept({kind: 'response_started', session_epoch: 1, response_id: id,
      origin: {kind: 'host_request', host_item_id: id}})
    await session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: id, pcm: new Uint8Array([1, 0])})
    await session.accept({kind: 'response_terminal', session_epoch: 1, response_id: id, status: 'completed', reason: 'done'})
    const generation = session.currentGeneration!
    session.playbackStarted(generation.utterance_id, generation.generation_epoch)
    if (options.spoken) session.playbackDone(generation.utterance_id, generation.generation_epoch, 100)
    else await session.playbackStopped(generation.utterance_id, generation.generation_epoch, 20)
  }
  return {session, clock, injected, result}
}

for (const newerQuestion of [false, true]) {
  test(`completed answers cannot revive a question; newer question preserved: ${newerQuestion}`, async () => {
    const {session} = harness(false)
    await session.connect({tools: []})
    await session.accept({kind: 'user_transcript_final', session_epoch: 1, item_id: 'old-question', text: '今天天气怎么样？'})
    await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'answer'})
    await session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'answer', pcm: new Uint8Array([1, 0])})
    await session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'answer', status: 'completed', reason: 'done'})
    const answered = session.currentGeneration!
    session.playbackStarted(answered.utterance_id, answered.generation_epoch)
    if (newerQuestion) await session.accept({kind: 'user_transcript_final', session_epoch: 1, item_id: 'new-question', text: '游戏改了什么？'})
    assert.equal(session.playbackDone(answered.utterance_id, answered.generation_epoch, 100), true)
    assert.equal(session.deliveryRecoveryContext().content, null)
    await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'later'})
    await session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'later', pcm: new Uint8Array([1, 0])})
    await session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'later', status: 'completed', reason: 'done'})
    const later = session.currentGeneration!
    session.playbackStarted(later.utterance_id, later.generation_epoch)
    await session.playbackStopped(later.utterance_id, later.generation_epoch, 20)
    const recovered = session.deliveryRecoveryContext().content
    if (newerQuestion) assert.match(recovered ?? '', /游戏改了什么/u)
    else assert.equal(recovered, null)
    assert.doesNotMatch(recovered ?? '', /今天天气/u)
  })
}

for (const input of ['speech', 'transcript-only', 'late-same-turn', 'late-item-id'] as const) {
  test(`in-flight answer binds only its own question: ${input}`, async () => {
    const {session} = harness(false)
    await session.connect({tools: []})
    const late = input.startsWith('late')
    await session.accept({kind: 'user_speech_started', session_epoch: 1, speech_id: 'speech-a', provider_item_id: input === 'late-item-id' ? null : 'a'})
    await session.accept({kind: 'user_speech_ended', session_epoch: 1, speech_id: 'speech-a', provider_item_id: 'a'})
    if (!late) await session.accept({kind: 'user_transcript_final', session_epoch: 1, item_id: 'a', text: '第一个问题'})
    await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'answer-a'})
    await session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'answer-a', pcm: new Uint8Array([1, 0])})
    if (input === 'speech') {
      await session.accept({kind: 'user_speech_started', session_epoch: 1, speech_id: 'speech-b', provider_item_id: 'b'})
      await session.accept({kind: 'user_speech_ended', session_epoch: 1, speech_id: 'speech-b', provider_item_id: 'b'})
    }
    await session.accept({kind: 'user_transcript_final', session_epoch: 1, item_id: late ? 'a' : 'b', text: late ? '第一个问题' : '第二个问题'})
    assert.equal(session.providerTurnUserInputRevision('answer-a'), 1)
    assert.equal(session.userInputRevision, late ? 1 : 2)
    await session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'answer-a', status: 'completed', reason: 'done'})
    const first = session.currentGeneration!
    session.playbackStarted(first.utterance_id, first.generation_epoch)
    session.playbackDone(first.utterance_id, first.generation_epoch, 100)
    await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'later'})
    await session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'later', pcm: new Uint8Array([1, 0])})
    await session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'later', status: 'completed', reason: 'done'})
    const later = session.currentGeneration!
    session.playbackStarted(later.utterance_id, later.generation_epoch)
    await session.playbackStopped(later.utterance_id, later.generation_epoch, 20)
    const content = session.deliveryRecoveryContext().content
    if (late) assert.equal(content, null)
    else assert.match(content ?? '', /第二个问题/u)
  })
}

for (const requested of [false, true]) {
  test(`interrupted facts are recomposed as one bounded response (${requested ? 'cascaded' : 'integrated'})`, async () => {
    const h = harness(requested)
    await h.session.connect({tools: []})
    await h.result('weather', '上海周六阵雨。')
    await h.result('coding', '标题已修改，测试通过。')
    assert.match(h.session.deliveryRecoveryContext().content ?? '', /上海周六阵雨/u)
    assert.match(h.session.deliveryRecoveryContext().content ?? '', /标题已修改/u)
    assert.equal(await h.session.requestDeliveryRecovery(), true)
    const item = h.injected.at(-1)!
    assert.equal(item.kind, 'recovery')
    await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'combined',
      origin: {kind: 'host_request', host_item_id: item.host_item_id}})
    await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'combined', pcm: new Uint8Array([1, 0])})
    await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'combined', status: 'completed', reason: 'done'})
    const generation = h.session.currentGeneration!
    assert.equal(h.session.playbackDone(generation.utterance_id, generation.generation_epoch + 1, 200), false)
    assert.notEqual(h.session.deliveryRecoveryContext().content, null)
    h.session.playbackStarted(generation.utterance_id, generation.generation_epoch)
    assert.equal(h.session.playbackDone(generation.utterance_id, generation.generation_epoch, 200), true)
    assert.equal(h.session.deliveryRecoveryContext().content, null)
  })
}

test('approvals never enter recovery and expired facts do not cause repeated speech', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('approval:private:requested', 'internal confirm instructions')
  assert.equal(h.session.deliveryRecoveryContext().content, null)
  await h.result('background:work-1', 'Already submitted')
  assert.equal(h.session.deliveryRecoveryContext().content, null)
  await h.result('weather', 'Old weather')
  h.clock.advanceTo(301)
  assert.equal(await h.session.requestDeliveryRecovery(), false)
})

test('automatic response cannot settle a recovery context confirmed after generation started', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '明天有雨。')
  const context = h.session.deliveryRecoveryContext()
  await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'too-early'})
  h.session.confirmDeliveryRecovery(context.version, 1)
  await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'too-early', pcm: new Uint8Array([1, 0])})
  await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'too-early', status: 'completed', reason: 'done'})
  const first = h.session.currentGeneration!
  h.session.playbackStarted(first.utterance_id, first.generation_epoch)
  h.session.playbackDone(first.utterance_id, first.generation_epoch, 100)
  assert.notEqual(h.session.deliveryRecoveryContext().content, null)
  await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'combined-user-answer'})
  await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'combined-user-answer', pcm: new Uint8Array([1, 0])})
  await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'combined-user-answer', status: 'completed', reason: 'done'})
  const second = h.session.currentGeneration!
  h.session.playbackStarted(second.utterance_id, second.generation_epoch)
  h.session.playbackDone(second.utterance_id, second.generation_epoch, 100)
  assert.equal(h.session.deliveryRecoveryContext().content, null)
})

test('a tool-only response does not consume pending facts', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '明天有雨。')
  h.session.confirmDeliveryRecovery(h.session.deliveryRecoveryContext().version, 1)
  await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'tool'})
  await h.session.accept({kind: 'tool_call_ready', session_epoch: 1, response_id: 'tool', call_id: 'call',
    item_id: 'function', name: 'search', arguments: {query: '天气'}})
  await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'tool', status: 'completed', reason: 'done'})
  assert.match(h.session.deliveryRecoveryContext().content ?? '', /明天有雨/u)
})


test('two interrupted recovery playbacks exhaust the bounded retry budget', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '明天有雨。')
  for (const responseId of ['retry-1', 'retry-2']) {
    assert.equal(await h.session.requestDeliveryRecovery(), true)
    const item = h.injected.at(-1)!
    await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: responseId,
      origin: {kind: 'host_request', host_item_id: item.host_item_id}})
    await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: responseId, pcm: new Uint8Array([1, 0])})
    await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: responseId, status: 'completed', reason: 'done'})
    const generation = h.session.currentGeneration!
    h.session.playbackStarted(generation.utterance_id, generation.generation_epoch)
    await h.session.playbackStopped(generation.utterance_id, generation.generation_epoch, 20)
  }
  assert.equal(await h.session.requestDeliveryRecovery(), false)
  assert.equal(h.session.deliveryRecoveryContext().content, null)
})


test('an interrupted combined answer retains the latest user question', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '上海阵雨')
  await h.session.accept({kind: 'user_transcript_final', session_epoch: 1, item_id: 'question', text: '游戏改了什么？'})
  h.session.confirmDeliveryRecovery(h.session.deliveryRecoveryContext().version, 1)
  await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'combined'})
  await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'combined', pcm: new Uint8Array([1, 0])})
  await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'combined', status: 'completed', reason: 'done'})
  const g = h.session.currentGeneration!
  h.session.playbackStarted(g.utterance_id, g.generation_epoch)
  await h.session.playbackStopped(g.utterance_id, g.generation_epoch, 20)
  assert.match(h.session.deliveryRecoveryContext().content ?? '', /游戏改了什么/u)
  assert.match(h.session.deliveryRecoveryContext().content ?? '', /上海阵雨/u)
})

test('standalone recovery stops after two no-audio attempts', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '上海阵雨')
  for (let i = 0; i < 2; i++) {
    assert.equal(await h.session.requestDeliveryRecovery(), true)
    await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: `empty-${i}`})
    await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: `empty-${i}`, status: 'completed', reason: 'done'})
  }
  assert.equal(await h.session.requestDeliveryRecovery(), false)
})

test('control tool receipts are not eligible recovery evidence', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  const item: HostContextItem = {kind: 'tool_output', host_item_id: 'control', event_id: 'random-id', call_id: 'call', content: '{"code":"approval_accepted"}'}
  await h.session.injectToolOutput(item)
  await h.session.deliverHostResponse({kind: 'tool_result', item, task_summary: null, origin_spoken: false})
  await h.session.accept({kind: 'response_started', session_epoch: 1, response_id: 'control'})
  await h.session.accept({kind: 'response_audio_delta', session_epoch: 1, response_id: 'control', pcm: new Uint8Array([1, 0])})
  await h.session.accept({kind: 'response_terminal', session_epoch: 1, response_id: 'control', status: 'completed', reason: 'done'})
  const g = h.session.currentGeneration!
  h.session.playbackStarted(g.utterance_id, g.generation_epoch)
  await h.session.playbackStopped(g.utterance_id, g.generation_epoch, 20)
  assert.equal(h.session.deliveryRecoveryContext().content, null)
})


test('source event versions supersede old pending facts without erasing newer ones', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  const source = {work_id: 'work', executor: 'coding'}
  await h.result('old', '正在编写页面', {source: {...source, event_seq: 1}})
  await h.result('new', '正在测试', {source: {...source, event_seq: 2}, spoken: true})
  assert.equal(h.session.deliveryRecoveryContext().content, null)
  await h.result('newest', '发现测试问题', {source: {...source, event_seq: 3}})
  await h.result('late', '旧的测试通知', {source: {...source, event_seq: 2}, spoken: true})
  assert.match(h.session.deliveryRecoveryContext().content ?? '', /发现测试问题/u)
  await h.result('late-interruption', '过时编写进度', {source: {...source, event_seq: 1}})
  assert.doesNotMatch(h.session.deliveryRecoveryContext().content ?? '', /过时编写进度/u)
})


test('admission refusal preserves recovery budget but delivery failures are bounded', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  await h.result('weather', '上海阵雨')
  h.session.deliverHostResponse = () => Promise.resolve({accepted: false, injectionEpoch: null})
  for (let i = 0; i < 3; i++) assert.equal(await h.session.requestDeliveryRecovery(), false)
  assert.match(h.session.deliveryRecoveryContext().content ?? '', /上海阵雨/u)
  h.session.deliverHostResponse = () => Promise.reject(new Error('transport failure'))
  for (let i = 0; i < 2; i++) await assert.rejects(h.session.requestDeliveryRecovery(), /transport failure/u)
  assert.equal(await h.session.requestDeliveryRecovery(), false)
})


test('recently updated work retains its version fence when the bounded cache fills', async () => {
  const h = harness(false)
  await h.session.connect({tools: []})
  const source = {work_id: 'active', executor: 'coding'}
  await h.result('active-first', 'active', {source: {...source, event_seq: 5}, spoken: true})
  for (let i = 0; i < 63; i++) await h.result(`other-${i}`, 'done', {source: {work_id: `other-${i}`, executor: 'coding', event_seq: 1}, spoken: true})
  await h.result('active-update', 'active update', {source: {...source, event_seq: 6}, spoken: true})
  await h.result('extra', 'done', {source: {work_id: 'extra', executor: 'coding', event_seq: 1}, spoken: true})
  await h.result('late-active', '过时进度', {source: {...source, event_seq: 1}})
  assert.equal(h.session.deliveryRecoveryContext().content, null)
})
