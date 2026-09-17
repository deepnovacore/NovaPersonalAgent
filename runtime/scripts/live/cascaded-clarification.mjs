// Real adapter + Qwen; synthetic user/host turns and silent TTS, no microphone or executor.
import assert from 'node:assert/strict'
import {CascadedRealtimeAdapter} from '../../dist/src/realtime/cascaded/adapter.js'
import {createQwenCascadedLlmFactory} from '../../dist/src/realtime/cascaded/qwen-llm.js'
import {finalSpeechView} from '../../dist/src/realtime/evidence.js'
import {configuration, surface} from './text-tools.mjs'

const compiled = surface()
const config = configuration(process.env, 'qwen')
const requests = []
const llm = createQwenCascadedLlmFactory({...config, instructions: compiled.instructions,
  fetchImpl: (url, init) => { requests.push(JSON.parse(init.body)); return fetch(url, init) },
}).open()
const tts = {async open() {
  let release
  const finished = new Promise(resolve => { release = resolve })
  return {
    async sendText() {}, async finish() { release() }, async cancel() { release() },
    async close() { release() }, async *events() { await finished },
  }
}}
const adapter = new CascadedRealtimeAdapter({llm, tts,
  endpointing: {async feed() { return [] }, async reset() {}},
  asr: {async open() { throw Error('Text probe does not use ASR') }},
})
const signal = AbortSignal.timeout(90_000)
const events = []
const waiting = []
function nextTerminal() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Terminal timeout')), 30_000)
    waiting.push(event => { clearTimeout(timer); resolve(event) })
  })
}
await adapter.connect({tools: compiled.tools.map(tool => ({type: 'function', function: tool})), signal})
const reader = (async () => {
  for await (const event of adapter.events(signal)) {
    events.push(event)
    if (event.kind === 'response_terminal') waiting.shift()?.(event)
  }
})()
const userSources = []
async function user(text) {
  userSources.push({ref: `conversation:${userSources.length + 1}`, text})
  await adapter.replaceResponseAdaptation({revision: userSources.length, content: null, user_sources: userSources}, signal)
  const start = events.length
  const ended = nextTerminal()
  await adapter.submitText(text, signal)
  await adapter.ensureResponse(signal)
  assert.equal((await ended).status, 'completed')
  return events.slice(start)
}
function response(events) {
  return {
    text: events.filter(event => event.kind === 'response_transcript_delta').map(event => event.text).join(''),
    calls: events.filter(event => event.kind === 'tool_call_ready').map(({name, arguments: args}) => ({name, arguments: args})),
  }
}
try {
  const first = await user('帮我写一个俄罗斯方块。')
  assert.equal(first.some(event => event.kind === 'tool_call_ready'), false, 'Ambiguous request must clarify')
  assert.match(response(first).text, /网页|桌面/, 'Clarification must address the missing platform')
  const second = await user('做成浏览器网页，键盘控制，显示分数，不要安装依赖。')
  const call = second.find(event => event.kind === 'tool_call_ready')
  assert.ok(call, `Clarified request must dispatch: ${JSON.stringify(response(second))}`)
  assert.equal(call.name, 'dispatch')
  assert.ok(call.arguments.source_refs?.includes('conversation:1'), 'Dispatch must select the original user goal')
  const receipt = {
    kind: 'tool_output', host_item_id: 'probe-receipt', event_id: 'probe-receipt', call_id: call.call_id,
    content: JSON.stringify({code: 'intake_opened', execution_started: false}),
  }
  await adapter.injectHostItem(receipt, {signal, confirmationTimeout: null, asUserActivation: false})
  const count = requests.length
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(requests.length, count, 'Receipt alone must not request the model')
  const waitingFact = {kind: 'final', host_item_id: 'probe-waiting', event_id: 'probe-waiting', call_id: null,
    content: '正在安排任务，尚未开始执行。'}
  await adapter.injectHostItem(waitingFact, {signal, confirmationTimeout: null, asUserActivation: false})
  const waitingStart = events.length
  const waitingEnded = nextTerminal()
  await adapter.createResponse({kind: 'host_fact', item: waitingFact, task_summary: null, origin_spoken: false}, signal)
  assert.equal((await waitingEnded).status, 'completed')
  const waitingResponse = response(events.slice(waitingStart))
  assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.tool_call_id === call.call_id))
  assert.equal(waitingResponse.calls.length, 0)
  assert.ok(waitingResponse.text.length <= 80, 'Waiting feedback must stay brief')
  assert.doesNotMatch(waitingResponse.text, /[？?]/)
  const fact = {
    kind: 'final', host_item_id: 'probe-question', event_id: 'probe-question', call_id: null,
    content: '请只问用户这一项：是在现有的游戏项目里做，还是创建新项目？',
  }
  await adapter.injectHostItem(fact, {signal, confirmationTimeout: null, asUserActivation: false})
  const start = events.length
  const ended = nextTerminal()
  await adapter.createResponse({kind: 'host_fact', item: fact, task_summary: null, origin_spoken: false}, signal)
  assert.equal((await ended).status, 'completed')
  const final = response(events.slice(start))
  assert.equal(final.calls.length, 0)
  assert.equal(requests.length, count + 2)
  assert.equal(requests.at(-1).tools, undefined)
  assert.match(requests.at(-1).messages.at(-1).content, /宿主激活事实/)
  assert.match(final.text, /项目.*[？?]/, 'Must ask the actual project question')
  const failures = []
  for (const [outcome, content] of [
    ['refused', {error: 'superseded'}],
    ['failed', {code: 'resume_unavailable', diagnostic: {method: 'thread/resume', server_code: -32600, message: 'no rollout found for thread'}}],
  ]) {
    const failureFact = {...fact, host_item_id: `probe-failure-${failures.length}`, event_id: `probe-failure-${failures.length}`,
      content: finalSpeechView(outcome, content, 'Codex')}
    await adapter.injectHostItem(failureFact, {signal, confirmationTimeout: null, asUserActivation: false})
    const failureStart = events.length
    const failureEnded = nextTerminal()
    await adapter.createResponse({kind: 'host_fact', item: failureFact, task_summary: null, origin_spoken: false}, signal)
    assert.equal((await failureEnded).status, 'completed')
    const failure = response(events.slice(failureStart))
    assert.equal(failure.calls.length, 0)
    assert.match(failure.text, /(?:未|没).*启动/)
    assert.doesNotMatch(failure.text, /确认|修正请求|请问|请选择|需要您|需要你|[？?]|将.*重试|会.*重试/)
    failures.push(failure)
  }
  const followup = response(await user('请让 Codex 在当前项目里运行刚才完成的网页游戏，并用本机浏览器打开它。'))
  assert.equal(followup.calls[0]?.name, 'dispatch', 'Artifact operation must dispatch instead of inventing a permission refusal')
  assert.equal(followup.text, '')
  console.log(JSON.stringify({passed: true, model: config.model, requests: requests.length,
    responses: [response(first), response(second), waitingResponse, final, ...failures, followup],
    scope: 'Real adapter and Qwen; synthetic TTS and host fact; no audio device or executor',
  }, null, 2))
} finally {
  await adapter.close()
  await reader
}
