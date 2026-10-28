import { z } from 'zod'

/**
 * Host-private per-lane model routing.
 *
 * The desktop owns model selection; it hands the runtime one JSON document in
 * `MODEL_ROUTES`. Every lane is optional: an absent (or explicitly null) lane keeps the
 * runtime's historical defaults, so an older desktop that does not emit the variable
 * behaves exactly like before this contract existed.
 *
 * A route is only a provider/model pair. Credentials stay in their existing provider
 * environment variables; the runtime reads one only when a route (or a legacy default)
 * references that provider.
 */

/** Pinned compatible endpoints shared by the schema, the environment parser and routes. */
export const DASHSCOPE_COMPATIBLE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const STEPFUN_COMPATIBLE_BASE_URL = 'https://api.stepfun.com/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

export const MODEL_ROUTE_LANE_IDS = [
  'conversationText',
  'support',
  'fast',
  'compressor',
  'watch',
  'embedding',
] as const

export type ModelRouteLane = (typeof MODEL_ROUTE_LANE_IDS)[number]

export const MODEL_ROUTE_PROVIDER_IDS = [
  'qwen',
  'deepseek',
  'openai',
  'gemini',
  'stepfun',
  'ark',
  'openai-compatible',
  'self-hosted',
  'dashscope',
] as const

export type ModelRouteProvider = (typeof MODEL_ROUTE_PROVIDER_IDS)[number]

export interface ModelRoute {
  readonly provider: ModelRouteProvider
  readonly model: string
}

/** Lanes the desktop may route; absent means "keep the historical default". */
export type ModelRoutes = Readonly<Partial<Record<ModelRouteLane, ModelRoute>>>

type ProviderTuple = readonly [ModelRouteProvider, ...ModelRouteProvider[]]

/**
 * Providers a lane accepts.
 *
 * `conversationText` mirrors the cascaded text providers: that lane becomes the text
 * conversation LLM, so StepFun (realtime only) is not a valid target.
 * `watch` only lists providers with a verified vision adapter; like `VISION_MODELS`,
 * unverified providers fail closed instead of silently sending frames nowhere.
 * `embedding` is DashScope-only, matching the embedding provider enum.
 */
const CONVERSATION_TEXT_PROVIDERS: ProviderTuple = ['qwen', 'ark', 'deepseek', 'openai', 'gemini', 'self-hosted', 'openai-compatible']
const TEXT_PROVIDERS: ProviderTuple = ['qwen', 'deepseek', 'openai', 'gemini', 'stepfun', 'ark', 'openai-compatible', 'self-hosted']
const WATCH_PROVIDERS: ProviderTuple = ['qwen', 'deepseek', 'stepfun', 'ark', 'openai-compatible']
const EMBEDDING_PROVIDERS: ProviderTuple = ['dashscope']

export const MODEL_ROUTE_LANE_PROVIDERS: Readonly<Record<ModelRouteLane, ProviderTuple>> = Object.freeze({
  conversationText: CONVERSATION_TEXT_PROVIDERS,
  support: TEXT_PROVIDERS,
  fast: TEXT_PROVIDERS,
  compressor: TEXT_PROVIDERS,
  watch: WATCH_PROVIDERS,
  embedding: EMBEDDING_PROVIDERS,
})

export interface ModelRouteProviderMetadata {
  /** Environment variable that carries this provider's credential. */
  readonly keyName: string
  /** Settings field the environment parser stores that credential in. */
  readonly keyField: 'dashscope_api_key' | 'deepseek_api_key' | 'openai_api_key'
    | 'gemini_api_key' | 'stepfun_api_key' | 'ark_api_key'
    | 'openai_compatible_api_key' | 'self_hosted_llm_api_key'
  /** A keyless local server is allowed to start without a credential. */
  readonly keyOptional: boolean
}

export const MODEL_ROUTE_PROVIDER_METADATA: Readonly<Record<ModelRouteProvider, ModelRouteProviderMetadata>> = Object.freeze({
  qwen: Object.freeze({keyName: 'DASHSCOPE_API_KEY', keyField: 'dashscope_api_key', keyOptional: false}),
  dashscope: Object.freeze({keyName: 'DASHSCOPE_API_KEY', keyField: 'dashscope_api_key', keyOptional: false}),
  deepseek: Object.freeze({keyName: 'DEEPSEEK_API_KEY', keyField: 'deepseek_api_key', keyOptional: false}),
  openai: Object.freeze({keyName: 'OPENAI_API_KEY', keyField: 'openai_api_key', keyOptional: false}),
  gemini: Object.freeze({keyName: 'GEMINI_API_KEY', keyField: 'gemini_api_key', keyOptional: false}),
  stepfun: Object.freeze({keyName: 'STEPFUN_API_KEY', keyField: 'stepfun_api_key', keyOptional: false}),
  ark: Object.freeze({keyName: 'ARK_API_KEY', keyField: 'ark_api_key', keyOptional: false}),
  'openai-compatible': Object.freeze({keyName: 'OPENAI_COMPATIBLE_API_KEY', keyField: 'openai_compatible_api_key', keyOptional: false}),
  'self-hosted': Object.freeze({keyName: 'SELF_HOSTED_LLM_API_KEY', keyField: 'self_hosted_llm_api_key', keyOptional: true}),
})

export class ModelRoutesParseError extends Error {
  constructor() {
    super('invalid_model_routes')
    this.name = 'ModelRoutesParseError'
  }
}

const controlCharacters = /[\u0000-\u001f\u007f]/u

const routeModelSchema = z.string()
  .min(1)
  .max(256)
  .refine(value => value.trim() !== '' && !controlCharacters.test(value), 'invalid model')
  .transform(value => value.trim())

function laneRouteSchema(providers: ProviderTuple) {
  const allowed: readonly string[] = providers
  return z.object({
    provider: z.enum(MODEL_ROUTE_PROVIDER_IDS),
    model: routeModelSchema,
  }).strict().refine(route => allowed.includes(route.provider), 'provider_not_supported_for_lane')
}

/** Strict document schema; the same schema validates `settings.model_routes` directly. */
export const modelRoutesSchema = z.object({
  conversationText: laneRouteSchema(CONVERSATION_TEXT_PROVIDERS).nullish(),
  support: laneRouteSchema(TEXT_PROVIDERS).nullish(),
  fast: laneRouteSchema(TEXT_PROVIDERS).nullish(),
  compressor: laneRouteSchema(TEXT_PROVIDERS).nullish(),
  watch: laneRouteSchema(WATCH_PROVIDERS).nullish(),
  embedding: laneRouteSchema(EMBEDDING_PROVIDERS).nullish(),
}).strict().default({})

export const EMPTY_MODEL_ROUTES: ModelRoutes = Object.freeze({})

function frozenRoutes(routes: Partial<Record<ModelRouteLane, ModelRoute | null | undefined>>): ModelRoutes {
  const result: Partial<Record<ModelRouteLane, ModelRoute>> = {}
  for (const lane of MODEL_ROUTE_LANE_IDS) {
    const route = routes[lane]
    if (route === undefined || route === null) continue
    result[lane] = Object.freeze({provider: route.provider, model: route.model})
  }
  return Object.freeze(result)
}

/**
 * Parse the host-private `MODEL_ROUTES` document.
 *
 * Whitespace-only input means "not routed" and keeps every default. Invalid documents
 * are refused instead of partially applied: a typo must not silently fall back to a
 * different provider than the one the user selected.
 */
export function parseModelRoutes(raw: string | undefined): ModelRoutes {
  const normalized = raw?.trim() ?? ''
  if (normalized === '') return EMPTY_MODEL_ROUTES
  let document: unknown
  try {
    document = JSON.parse(normalized) as unknown
  } catch {
    throw new ModelRoutesParseError()
  }
  const parsed = modelRoutesSchema.safeParse(document)
  if (!parsed.success) throw new ModelRoutesParseError()
  return frozenRoutes(parsed.data)
}

/** Providers referenced by the configured routes; used to gate credential reads. */
export function modelRouteProviders(routes: ModelRoutes): ReadonlySet<ModelRouteProvider> {
  return new Set(Object.values(routes).map(route => route.provider))
}

export function isModelRouteLane(value: string): value is ModelRouteLane {
  return (MODEL_ROUTE_LANE_IDS as readonly string[]).includes(value)
}
