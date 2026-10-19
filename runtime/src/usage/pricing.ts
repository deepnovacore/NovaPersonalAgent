import type {UsageReport} from '../realtime/usage.js'
export const PRICE_DATE='2026-10-18'
export interface UsagePrice {costCny:number|null;costUsd?:number;source:string|null}
// Per-request tiers; no FX conversion. Existing voice/Flash rates checked 2026-09-08.
export function priceUsage(input:UsageReport): UsagePrice {
  const report=input as UsageReport & Required<Pick<UsageReport,'inputTokens'|'outputTokens'|'cachedTokens'|'inputTextTokens'|'inputAudioTokens'|'outputTextTokens'|'outputAudioTokens'|'audioDurationMs'|'characters'>>
  const unknown = {costCny:null, source:null}
  if(report.provider==='openrouter'&&typeof report.reportedCostUsd==='number'&&Number.isFinite(report.reportedCostUsd)&&report.reportedCostUsd>=0)return {costCny:null,costUsd:report.reportedCostUsd,source:'https://openrouter.ai/docs/cookbook/administration/usage-accounting'}
  const {provider, service, model, pricingRegion:region} = report
  if (report.status !== 'complete' || !['cn-beijing', 'singapore'].includes(region??'unknown')) return unknown
  const known = (fields:readonly (keyof UsageReport)[]) => fields.every(field => Number.isSafeInteger(report[field]) && (report[field] as number) >= 0)
  if (provider === 'volcengine' && region === 'cn-beijing') {
    const source = 'https://docs.volcengine.com/docs/6561/1359370'
    if (service === 'asr' && model === 'volc.seedasr.sauc.duration' && known(['audioDurationMs'])) return {costCny:report.audioDurationMs/3600000, source}
    if (service === 'tts' && model === 'seed-tts-2.0' && known(['characters'])) return {costCny:report.characters*3/10000, source}
  }
  if (provider === 'ark' && service === 'llm' && region === 'cn-beijing' && model === 'doubao-seed-2-0-pro-260215') {
    if (!known(['inputTokens','outputTokens']) || report.inputTokens > 256000 || (report.cachedTokens ?? 0) > report.inputTokens) return unknown
    const tier = report.inputTokens <= 32000 ? [3.2,16,.64] : report.inputTokens <= 128000 ? [4.8,24,.96] : [9.6,48,1.92]
    const cached = report.cachedTokens ?? 0
    return {costCny:((report.inputTokens-cached)*tier[0]!+report.outputTokens*tier[1]!+cached*tier[2]!)/1e6, source:'https://docs.volcengine.com/docs/82379/1544106'}
  }
  if (provider === 'qwen' && service === 'llm' && ['qwen-flash', 'qwen-flash-2025-07-28'].includes(model)) {
    if (!known(['inputTokens', 'outputTokens']) || report.inputTokens > 1e6 || (report.cachedTokens ?? 0) > report.inputTokens) return unknown
    const tier = region === 'singapore'
      ? (report.inputTokens <= 256000 ? [.367,2.936,.073] : [1.835,14.678,.367])
      : report.inputTokens <= 128000 ? [.15,1.5,.03] : report.inputTokens <= 256000 ? [.6,6,.12] : [1.2,12,.24]
    const cached = report.cachedTokens ?? 0
    return {costCny:((report.inputTokens-cached)*tier[0]!+report.outputTokens*tier[1]!+cached*tier[2]!)/1e6,
      source:'https://help.aliyun.com/zh/model-studio/qwen-flash'}
  }
  if(provider==='qwen'&&service==='embedding'&&model==='text-embedding-v4'&&known(['inputTokens']))return {costCny:report.inputTokens*(region==='singapore'?.514:.5)/1e6,source:'https://help.aliyun.com/zh/model-studio/text-embedding-v4'}
  if(provider==='qwen'&&service==='llm'&&model==='qwen-plus'){
    if(!known(['inputTokens','outputTokens'])||report.inputTokens>1e6||(report.cachedTokens??0)>report.inputTokens||!report.reasoningMode)return unknown
    const thinking=report.reasoningMode==='enabled'
    const tier=region==='singapore'?(report.inputTokens<=256000?[2.936,thinking?29.357:8.807,.587]:[8.807,thinking?88.071:26.421,1.761])
      :report.inputTokens<=128000?[.8,thinking?8:2,.16]:report.inputTokens<=256000?[2.4,thinking?24:20,.48]:[4.8,thinking?64:48,.96]
    const cached=report.cachedTokens??0
    return {costCny:((report.inputTokens-cached)*tier[0]!+report.outputTokens*tier[1]!+cached*tier[2]!)/1e6,source:'https://help.aliyun.com/zh/model-studio/qwen-plus'}
  }
  if (provider === 'qwen' && service === 'llm' && model === 'qwen3-vl-plus') {
    if (!known(['inputTokens','outputTokens']) || report.inputTokens > 256000 || (report.cachedTokens ?? 0) > report.inputTokens) return unknown
    const tier = region === 'singapore'
      ? report.inputTokens <= 32000 ? [1.468,11.743,.294] : report.inputTokens <= 128000 ? [2.202,17.614,.44] : [4.404,35.228,.881]
      : report.inputTokens <= 32000 ? [1,10,.2] : report.inputTokens <= 128000 ? [1.5,15,.3] : [3,30,.6]
    const cached=report.cachedTokens??0
    return {costCny:((report.inputTokens-cached)*tier[0]!+report.outputTokens*tier[1]!+cached*tier[2]!)/1e6,source:'https://help.aliyun.com/zh/model-studio/qwen3-vl-plus'}
  }
  if (provider === 'qwen' && service === 'realtime' && ['qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash'].includes(model)) {
    // These models publish no cache rate and list context caching as unsupported. Never invent a discount.
    if (!known(['inputTextTokens','inputAudioTokens','outputTextTokens','outputAudioTokens']) || (report.cachedTokens ?? 0) > 0) return unknown
    const plus = model.endsWith('plus')
    const rates = region === 'singapore' ? (plus ? [5.995,47.963,47.963,179.861] : [3.372,33.724,33.724,112.413]) : (plus ? [5,40,40,150] : [3,30,30,100])
    const audio = report.outputModality === 'audio' || report.outputAudioTokens > 0
    return {costCny:(report.inputTextTokens*rates[0]!+report.inputAudioTokens*rates[1]!+(audio ? report.outputAudioTokens*rates[3]! : report.outputTextTokens*rates[2]!))/1e6,
      source:`https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-${plus ? 'plus' : 'flash'}`}
  }
  return unknown
}
