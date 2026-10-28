import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  ConfigurationError,
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DEEPSEEK_BASE_URL,
  OPENAI_BASE_URL,
  STEPFUN_COMPATIBLE_BASE_URL,
  loadSettings,
  memoryStatus,
  missingKnowledgeCredential,
  missingWatchModelCredential,
  requirePersonalMemory,
  resolveEmbeddingConnection,
  resolveMemoryExtractionConnection,
  resolveModelRoute,
  resolveWatchModelConnection,
  type Settings,
} from '../src/config/config.js'
import {
  MODEL_CATALOG,
  MODEL_CATALOG_MODELS,
  MODEL_CATALOG_PROVIDERS,
  MODEL_LANE_IDS,
  catalogModel,
  defaultMaxOutputTokens,
  modelCapabilities,
  modelLabel,
  providerLabel,
  providerSupports,
} from '../src/model/model-catalog.js'
import {VISION_MODELS} from '../src/model/vision-capability.js'

const dense = (value: unknown): string => JSON.stringify(value)

function laneProjection(settings: Settings): unknown {
  return {
    conversationText: resolveModelRoute(settings, 'conversationText'),
    support: resolveModelRoute(settings, 'support'),
    fast: resolveModelRoute(settings, 'fast'),
    compressor: resolveModelRoute(settings, 'compressor'),
    watch: resolveModelRoute(settings, 'watch'),
    embedding: resolveModelRoute(settings, 'embedding'),
    support_model: settings.support_model,
    fast_model: settings.fast_model,
    compressor_model: settings.compressor_model,
    watch_model: settings.watch_model,
    embedding_model: settings.embedding_model,
    cascade_llm_provider: settings.cascade_llm_provider,
    cascade_llm_model: settings.cascade_llm_model,
  }
}

test('absent, empty or explicitly null MODEL_ROUTES keeps every legacy default', () => {
  const legacy = laneProjection(loadSettings({}))
  for (const raw of [undefined, '', '   ', dense({conversationText: null, support: null, fast: null, compressor: null, watch: null, embedding: null})]) {
    const settings = loadSettings(raw === undefined ? {} : {MODEL_ROUTES: raw})
    assert.deepEqual(settings.model_routes, {}, String(raw))
    assert.deepEqual(laneProjection(settings), legacy, String(raw))
  }
  const integrated = loadSettings({})
  assert.deepEqual([integrated.support_model, integrated.fast_model, integrated.compressor_model, integrated.watch_model],
    ['qwen-flash', 'qwen-flash', 'qwen-flash', 'qwen3-vl-plus'])
  const text = loadSettings({}, true)
  assert.equal(text.cascade_llm_provider, 'deepseek')
  assert.equal(text.cascade_llm_model, null)
  assert.deepEqual([text.support_model, text.fast_model, text.compressor_model, text.watch_model],
    ['deepseek-flash', 'deepseek-flash', 'deepseek-flash', 'deepseek-flash'])
  assert.equal(text.embedding_model, 'text-embedding-v4')
})

test('malformed MODEL_ROUTES is one configuration error instead of partial routing', () => {
  for (const raw of [
    '{',
    '[]',
    'null',
    dense({unknownLane: {provider: 'deepseek', model: 'deepseek-flash'}}),
    dense({support: {provider: 'deepseek', model: 'deepseek-flash', extra: true}}),
    dense({support: {provider: 'nowhere', model: 'deepseek-flash'}}),
    dense({support: {provider: 'deepseek', model: '   '}}),
    dense({support: {provider: 'deepseek', model: 'bad\u0000model'}}),
    dense({conversationText: {provider: 'stepfun', model: 'step-3.7-flash'}}),
    dense({watch: {provider: 'gemini', model: 'gemini-3.5-flash-lite'}}),
    dense({embedding: {provider: 'openai', model: 'text-embedding-v4'}}),
    dense({embedding: {provider: 'dashscope'}}),
  ]) {
    assert.throws(() => loadSettings({MODEL_ROUTES: raw}), (error: unknown) =>
      error instanceof ConfigurationError && error.message === 'invalid configuration: MODEL_ROUTES', raw)
  }
})

test('MODEL_ROUTES overrides each lane model and gates the routed provider credentials', () => {
  const settings = loadSettings({
    PIPELINE_MODE: 'integrated',
    INTEGRATED_PROVIDER: 'qwen',
    MODEL_ROUTES: dense({
      conversationText: {provider: 'openai', model: 'gpt-6-luna'},
      support: {provider: 'deepseek', model: 'deepseek-chat'},
      fast: {provider: 'stepfun', model: 'step-3.7-flash'},
      compressor: {provider: 'qwen', model: 'qwen-turbo'},
      watch: {provider: 'ark', model: 'doubao-seed-2-0-pro-260215'},
      embedding: {provider: 'dashscope', model: 'text-embedding-v4'},
    }),
    OPENAI_API_KEY: 'openai-key',
    DEEPSEEK_API_KEY: 'deepseek-key',
    STEPFUN_API_KEY: 'stepfun-key',
    DASHSCOPE_API_KEY: 'dash-key',
    ARK_API_KEY: 'ark-key',
    VOLCENGINE_ARK_BASE_URL: 'https://ark.example/api/v3',
  }, true)
  assert.equal(settings.cascade_llm_provider, 'openai')
  assert.equal(settings.cascade_llm_model, 'gpt-6-luna')
  assert.deepEqual([settings.support_model, settings.fast_model, settings.compressor_model, settings.watch_model],
    ['deepseek-chat', 'step-3.7-flash', 'qwen-turbo', 'doubao-seed-2-0-pro-260215'])
  assert.equal(settings.embedding_model, 'text-embedding-v4')
  assert.equal(settings.stepfun_api_key, 'stepfun-key', 'a routed StepFun lane reads its own credential')
  assert.equal(settings.ark_api_key, 'ark-key', 'a routed Ark lane reads its own credential')
  assert.equal(settings.dashscope_api_key, 'dash-key')
  assert.deepEqual(resolveModelRoute(settings, 'support'), {
    provider: 'deepseek', model: 'deepseek-chat', baseUrl: DEEPSEEK_BASE_URL,
    apiKey: 'deepseek-key', missing: null,
  })
  assert.deepEqual(resolveModelRoute(settings, 'conversationText')?.baseUrl, OPENAI_BASE_URL)
  assert.deepEqual(resolveModelRoute(settings, 'fast')?.baseUrl, STEPFUN_COMPATIBLE_BASE_URL)
  assert.deepEqual(resolveModelRoute(settings, 'compressor')?.baseUrl, DASHSCOPE_COMPATIBLE_BASE_URL)
  assert.deepEqual(resolveModelRoute(settings, 'watch'), {
    provider: 'ark', model: 'doubao-seed-2-0-pro-260215', baseUrl: 'https://ark.example/api/v3',
    apiKey: 'ark-key', missing: null,
  })
  assert.deepEqual(resolveModelRoute(settings, 'embedding'), {
    provider: 'dashscope', model: 'text-embedding-v4', baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey: 'dash-key', missing: null,
  })
  assert.equal(resolveModelRoute(loadSettings({}), 'support'), null)
})

test('an inactive conversationText lane stays unread, an active cascaded one becomes the text model', () => {
  const route = dense({conversationText: {provider: 'openai', model: 'gpt-6-luna'}})
  const integrated = loadSettings({MODEL_ROUTES: route, OPENAI_API_KEY: 'openai-key'})
  assert.equal(integrated.cascade_llm_provider, 'deepseek')
  assert.equal(integrated.cascade_llm_model, null)
  const cascaded = loadSettings({
    MODEL_ROUTES: route,
    PIPELINE_MODE: 'cascaded',
    OPENAI_API_KEY: 'openai-key',
    DOUBAO_BIGMODEL_API_KEY: 'speech-key',
  })
  assert.equal(cascaded.cascade_llm_provider, 'openai')
  assert.equal(cascaded.cascade_llm_model, 'gpt-6-luna')
  assert.equal(cascaded.support_model, 'gpt-6-luna', 'auxiliary defaults follow the routed text provider')
})

test('fast and embedding routes drive memory extraction and embeddings', () => {
  const settings = loadSettings({
    MODEL_ROUTES: dense({
      fast: {provider: 'deepseek', model: 'deepseek-chat'},
      embedding: {provider: 'dashscope', model: 'text-embedding-v4'},
    }),
    DEEPSEEK_API_KEY: 'deepseek-key',
    DASHSCOPE_API_KEY: 'dash-key',
    MEMORY_CONNECTION: 'local',
  })
  assert.deepEqual(resolveMemoryExtractionConnection(settings), {
    baseUrl: DEEPSEEK_BASE_URL, apiKey: 'deepseek-key', model: 'deepseek-chat', missing: null,
  })
  assert.deepEqual(resolveEmbeddingConnection(settings), {
    baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL, apiKey: 'dash-key',
  })
  const memory = requirePersonalMemory(settings)
  assert.ok(memory?.connection === 'local')
  assert.equal(memory.extractionModel, 'deepseek-chat')
  assert.equal(memory.embedding.model, 'text-embedding-v4')
  assert.deepEqual(memoryStatus(settings), {enabled: true, reason: null, fallback: null})
})

test('routed lanes without credentials report the exact missing variable and never use another provider key', () => {
  const settings = loadSettings({
    MODEL_ROUTES: dense({
      support: {provider: 'openai', model: 'gpt-6-luna'},
      fast: {provider: 'qwen', model: 'qwen-flash'},
      watch: {provider: 'stepfun', model: 'step-3.7-flash'},
      embedding: {provider: 'dashscope', model: 'text-embedding-v4'},
    }),
    MEMORY_CONNECTION: 'local',
  })
  assert.equal(resolveModelRoute(settings, 'support')?.missing, 'OPENAI_API_KEY')
  assert.equal(resolveModelRoute(settings, 'fast')?.missing, 'DASHSCOPE_API_KEY')
  assert.equal(resolveModelRoute(settings, 'watch')?.missing, 'STEPFUN_API_KEY')
  assert.equal(resolveModelRoute(settings, 'embedding')?.missing, 'DASHSCOPE_API_KEY')
  assert.equal(missingWatchModelCredential(settings), 'STEPFUN_API_KEY')
  assert.equal(missingKnowledgeCredential(settings), 'DASHSCOPE_API_KEY')
  assert.equal(resolveMemoryExtractionConnection(settings).missing, 'DASHSCOPE_API_KEY')
  assert.deepEqual(memoryStatus(settings), {enabled: false, reason: 'missing_environment:DASHSCOPE_API_KEY', fallback: null})
  assert.equal(requirePersonalMemory(settings), null)
  assert.throws(() => resolveWatchModelConnection(settings), /STEPFUN_API_KEY/u)
})

test('watch routes resolve their own endpoint and reject cleartext remote compatible endpoints', () => {
  const stepfun = loadSettings({
    MODEL_ROUTES: dense({watch: {provider: 'stepfun', model: 'step-3.7-flash'}}),
    STEPFUN_API_KEY: 'stepfun-key',
  })
  assert.deepEqual(resolveWatchModelConnection(stepfun), {
    baseUrl: STEPFUN_COMPATIBLE_BASE_URL, apiKey: 'stepfun-key',
  })
  assert.equal(stepfun.watch_model, 'step-3.7-flash')
  const local = loadSettings({
    MODEL_ROUTES: dense({support: {provider: 'self-hosted', model: 'local-model'}}),
    SELF_HOSTED_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  })
  assert.deepEqual(resolveModelRoute(local, 'support'), {
    provider: 'self-hosted', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '', missing: null,
  })
  const remote = loadSettings({
    MODEL_ROUTES: dense({support: {provider: 'self-hosted', model: 'local-model'}}),
    SELF_HOSTED_LLM_BASE_URL: 'http://example.com/v1',
  })
  assert.throws(() => resolveModelRoute(remote, 'support'), /必须使用 TLS/u)
})

test('model catalog exposes lane ids, provider key names, capabilities and token ceilings', () => {
  assert.deepEqual([...MODEL_LANE_IDS],
    ['conversationText', 'support', 'fast', 'compressor', 'watch', 'embedding'])
  assert.deepEqual(MODEL_CATALOG.lanes, MODEL_LANE_IDS)
  assert.equal(MODEL_CATALOG.providers, MODEL_CATALOG_PROVIDERS)
  assert.equal(MODEL_CATALOG.models, MODEL_CATALOG_MODELS)
  const keyNames = Object.fromEntries(MODEL_CATALOG_PROVIDERS.map(provider => [provider.id, provider.keyName]))
  assert.deepEqual(keyNames, {
    qwen: 'DASHSCOPE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
    ark: 'ARK_API_KEY',
    'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
    'self-hosted': 'SELF_HOSTED_LLM_API_KEY',
    dashscope: 'DASHSCOPE_API_KEY',
  })
  assert.equal(providerSupports('qwen', 'vision'), true)
  assert.equal(providerSupports('openai', 'vision'), false, 'watch routing stays fail-closed like VISION_MODELS')
  assert.equal(providerSupports('gemini', 'vision'), false)
  assert.equal(providerSupports('dashscope', 'embedding'), true)
  assert.equal(providerSupports('self-hosted', 'vision'), false)
  assert.equal(catalogModel('deepseek', 'deepseek-flash')?.defaultMaxOutputTokens, 8192)
  assert.equal(defaultMaxOutputTokens('dashscope', 'text-embedding-v4'), 0)
  assert.equal(defaultMaxOutputTokens('qwen', 'custom-model'), 8192)
  assert.equal(modelCapabilities('deepseek', 'deepseek-flash').includes('vision'), true)
  assert.deepEqual(modelCapabilities('qwen', 'custom-model'), [])
  assert.equal(modelLabel('deepseek', 'deepseek-flash'), 'DeepSeek Flash')
  assert.equal(modelLabel('qwen', 'custom-model'), 'custom-model')
  assert.equal(providerLabel('dashscope'), 'DashScope Embedding')
  // The watch lane never offers a provider without a verified vision adapter.
  for (const provider of ['qwen', 'deepseek', 'stepfun', 'ark', 'openai-compatible'] as const) {
    assert.ok(VISION_MODELS[provider] !== undefined, provider)
  }
})
