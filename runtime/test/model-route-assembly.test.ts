import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {buildAssembly, buildModelRouteGateway} from '../src/composition/assembly.js'
import {buildTextRealtimeAssembly, cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {loadSettings, resolveModelRoute, settingsSchema, type Settings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {unconfiguredModelGateway, type ModelGateway} from '../src/model/model-gateway.js'
import {ResponsesModelGateway} from '../src/model/responses-model-gateway.js'

const clock = new VirtualClock()
const metrics = {record: () => undefined}

function settings(overrides: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    executors: [],
    tavily_api_key: 'tavily-key',
    ...overrides,
  })
}

interface FetchedCall {
  readonly url: string
  readonly model: string
}

function captureFetch(): {readonly calls: FetchedCall[]; restore(): void} {
  const previous = globalThis.fetch
  const calls: FetchedCall[] = []
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {model?: string}
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      model: body.model ?? '',
    })
    return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content: '{}'}}]}), {status: 200}))
  }
  globalThis.fetch = fetchStub
  return {calls, restore: () => { globalThis.fetch = previous }}
}

test('explicit routes select the support, compressor and watch gateways per lane', async () => {
  const fetchCalls = captureFetch()
  try {
    const assembly = buildAssembly({
      settings: settings({
        model_routes: {
          conversationText: {provider: 'openai', model: 'gpt-6-luna'},
          support: {provider: 'deepseek', model: 'deepseek-chat'},
          compressor: {provider: 'qwen', model: 'qwen-turbo'},
          watch: {provider: 'stepfun', model: 'step-3.7-flash'},
        },
        openai_api_key: 'openai-key',
        deepseek_api_key: 'deepseek-key',
        dashscope_api_key: 'dashkey',
        stepfun_api_key: 'stepfun-key',
      }),
      clock,
      metrics,
    })
    try {
      assert.equal(assembly.settings.support_model, 'deepseek-chat')
      assert.equal(assembly.settings.compressor_model, 'qwen-turbo')
      assert.equal(assembly.settings.watch_model, 'step-3.7-flash')
      assert.equal(assembly.settings.cascade_llm_provider, 'openai')
      assert.equal(assembly.settings.cascade_llm_model, 'gpt-6-luna')
      assert.equal(assembly.gateway, assembly.supportGateway, 'schedule/intake follow the support lane')
      await assembly.supportGateway.complete({model: 'deepseek-chat', system: '', prompt: 'hi'})
      await assembly.compressorGateway.complete({model: 'qwen-turbo', system: '', prompt: 'hi'})
      await assembly.watchGateway.complete({model: 'step-3.7-flash', system: '', prompt: 'hi'})
      assert.deepEqual(fetchCalls.calls, [
        {url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat'},
        {url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-turbo'},
        {url: 'https://api.stepfun.com/v1/chat/completions', model: 'step-3.7-flash'},
      ])
    } finally {
      await assembly.stop()
    }
  } finally {
    fetchCalls.restore()
  }
})

test('unrouted settings keep one legacy gateway for every lane', async () => {
  const injected: ModelGateway = {
    async *stream() { await Promise.resolve() },
    complete() { return Promise.resolve({text: 'ok'}) },
  }
  const assembly = buildAssembly({settings: settings({camera_module_enabled: false}), gateway: injected, clock, metrics})
  try {
    assert.equal(assembly.gateway, injected)
    assert.equal(assembly.supportGateway, injected)
    assert.equal(assembly.compressorGateway, injected)
    assert.equal(assembly.watchGateway, injected)
    assert.deepEqual([assembly.settings.support_model, assembly.settings.compressor_model, assembly.settings.watch_model],
      ['deepseek-flash', 'deepseek-flash', null])
    assert.deepEqual(assembly.settings.model_routes, {})
  } finally {
    await assembly.stop()
  }
})

test('a routed lane without its credential degrades instead of blocking startup', async () => {
  const assembly = buildAssembly({
    settings: settings({
      model_routes: {support: {provider: 'openai', model: 'gpt-6-luna'}},
      camera_module_enabled: false,
    }),
    clock,
    metrics,
  })
  try {
    assert.equal(assembly.gateway, assembly.supportGateway)
    assert.equal(assembly.supportGateway, unconfiguredModelGateway)
    assert.equal(assembly.settings.support_model, 'gpt-6-luna')
    await assert.rejects(assembly.supportGateway.complete({model: 'gpt-6-luna', system: '', prompt: 'x'}),
      /support_model_unconfigured/u)
  } finally {
    await assembly.stop()
  }
})

test('route gateways honor the compatible protocol and keyless self-hosted endpoints', () => {
  const compatible = settings({
    model_routes: {support: {provider: 'openai-compatible', model: 'gpt-6-sol'}},
    openai_compatible_base_url: 'https://compatible.example/v1',
    openai_compatible_api_key: 'compatible-key',
    openai_compatible_protocol: 'responses',
  })
  const compatibleRoute = resolveModelRoute(compatible, 'support')
  assert.ok(compatibleRoute !== null)
  assert.equal(buildModelRouteGateway(compatibleRoute, {clock, protocol: 'responses'}) instanceof ResponsesModelGateway, true)
  assert.equal(buildModelRouteGateway(compatibleRoute, {clock, protocol: 'chat-completions'}) instanceof ResponsesModelGateway, false)
  const selfHostedRoute = resolveModelRoute(settings({
    model_routes: {support: {provider: 'self-hosted', model: 'local-model'}},
    self_hosted_llm_base_url: 'http://127.0.0.1:11434/v1',
  }), 'support')
  assert.ok(selfHostedRoute !== null)
  assert.equal(selfHostedRoute.missing, null, 'a local server may run without a credential')
  assert.notEqual(buildModelRouteGateway(selfHostedRoute, {clock}), unconfiguredModelGateway)
})

test('cascaded support composition never rewrites explicitly routed lane models', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-model-routes-'))
  const llm = () => ({open: () => ({
    stream: () => { throw Error('unexpected conversation request') },
    restoreHistory: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve(), close: () => Promise.resolve(),
  })})
  try {
    const configured = loadSettings({
      PIPELINE_MODE: 'cascaded',
      CASCADE_LLM_PROVIDER: 'qwen',
      CASCADE_LLM_MODEL: 'qwen-plus',
      DASHSCOPE_API_KEY: 'dash-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
      DOUBAO_BIGMODEL_API_KEY: 'speech-key',
      TAVILY_API_KEY: 'search-key',
      MEMORY_CONNECTION: 'disabled',
      CAMERA_MODULE_ENABLED: 'false',
      MODEL_ROUTES: JSON.stringify({
        conversationText: {provider: 'deepseek', model: 'deepseek-chat'},
        support: {provider: 'deepseek', model: 'deepseek-flash'},
        compressor: {provider: 'deepseek', model: 'deepseek-chat'},
        watch: {provider: 'deepseek', model: 'deepseek-flash'},
      }),
    })
    const realtime = buildTextRealtimeAssembly({
      settings: configured,
      clock,
      metrics,
      blackboard: {path: join(directory, 'blackboard.sqlite'), ownerId: 'test'},
    }, {...cascadedProviderRegistries, llm: {qwen: llm, ark: llm}})
    try {
      assert.equal(realtime.core.settings.cascade_llm_provider, 'deepseek')
      assert.equal(realtime.core.settings.cascade_llm_model, 'deepseek-chat')
      assert.equal(realtime.core.settings.support_model, 'deepseek-flash')
      assert.equal(realtime.core.settings.compressor_model, 'deepseek-chat')
      assert.equal(realtime.core.settings.watch_model, 'deepseek-flash')
      assert.equal(realtime.core.gateway, realtime.core.supportGateway)
      assert.deepEqual(realtime.core.settings.model_routes, {
        conversationText: {provider: 'deepseek', model: 'deepseek-chat'},
        support: {provider: 'deepseek', model: 'deepseek-flash'},
        compressor: {provider: 'deepseek', model: 'deepseek-chat'},
        watch: {provider: 'deepseek', model: 'deepseek-flash'},
      })
    } finally {
      await realtime.stop()
    }
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
