import {validSelfHostedUrl} from './voice-preset.mjs'

export const COMPATIBLE_STAGES = Object.freeze([
  {stage:'llm', provider:'cascadedLlmProvider', endpoint:'openaiCompatibleBaseUrl', secret:'openaiCompatibleApiKey'},
  {stage:'asr', provider:'cascadedAsrProvider', endpoint:'compatibleAsrBaseUrl', secret:'compatibleAsrApiKey', model:'compatibleAsrModel'},
  {stage:'tts', provider:'cascadedTtsProvider', endpoint:'compatibleTtsBaseUrl', secret:'compatibleTtsApiKey', model:'compatibleTtsModel'},
])
export const COMPATIBLE_FIELDS = Object.freeze(['openaiCompatibleBaseUrl','openaiCompatibleProtocol','compatibleAsrBaseUrl','compatibleAsrModel','compatibleAsrOmitResponseFormat','compatibleTtsBaseUrl','compatibleTtsModel','compatibleTtsVoice','compatibleTtsSendSampleRate'])
export function validCompatibleUrl(value) { return value ? validSelfHostedUrl(value, 'llm') : null }
export function isEndpointSecret(key) { return key.startsWith('selfHosted') || COMPATIBLE_STAGES.some(stage => stage.secret === key) }

// Presets fill documented endpoint parameters; model availability remains account-specific.
// Sources: https://console.groq.com/docs/speech-to-text,
// https://openrouter.ai/docs/guides/overview/multimodal/stt,
// https://openrouter.ai/docs/guides/overview/multimodal/tts,
// https://docs.bigmodel.cn/api-reference/模型-api/文本转语音,
// https://openrouter.ai/docs/quickstart,
// https://platform.moonshot.ai/docs/guide/migrating-from-openai-to-kimi,
// https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech,
// https://github.com/siliconflow-inc/siliconflow-api/blob/main/openapi.yaml
export const COMPATIBLE_PRESETS = Object.freeze({
  llm: [
    {id:'openai', label:'OpenAI', baseUrl:'https://api.openai.com/v1', protocol:'chat-completions'},
    {id:'openrouter', label:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', protocol:'chat-completions'},
    {id:'siliconflow', label:'SiliconFlow', baseUrl:'https://api.siliconflow.cn/v1', protocol:'chat-completions'},
    {id:'moonshot', label:'Moonshot', baseUrl:'https://api.moonshot.ai/v1', protocol:'chat-completions'},
  ],
  asr: [
    {id:'stepfun', label:'StepFun', baseUrl:'https://api.stepfun.com/v1', model:'stepaudio-2.5-asr'},
    {id:'together', label:'Together AI', baseUrl:'https://api.together.ai/v1', model:'openai/whisper-large-v3'},
    {id:'mistral', label:'Mistral', baseUrl:'https://api.mistral.ai/v1', model:'voxtral-mini-latest', omitResponseFormat:true},
    {id:'zhipu', label:'Zhipu / GLM-ASR (≤30s)', baseUrl:'https://open.bigmodel.cn/api/paas/v4', model:'glm-asr-2512', omitResponseFormat:true},
    {id:'groq', label:'Groq', baseUrl:'https://api.groq.com/openai/v1', model:'whisper-large-v3-turbo'},
    {id:'openrouter', label:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', model:'openai/whisper-large-v3'},
    {id:'openai', label:'OpenAI', baseUrl:'https://api.openai.com/v1', model:'whisper-1'},
    {id:'siliconflow', label:'SiliconFlow', baseUrl:'https://api.siliconflow.cn/v1', model:'FunAudioLLM/SenseVoiceSmall'},
  ],
  tts: [
    {id:'stepfun', label:'StepFun', baseUrl:'https://api.stepfun.com/v1', model:'stepaudio-3-tts', voice:'cixingnansheng', sendSampleRate:false},
    {id:'together', label:'Together AI / Orpheus', baseUrl:'https://api.together.ai/v1', model:'canopylabs/orpheus-3b-0.1-ft', voice:'tara', sendSampleRate:false},
    {id:'together-kokoro', label:'Together AI / Kokoro', baseUrl:'https://api.together.ai/v1', model:'hexgrad/Kokoro-82M', voice:'af_alloy', sendSampleRate:false},
    {id:'openrouter', label:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', model:'openai/gpt-4o-mini-tts-2025-12-15', voice:'alloy', sendSampleRate:false},
    {id:'zhipu', label:'Zhipu / GLM-TTS', baseUrl:'https://open.bigmodel.cn/api/paas/v4', model:'glm-tts', voice:'tongtong', sendSampleRate:false},
    {id:'openai', label:'OpenAI', baseUrl:'https://api.openai.com/v1', model:'tts-1', voice:'alloy', sendSampleRate:false},
    {id:'siliconflow', label:'SiliconFlow', baseUrl:'https://api.siliconflow.cn/v1', model:'FunAudioLLM/CosyVoice2-0.5B', voice:'FunAudioLLM/CosyVoice2-0.5B:alex', sendSampleRate:true},
  ],
})
