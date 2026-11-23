// Generated from runtime/src/config/voice-credentials.ts; run node runtime/scripts/check-capabilities.mjs --write.
/**
 * The one table of which cloud credential each selected voice provider cannot start without.
 * Dependency-free on purpose: `runtime/scripts/check-capabilities.mjs` copies it into the CLI so
 * `npa doctor` demands exactly what the runtime's blocking check demands.
 */
export const INTEGRATED_PROVIDERS = Object.freeze(['qwen', 'stepfun', 'openai', 'gemini', 'minicpm-o', 'personaplex']);
export const CASCADED_ASR_PROVIDERS = Object.freeze(['volcengine', 'gemini', 'self-hosted', 'openai-compatible']);
export const CASCADED_LLM_PROVIDERS = Object.freeze(['qwen', 'ark', 'deepseek', 'openai', 'gemini', 'self-hosted', 'openai-compatible']);
export const CASCADED_TTS_PROVIDERS = Object.freeze(['volcengine', 'gemini', 'self-hosted', 'openai-compatible']);
/** `null` means the provider runs without any cloud credential (local or self-hosted endpoints). */
export const INTEGRATED_CREDENTIALS = Object.freeze({
    qwen: 'DASHSCOPE_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    'minicpm-o': null,
    personaplex: null,
});
export const CASCADED_LLM_CREDENTIALS = Object.freeze({
    qwen: 'DASHSCOPE_API_KEY',
    ark: 'ARK_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    'self-hosted': null,
    'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
});
export const CASCADED_ASR_CREDENTIALS = Object.freeze({
    volcengine: 'DOUBAO_BIGMODEL_API_KEY',
    gemini: 'GEMINI_API_KEY',
    'self-hosted': null,
    'openai-compatible': 'COMPATIBLE_ASR_API_KEY',
});
export const CASCADED_TTS_CREDENTIALS = Object.freeze({
    volcengine: 'DOUBAO_BIGMODEL_API_KEY',
    gemini: 'GEMINI_API_KEY',
    'self-hosted': null,
    'openai-compatible': 'COMPATIBLE_TTS_API_KEY',
});
/**
 * Credential names the selection needs, in report order and without duplicates. Text-only
 * conversations use the cascaded LLM alone, so ASR and TTS never block them.
 */
export function requiredVoiceCredentials(selection, textConversations = false) {
    if (!textConversations && selection.pipeline === 'integrated') {
        const credential = INTEGRATED_CREDENTIALS[selection.integratedProvider];
        return { pipeline: 'integrated', credentials: credential === null ? [] : [credential] };
    }
    const names = [
        CASCADED_LLM_CREDENTIALS[selection.llmProvider],
        ...(textConversations ? [] : [CASCADED_ASR_CREDENTIALS[selection.asrProvider], CASCADED_TTS_CREDENTIALS[selection.ttsProvider]]),
    ].filter((name) => name !== null);
    return { pipeline: 'cascaded', credentials: [...new Set(names)] };
}
