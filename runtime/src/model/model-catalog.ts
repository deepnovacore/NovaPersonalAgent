import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DEEPSEEK_BASE_URL,
  GEMINI_BASE_URL,
  MODEL_ROUTE_LANE_IDS,
  MODEL_ROUTE_PROVIDER_IDS,
  OPENAI_BASE_URL,
  STEPFUN_COMPATIBLE_BASE_URL,
  type ModelRouteLane,
  type ModelRouteProvider,
} from '../config/model-routes.js'

/**
 * Public model catalog shared by the desktop settings UI and the runtime.
 *
 * The catalog is data, not policy: the runtime still accepts a route for any model id
 * in a supported provider, while this list is what the desktop offers and what labels
 * key names for status. `defaultMaxOutputTokens` is the ceiling a caller may use before
 * a provider-specific protocol limit applies.
 */

export type ModelCapability = 'text' | 'vision' | 'embedding'

export interface ModelCatalogProvider {
  readonly id: ModelRouteProvider
  readonly label: string
  /** Environment variable that carries the provider credential. */
  readonly keyName: string
  /** Fixed compatible endpoint; null when the endpoint comes from settings. */
  readonly baseUrl: string | null
  readonly capabilities: readonly ModelCapability[]
}

export interface ModelCatalogModel {
  readonly provider: ModelRouteProvider
  readonly id: string
  readonly label: string
  readonly capabilities: readonly ModelCapability[]
  readonly defaultMaxOutputTokens: number
}

export interface ModelCatalog {
  readonly lanes: readonly ModelRouteLane[]
  readonly providers: readonly ModelCatalogProvider[]
  readonly models: readonly ModelCatalogModel[]
}

const TEXT_AND_VISION: readonly ModelCapability[] = Object.freeze(['text', 'vision'])
const TEXT_ONLY: readonly ModelCapability[] = Object.freeze(['text'])
const EMBEDDING_ONLY: readonly ModelCapability[] = Object.freeze(['embedding'])

export const MODEL_CATALOG_PROVIDERS: readonly ModelCatalogProvider[] = Object.freeze([
  Object.freeze({id: 'qwen', label: 'Qwen (DashScope)', keyName: 'DASHSCOPE_API_KEY', baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL, capabilities: TEXT_AND_VISION}),
  Object.freeze({id: 'deepseek', label: 'DeepSeek', keyName: 'DEEPSEEK_API_KEY', baseUrl: DEEPSEEK_BASE_URL, capabilities: TEXT_AND_VISION}),
  Object.freeze({id: 'openai', label: 'OpenAI', keyName: 'OPENAI_API_KEY', baseUrl: OPENAI_BASE_URL, capabilities: TEXT_ONLY}),
  Object.freeze({id: 'gemini', label: 'Gemini', keyName: 'GEMINI_API_KEY', baseUrl: GEMINI_BASE_URL, capabilities: TEXT_ONLY}),
  Object.freeze({id: 'stepfun', label: 'StepFun', keyName: 'STEPFUN_API_KEY', baseUrl: STEPFUN_COMPATIBLE_BASE_URL, capabilities: TEXT_AND_VISION}),
  Object.freeze({id: 'ark', label: 'Volcengine Ark', keyName: 'ARK_API_KEY', baseUrl: null, capabilities: TEXT_AND_VISION}),
  Object.freeze({id: 'openai-compatible', label: 'OpenAI-compatible', keyName: 'OPENAI_COMPATIBLE_API_KEY', baseUrl: null, capabilities: TEXT_AND_VISION}),
  Object.freeze({id: 'self-hosted', label: 'Self-hosted', keyName: 'SELF_HOSTED_LLM_API_KEY', baseUrl: null, capabilities: TEXT_ONLY}),
  Object.freeze({id: 'dashscope', label: 'DashScope Embedding', keyName: 'DASHSCOPE_API_KEY', baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL, capabilities: EMBEDDING_ONLY}),
])

function textModel(provider: ModelRouteProvider, id: string, label: string, capabilities: readonly ModelCapability[], defaultMaxOutputTokens = 8192): ModelCatalogModel {
  return Object.freeze({provider, id, label, capabilities, defaultMaxOutputTokens})
}

export const MODEL_CATALOG_MODELS: readonly ModelCatalogModel[] = Object.freeze([
  textModel('qwen', 'qwen-plus', 'Qwen Plus', TEXT_ONLY),
  textModel('qwen', 'qwen-flash', 'Qwen Flash', TEXT_ONLY),
  textModel('qwen', 'qwen-turbo', 'Qwen Turbo', TEXT_ONLY),
  textModel('qwen', 'qwen3-vl-plus', 'Qwen3-VL Plus', TEXT_AND_VISION),
  textModel('qwen', 'qwen3-vl-flash', 'Qwen3-VL Flash', TEXT_AND_VISION),
  textModel('qwen', 'qwen-vl-max', 'Qwen-VL Max', TEXT_AND_VISION),
  textModel('qwen', 'qwen-vl-plus', 'Qwen-VL Plus', TEXT_AND_VISION),
  textModel('deepseek', 'deepseek-flash', 'DeepSeek Flash', TEXT_AND_VISION),
  textModel('deepseek', 'deepseek-chat', 'DeepSeek Chat', TEXT_ONLY),
  textModel('openai', 'gpt-6-luna', 'GPT-6 Luna', TEXT_ONLY, 16384),
  textModel('openai', 'gpt-6-sol', 'GPT-6 Sol', TEXT_ONLY, 16384),
  textModel('gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', TEXT_ONLY),
  textModel('stepfun', 'step-3.7-flash', 'Step 3.7 Flash', TEXT_AND_VISION),
  textModel('ark', 'doubao-seed-2-0-pro-260215', 'Doubao Seed 2.0 Pro', TEXT_AND_VISION, 16384),
  textModel('openai-compatible', 'gpt-6-sol', 'GPT-6 Sol', TEXT_AND_VISION, 16384),
  textModel('dashscope', 'text-embedding-v4', 'Text Embedding v4', EMBEDDING_ONLY, 0),
])

export const MODEL_CATALOG: ModelCatalog = Object.freeze({
  lanes: MODEL_ROUTE_LANE_IDS,
  providers: MODEL_CATALOG_PROVIDERS,
  models: MODEL_CATALOG_MODELS,
})

/** Short aliases so either the aggregate or its two halves can be consumed. */
export const MODEL_LANE_IDS = MODEL_ROUTE_LANE_IDS
export const MODEL_PROVIDERS = MODEL_CATALOG_PROVIDERS
export const MODEL_MODELS = MODEL_CATALOG_MODELS

const providerById = new Map<ModelRouteProvider, ModelCatalogProvider>(
  MODEL_CATALOG_PROVIDERS.map(provider => [provider.id, provider]),
)
const modelKey = (provider: ModelRouteProvider, model: string): string => `${provider}\u0000${model}`
const modelByKey = new Map<string, ModelCatalogModel>(
  MODEL_CATALOG_MODELS.map(entry => [modelKey(entry.provider, entry.id), entry]),
)

export function catalogProvider(id: ModelRouteProvider): ModelCatalogProvider | undefined {
  return providerById.get(id)
}

export function providerLabel(id: ModelRouteProvider): string {
  return providerById.get(id)?.label ?? id
}

export function catalogModel(provider: ModelRouteProvider, model: string): ModelCatalogModel | undefined {
  return modelByKey.get(modelKey(provider, model))
}

/** Labels never invent capabilities; an unknown custom model keeps its id as the label. */
export function modelLabel(provider: ModelRouteProvider, model: string): string {
  return catalogModel(provider, model)?.label ?? model
}

/** Catalog capabilities fail closed: a custom model id advertises none until verified. */
export function modelCapabilities(provider: ModelRouteProvider, model: string): readonly ModelCapability[] {
  return catalogModel(provider, model)?.capabilities ?? Object.freeze([])
}

/** Fallback ceiling for a custom model id: text providers get the shared default, embeddings none. */
export function defaultMaxOutputTokens(provider: ModelRouteProvider, model: string): number {
  const entry = catalogModel(provider, model)
  if (entry !== undefined) return entry.defaultMaxOutputTokens
  return provider === 'dashscope' ? 0 : 8192
}

/** True when the provider can route this capability for this lane. */
export function providerSupports(provider: ModelRouteProvider, capability: ModelCapability): boolean {
  return providerById.get(provider)?.capabilities.includes(capability) === true
}

export function isModelRouteProvider(value: string): value is ModelRouteProvider {
  return (MODEL_ROUTE_PROVIDER_IDS as readonly string[]).includes(value)
}
