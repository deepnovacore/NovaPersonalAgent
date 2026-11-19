import {createHash as embeddingHash} from 'node:crypto'
import {requireIntegratedRealtime, resolveSelectedModelConnection, resolveModelRoute, type Settings} from '../config/config.js'
import {requireSelectedCascadedLlmConfig} from '../config/cascaded-realtime-config.js'

export function configuredMemoryConsumer(settings: Settings, mode: 'text'|'voice'): string|undefined {
  return configuredMemoryRecipient(settings,mode)?.consumer
}
export function configuredMemoryRecipient(settings: Settings, mode:'text'|'voice'):{consumer:string;provider:string}|undefined {
  try {
    const selected = mode === 'text' || settings.pipeline_mode === 'cascaded' ? requireSelectedCascadedLlmConfig(settings) : undefined
    const voice = selected === undefined ? requireIntegratedRealtime(settings) : undefined
    const endpoint=selected?.config.baseUrl ?? voice!.url,model=selected?.config.model ?? voice!.model
    return {consumer:embeddingHash('sha256').update(JSON.stringify({provider:selected?.provider ?? settings.integrated_provider,endpoint,model})).digest('hex'),provider:endpoint+'|'+model}
  } catch { return undefined }
}
export function configuredTaskVerifierConsumer(settings:Settings):string|undefined {
  return configuredDiscoveryConsumer(settings)
}

export function configuredDiscoveryConsumer(settings:Settings):string|undefined {
  const route=resolveModelRoute(settings,'support'),connection=route??resolveSelectedModelConnection(settings)
  if (!connection) return undefined
  return embeddingHash('sha256').update(JSON.stringify({provider:connection.provider,endpoint:connection.baseUrl,model:route?.model??settings.support_model})).digest('hex')
}

export function configuredMemoryConsumers(settings:Settings):string[] {
  const discovery=configuredDiscoveryConsumer(settings)
  return [...new Set([...(['text','voice'] as const).map(mode=>configuredMemoryConsumer(settings,mode)).filter((value):value is string=>value!==undefined),...(discovery?[discovery]:[])])]
}
