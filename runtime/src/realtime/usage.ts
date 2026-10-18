import {safeUsageContext, type UsageContext} from '../usage/context.js'
/** Out-of-band metering; reporting must never interrupt a voice response. */
export type UsageService = 'realtime' | 'llm' | 'asr' | 'tts' | 'embedding' | 'agent'
export interface UsageReport extends UsageContext {
  readonly id: string
  readonly service: UsageService
  readonly provider: 'qwen' | 'stepfun' | 'ark' | 'deepseek' | 'volcengine' | 'openai' | 'gemini' | 'openrouter' | 'custom' | 'codex' | 'acp'
  readonly model: string
  readonly status: 'complete' | 'missing'
  readonly pricingRegion?: 'cn-beijing' | 'singapore' | 'unknown'
  readonly outputModality?: 'audio' | 'text'
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly inputTextTokens?: number
  readonly inputAudioTokens?: number
  readonly outputTextTokens?: number
  readonly outputAudioTokens?: number
  readonly cachedTokens?: number
  readonly reasoningTokens?: number
  readonly audioDurationMs?: number
  readonly timestamp?: string
  readonly durationMs?: number
  readonly outcome?: 'success' | 'error' | 'cancelled'
  readonly providerRequestId?: string
  readonly reportedCostUsd?: number
  readonly reasoningMode?: 'enabled' | 'disabled'
  readonly characters?: number
}
export type UsageReporter = (report: UsageReport) => void
const meters = ['inputTokens', 'outputTokens', 'inputTextTokens', 'inputAudioTokens',
  'outputTextTokens', 'outputAudioTokens', 'cachedTokens', 'reasoningTokens',
  'audioDurationMs', 'characters', 'durationMs'] as const

export function normalizeUsageReport(value: unknown): UsageReport | null {
  if (!value || typeof value !== 'object') return null
  const report = value as UsageReport
  if (!['qwen', 'stepfun', 'ark', 'deepseek', 'volcengine', 'openai', 'gemini', 'openrouter', 'custom', 'codex', 'acp'].includes(report.provider)
    || !['llm', 'realtime', 'asr', 'tts', 'embedding', 'agent'].includes(report.service)
    || typeof report.id !== 'string' || !report.id || report.id.length > 256
    || typeof report.model !== 'string' || !report.model || report.model.length > 256 || !['complete','missing'].includes(report.status)) return null
  const counts: Partial<Record<typeof meters[number], number>> = {}
  let complete = report.status === 'complete'
  for (const key of meters) {
    const value = report[key]
    if (value === undefined || value === null) continue
    if (!Number.isSafeInteger(value) || value < 0) complete = false
    else counts[key] = value
  }
  const required = report.service === 'embedding' ? ['inputTokens'] as const : report.service === 'asr' ? ['audioDurationMs'] as const
    : report.service === 'tts' ? ['characters'] as const : ['inputTokens', 'outputTokens'] as const
  if (required.some(key => counts[key] === undefined)) complete = false
  return Object.freeze({id:report.id,service:report.service,provider:report.provider,model:report.model,
    status:complete?'complete':'missing',...counts,...safeUsageContext(report),
    ...(['cn-beijing','singapore','unknown'].includes(report.pricingRegion!)?{pricingRegion:report.pricingRegion!}:{}),
    ...(['audio','text'].includes(report.outputModality!)?{outputModality:report.outputModality!}:{}),
    ...(typeof report.timestamp==='string'&&Number.isFinite(Date.parse(report.timestamp))?{timestamp:new Date(report.timestamp).toISOString()}:{}),
    ...(['success','error','cancelled'].includes(report.outcome!)?{outcome:report.outcome!}:{}),
    ...(typeof report.providerRequestId==='string'&&/^[\w.:/-]{1,256}$/u.test(report.providerRequestId)?{providerRequestId:report.providerRequestId}:{}),
    ...(['enabled','disabled'].includes(report.reasoningMode!)?{reasoningMode:report.reasoningMode!}:{}),
    ...(report.provider==='openrouter'&&typeof report.reportedCostUsd==='number'&&Number.isFinite(report.reportedCostUsd)&&report.reportedCostUsd>=0?{reportedCostUsd:report.reportedCostUsd}:{}),
  })
}
export function reportUsage(reporter:UsageReporter|undefined,report:UsageReport):void {
 if(!reporter)return
 const value=normalizeUsageReport(report)
 if(value)try{reporter(value)}catch{/* Observability never changes generation or cancellation. */}
}
export function bindUsageReporter(reporter:UsageReporter|undefined,context:UsageContext):UsageReporter|undefined {
 return reporter?report=>reportUsage(reporter,{...context,...report,feature:report.feature&&report.feature!=='other'?report.feature:context.feature??'other'}):undefined
}

/** Pricing is tied to the selected host endpoint, never inferred from a model name alone. */
export function usageReporterForEndpoint(reporter: UsageReporter | undefined, endpoint: string): UsageReporter | undefined {
  if (reporter === undefined) return undefined
  let pricingRegion: UsageReport['pricingRegion'] = 'unknown'
  try {
    const url = new URL(endpoint)
    if (url.username === '' && url.password === '' && (!url.port || url.port === '443')
      && ['https:', 'wss:'].includes(url.protocol)) {
      if (['dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com', 'openspeech.bytedance.com'].includes(url.hostname)
        || /^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(url.hostname)) pricingRegion = 'cn-beijing'
      else if (url.hostname === 'dashscope-intl.aliyuncs.com') pricingRegion = 'singapore'
    }
  } catch { /* Custom/invalid endpoints have no known public price. */ }
  return report => reportUsage(reporter, {...report, pricingRegion})
}
