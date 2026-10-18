import {validSelfHostedUrl} from './voice-preset.mjs'

export const COMPATIBLE_STAGES = Object.freeze([
  {stage:'llm', provider:'cascadedLlmProvider', endpoint:'openaiCompatibleBaseUrl', secret:'openaiCompatibleApiKey'},
  {stage:'asr', provider:'cascadedAsrProvider', endpoint:'compatibleAsrBaseUrl', secret:'compatibleAsrApiKey', model:'compatibleAsrModel'},
  {stage:'tts', provider:'cascadedTtsProvider', endpoint:'compatibleTtsBaseUrl', secret:'compatibleTtsApiKey', model:'compatibleTtsModel'},
])
export const COMPATIBLE_FIELDS = Object.freeze(['openaiCompatibleBaseUrl','openaiCompatibleProtocol','compatibleAsrBaseUrl','compatibleAsrModel','compatibleTtsBaseUrl','compatibleTtsModel','compatibleTtsVoice','compatibleTtsSendSampleRate'])
export function validCompatibleUrl(value) { return value ? validSelfHostedUrl(value, 'llm') : null }
export function isEndpointSecret(key) { return key.startsWith('selfHosted') || COMPATIBLE_STAGES.some(stage => stage.secret === key) }

// Presets fill documented endpoint parameters; model availability remains account-specific.
// Sources: https://openrouter.ai/docs/quickstart,
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
    {id:'openai', label:'OpenAI', baseUrl:'https://api.openai.com/v1', model:'whisper-1'},
    {id:'siliconflow', label:'SiliconFlow', baseUrl:'https://api.siliconflow.cn/v1', model:'FunAudioLLM/SenseVoiceSmall'},
  ],
  tts: [
    {id:'openai', label:'OpenAI', baseUrl:'https://api.openai.com/v1', model:'tts-1', voice:'alloy', sendSampleRate:false},
    {id:'siliconflow', label:'SiliconFlow', baseUrl:'https://api.siliconflow.cn/v1', model:'FunAudioLLM/CosyVoice2-0.5B', voice:'FunAudioLLM/CosyVoice2-0.5B:alex', sendSampleRate:true},
  ],
})
