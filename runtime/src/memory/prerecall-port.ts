import {resolveEmbeddingConnection, type Settings} from '../config/config.js'
import type {PreparedMemoryContext} from '../realtime/cascaded/adapter.js'
import type {UnifiedRetrieval} from './retrieval.js'
import {prerecallContext} from './prerecall.js'

/** Retrieval is bound after the provider is constructed; authorization is rechecked at consume. */
export function retrievalPrerecall(retrieval: () => UnifiedRetrieval | undefined, consumer: () => string):
  (query: string, signal: AbortSignal) => Promise<PreparedMemoryContext | null> {
  return async (query, signal) => {
    const current = retrieval()
    if (!current) return null
    const result = await current.recall(query, {scope: 'any', userOnly:true, limit: 3, signal, consumer: consumer()})
    signal.throwIfAborted()
    return async consumeSignal => {
      const authorityUnchanged = current.recallAuthorityUnchanged(result)
      const style = await current.prepareResponseStyle(result, consumeSignal)
      consumeSignal.throwIfAborted()
      const validated = await current.revalidate(result, consumeSignal)
      consumeSignal.throwIfAborted()
      if (!authorityUnchanged()) return null
      return [prerecallContext(query, validated), style()].filter(Boolean).join('\n') || null
    }
  }
}

/** Configuration class only: all currently supported embedding transports are network-backed. */
export function configuredPrerecallMeta(settings: Settings): {readonly embedding: 'remote' | 'local' | 'none'} {
  return {embedding: settings.memory_connection === 'remote' || resolveEmbeddingConnection(settings).apiKey ? 'remote' : 'none'}
}
