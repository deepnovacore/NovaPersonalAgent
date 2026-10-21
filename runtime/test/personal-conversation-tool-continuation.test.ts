import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {createConversation} from '../src/personal-agent/conversations.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import type {CascadedLlmSession} from '../src/realtime/cascaded/llm.js'
import type {JsonValue} from '../src/core/events.js'

test('text chat continues after a task control tool and records its admission', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'nova-tool-continuation-'))
  const host = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const telemetry: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
  let requests = 0
  try {
    await host.open()
    const conversation = createConversation('chat', 'Tool continuation')
    const task = await host.tasks.delegate('initial', {conversation_id: conversation.id, goal: 'Review project', acceptance: [], origin_ref: 'conversation:1'})
    // This test owns the foreground control/continuation chain, not background task execution.
    host.wakeTask = () => Promise.resolve()
    const llm: CascadedLlmSession = {
      async *stream(input) {
        await Promise.resolve()
        const id = 'llm-' + ++requests
        yield {kind: 'response_started', response_id: id}
        if (requests === 1) {
          yield {kind: 'tool_call', item_id: 'item', call_id: 'continue-task', name: 'task', arguments: {operation: 'continue', task_id: task.id, source_refs: []}}
        } else {
          assert.ok(input.inputs.some(item => item.kind === 'tool_result'), 'the next request carries the captured tool result')
          yield {kind: 'text_delta', text: '已收到，任务会继续。'}
        }
        yield {kind: 'response_completed', response_id: id}
      },
      restoreHistory: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    }
    const factory = conversationRuntimeFactory({host, clock: new VirtualClock(), memory: () => undefined,
      settings: settingsSchema.parse({executors: [], camera_module_enabled: false, cascade_llm_provider: 'qwen', dashscope_api_key: 'test'}),
      searchTransport: {search: () => Promise.reject(Error('unexpected search'))},
      gateway: {complete: () => Promise.reject(Error('unexpected model')), async *stream() { await Promise.resolve(); throw Error('unexpected stream') }},
      telemetry: {record: (kind, payload) => { telemetry.push({kind, payload}) }, close: () => undefined},
      onDiagnostic: () => undefined,
      createTextProvider: options => buildCascadedTextProvider(options, {...cascadedProviderRegistries, llm: {...cascadedProviderRegistries.llm, qwen: () => ({open: () => llm})}}),
    })
    const runtime = await factory(conversation, () => undefined)
    try {
      const result = await runtime.runTurn('确认继续', AbortSignal.timeout(3000))
      assert.equal(result.assistant, '已收到，任务会继续。')
      assert.equal(requests, 2)
      assert.ok(telemetry.some(event => event.kind === 'tool.admission'), 'conversation graphs must retain service diagnostics')
      assert.ok(telemetry.every(event => event.payload.conversation_id === conversation.id), 'provider and service events identify their owning conversation')
    } finally { await runtime.close() }
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}) }
})
