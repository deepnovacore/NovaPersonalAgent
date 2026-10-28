import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createChatCompletionsLlmFactory, type ChatCompletionsLlmFactoryOptions} from '../src/realtime/cascaded/chat-completions-llm.js'
import {mergeTurnText} from '../src/realtime/cascaded/llm.js'
import type {CascadedLlmEvent} from '../src/realtime/cascaded/llm.js'

async function collect(stream: AsyncIterable<CascadedLlmEvent>): Promise<CascadedLlmEvent[]> {
  const events: CascadedLlmEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function sse(...events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: {'content-type': 'text/event-stream'},
  })
}

const signal = (): AbortSignal => new AbortController().signal

test('chat completions always sends an explicit provider output ceiling', async () => {
  const table: readonly (readonly [ChatCompletionsLlmFactoryOptions['provider'], string, number])[] = [
    ['deepseek', 'max_tokens', 8192], ['qwen', 'max_tokens', 8192],
    ['openai', 'max_completion_tokens', 16384], ['gemini', 'max_tokens', 8192],
    ['self-hosted', 'max_tokens', 8192], ['openai-compatible', 'max_tokens', 8192],
  ]
  for (const [provider, field, value] of table) {
    const bodies: Record<string, unknown>[] = []
    const session = createChatCompletionsLlmFactory({
      provider, baseUrl: 'https://example.test', apiKey: 'test', model: 'test', instructions: 'Plan',
      fetchImpl: (_url, init) => {
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
        return Promise.resolve(sse({id: 'r', choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}]}))
      },
    }).open()
    try {
      await collect(session.stream({inputs: [{kind: 'user_text', text: 'hi'}], tools: [], signal: signal()}))
    } finally { await session.close() }
    assert.equal(bodies[0]?.[field], value, `${provider} must declare its output ceiling`)
  }
})

test('a length finish is a first-class output limit that keeps displayable narration', async () => {
  const session = createChatCompletionsLlmFactory({
    provider: 'qwen', baseUrl: 'https://example.test', apiKey: 'test', model: 'test', instructions: 'Plan',
    fetchImpl: () => Promise.resolve(sse(
      {id: 'r-limit', choices: [{delta: {content: '前半段'}}]},
      {id: 'r-limit', choices: [{delta: {}, finish_reason: 'length'}]},
    )),
  }).open()
  const tools = [{name: 'lookup', parameters: {type: 'object' as const}}]
  try {
    const events = await collect(session.stream({inputs: [{kind: 'user_text', text: '长文'}], tools, previewText: true, signal: signal()}))
    assert.deepEqual(events.filter(event => event.kind === 'text_preview').map(event => event.text), ['前半段'])
    assert.deepEqual(events.filter(event => event.kind === 'text_delta').map(event => event.text), ['前半段'])
    const failed = events.at(-1)
    assert.equal(failed?.kind, 'response_failed')
    if (failed?.kind === 'response_failed') {
      assert.equal(failed.code, 'output_limit')
      assert.equal(failed.detail, 'length')
    }
    // The failure is respendable: the same host session accepts the turn again unchanged.
    const replay = await collect(session.stream({inputs: [{kind: 'user_text', text: '长文'}], tools, previewText: true, signal: signal()}))
    assert.deepEqual(replay.filter(event => event.kind === 'text_delta').map(event => event.text), ['前半段'])
  } finally { await session.close() }
})

test('a length finish during tool arguments never exposes a partial call', async () => {
  const session = createChatCompletionsLlmFactory({
    provider: 'deepseek', baseUrl: 'https://example.test', apiKey: 'test', model: 'test', instructions: 'Plan',
    fetchImpl: () => Promise.resolve(sse(
      {id: 'r-tool', choices: [{delta: {tool_calls: [{index: 0, id: 'call-1',
        function: {name: 'file_write', arguments: '{"path":"big.txt","content":"half'}}]}}]},
      {id: 'r-tool', choices: [{delta: {}, finish_reason: 'length'}]},
    )),
  }).open()
  try {
    const events = await collect(session.stream({
      inputs: [{kind: 'user_text', text: 'write'}], tools: [{name: 'file_write', parameters: {type: 'object'}}],
      previewText: true, signal: signal(),
    }))
    assert.equal(events.some(event => event.kind === 'tool_call'), false, 'truncated arguments must never run')
    const failed = events.at(-1)
    assert.equal(failed?.kind, 'response_failed')
    if (failed?.kind === 'response_failed') {
      assert.equal(failed.code, 'output_limit')
      assert.equal(failed.detail, 'tool_arguments')
    }
    assert.equal((session.checkpoint!() as {pending: unknown}).pending, null)
  } finally { await session.close() }
})

test('turn text merges later responses without repeating the opening', () => {
  assert.equal(mergeTurnText('', '首段'), '首段')
  assert.equal(mergeTurnText('首段', ''), '首段')
  assert.equal(mergeTurnText('首段', '首段续写'), '首段续写')
  assert.equal(mergeTurnText('首段', '尾段'), '首段\n\n尾段')
  assert.equal(mergeTurnText('首段\n\n尾段', '尾段'), '首段\n\n尾段')
})
