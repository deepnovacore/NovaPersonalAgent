/**
 * The one table of which cloud credential each selected voice provider cannot start without.
 * Dependency-free on purpose: `runtime/scripts/check-capabilities.mjs` copies it into the CLI so
 * `npa doctor` demands exactly what the runtime's blocking check demands.
 */
export const INTEGRATED_PROVIDERS = Object.freeze(['qwen', 'stepfun', 'openai', 'gemini', 'minicpm-o', 'personaplex'] as const)
export const CASCADED_ASR_PROVIDERS = Object.freeze(['volcengine', 'gemini', 'self-hosted', 'openai-compatible'] as const)
export const CASCADED_LLM_PROVIDERS = Object.freeze(['qwen', 'ark', 'deepseek', 'openai', 'gemini', 'self-hosted', 'openai-compatible'] as const)
export const CASCADED_TTS_PROVIDERS = Object.freeze(['volcengine', 'gemini', 'self-hosted', 'openai-compatible'] as const)

export type VoicePipeline = 'integrated' | 'cascaded'
export type IntegratedVoiceProvider = typeof INTEGRATED_PROVIDERS[number]
export type CascadedAsrVoiceProvider = typeof CASCADED_ASR_PROVIDERS[number]
export type CascadedLlmVoiceProvider = typeof CASCADED_LLM_PROVIDERS[number]
export type CascadedTtsVoiceProvider = typeof CASCADED_TTS_PROVIDERS[number]

/** `null` means the provider runs without any cloud credential (local or self-hosted endpoints). */
export const INTEGRATED_CREDENTIALS: Readonly<Record<IntegratedVoiceProvider, string | null>> = Object.freeze({
  qwen: 'DASHSCOPE_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'minicpm-o': null,
  personaplex: null,
})
export const CASCADED_LLM_CREDENTIALS: Readonly<Record<CascadedLlmVoiceProvider, string | null>> = Object.freeze({
  qwen: 'DASHSCOPE_API_KEY',
  ark: 'ARK_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'self-hosted': null,
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
})
export const CASCADED_ASR_CREDENTIALS: Readonly<Record<CascadedAsrVoiceProvider, string | null>> = Object.freeze({
  volcengine: 'DOUBAO_BIGMODEL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'self-hosted': null,
  'openai-compatible': 'COMPATIBLE_ASR_API_KEY',
})
export const CASCADED_TTS_CREDENTIALS: Readonly<Record<CascadedTtsVoiceProvider, string | null>> = Object.freeze({
  volcengine: 'DOUBAO_BIGMODEL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'self-hosted': null,
  'openai-compatible': 'COMPATIBLE_TTS_API_KEY',
})

export interface VoiceProviderSelection {
  readonly pipeline: VoicePipeline
  readonly integratedProvider: IntegratedVoiceProvider
  readonly asrProvider: CascadedAsrVoiceProvider
  readonly llmProvider: CascadedLlmVoiceProvider
  readonly ttsProvider: CascadedTtsVoiceProvider
}

/**
 * Credential names the selection needs, in report order and without duplicates. Text-only
 * conversations use the cascaded LLM alone, so ASR and TTS never block them.
 */
export function requiredVoiceCredentials(
  selection: VoiceProviderSelection,
  textConversations = false,
): {readonly pipeline: VoicePipeline; readonly credentials: readonly string[]} {
  if (!textConversations && selection.pipeline === 'integrated') {
    const credential = INTEGRATED_CREDENTIALS[selection.integratedProvider]
    return {pipeline: 'integrated', credentials: credential === null ? [] : [credential]}
  }
  const names = [
    CASCADED_LLM_CREDENTIALS[selection.llmProvider],
    ...(textConversations ? [] : [CASCADED_ASR_CREDENTIALS[selection.asrProvider], CASCADED_TTS_CREDENTIALS[selection.ttsProvider]]),
  ].filter((name): name is string => name !== null)
  return {pipeline: 'cascaded', credentials: [...new Set(names)]}
}
