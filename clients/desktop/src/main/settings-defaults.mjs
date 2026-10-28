// Pure (no node:fs / node:crypto) so backend.mjs can import it without loading
// settings-store.mjs, and a missing/corrupt settings file never produces the
// literal string "undefined" in a child's environment. settings-store.mjs
// spreads RUNTIME_DEFAULTS into DEFAULT_SETTINGS, so the two cannot diverge.
export const RUNTIME_DEFAULTS = Object.freeze({
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  pipelineMode: 'integrated',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  openaiCompatibleBaseUrl: 'https://api.openai.com/v1',
  openaiCompatibleProtocol: 'chat-completions',
  compatibleAsrBaseUrl: 'https://api.openai.com/v1',
  compatibleAsrModel: 'whisper-1',
  compatibleTtsBaseUrl: 'https://api.openai.com/v1',
  compatibleTtsModel: 'tts-1',
  compatibleTtsVoice: 'alloy',
  compatibleAsrOmitResponseFormat: false,
  compatibleTtsSendSampleRate: false,
  selfHostedAsrUrl: '',
  selfHostedLlmBaseUrl: '',
  selfHostedTtsUrl: '',
  geminiAsrModel: 'gemini-3.5-flash',
  geminiTtsModel: 'gemini-3.8-flash-tts',
  geminiTtsVoice: 'Kore',
  cascadedLlmProvider: 'deepseek',
  cascadedLlmModels: Object.freeze({
    'self-hosted': '',
    'openai-compatible': '',
    qwen: 'qwen-plus',
    ark: 'doubao-seed-2-0-pro-260215',
    deepseek: 'deepseek-flash',
    openai: 'gpt-6-luna',
    gemini: 'gemini-3.5-flash-lite',
  }),
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
  codexApprovalMode: 'ask',
  localToolApproval: 'ask',
  clarificationDepth: 'balanced',
  planReadback: 'summary',
  generatePlan: true,
  buildReasoning: false,
  profileParticipantMessages: false,
  progressBubbles: 'milestones',
  embeddingProvider: 'dashscope',
  embeddingModel: 'text-embedding-v4',
  capabilitiesConfigPath: '',
  knowledgePath: '',
})

// Node refuses a C0 control character in a child's environment value and throws
// out of `spawn`, so a stored secret that somehow carries one must be dropped
// rather than take the launch — and with it the app — down before the panel can
// clear it.
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

// Missing credentials must not silently select a different paid provider.
export function selectedTextLlmProvider(settings, _secretsPresent = {}) {
  return settings?.cascadedLlmProvider ?? RUNTIME_DEFAULTS.cascadedLlmProvider
}
