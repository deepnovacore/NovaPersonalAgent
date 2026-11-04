import {z} from 'zod'
import {configuredMemoryConsumers} from './consumer.js'
import {createMem0PersonalMemory} from '../mem0/resource.js'
import {resolveMemoryComposition, type LocalPersonalMemoryConfig, type MemoryComposition, type Settings} from '../config/config.js'
import {RemotePersonalMemoryResource} from './remote-personal-memory.js'
import type {PersonalMemoryResource} from './personal-memory.js'

export type PersonalMemoryFactory = (() => PersonalMemoryResource) & {
  readonly memoryBackend?: 'mem0' | 'remote'
}

let warnedLegacyProvider = false
export function personalMemoryFactory(settings: Settings): {factory?: PersonalMemoryFactory; composition: MemoryComposition} {
  const composition = resolveMemoryComposition(settings)
  if (settings.memory_provider !== null && !warnedLegacyProvider) {
    warnedLegacyProvider = true
    process.emitWarning('MEMORY_PROVIDER is deprecated; use MEMORY_RECALL_ENGINE and MEMORY_EXTRACTORS for ledger composition', {code: 'MEMORY_PROVIDER_DEPRECATED'})
  }
  const factory = factoryForMemoryComposition(composition, settings)
  return {composition, ...(factory ? {factory} : {})}
}

export function factoryForMemoryComposition(composition: MemoryComposition, settings: Settings): PersonalMemoryFactory | undefined {
  if (composition.kind === 'remote') return Object.assign(() => new RemotePersonalMemoryResource(composition.config), {memoryBackend: 'remote' as const})
  if (composition.kind === 'standalone-mem0') return Object.assign(() => createMem0PersonalMemory({...composition.config, conversationProviders: configuredMemoryConsumers(settings)}), {memoryBackend: 'mem0' as const})
  return undefined
}

const legacyLocalConfigSchema = z.object({
  connection: z.literal('local'), provider: z.enum(['voicemem', 'mem0']),
  path: z.string().min(1), userId: z.string().min(1), extractionModel: z.string().min(1),
  extraction: z.object({baseUrl: z.string().min(1), apiKey: z.string()}),
  embedding: z.object({baseUrl: z.string().min(1), apiKey: z.string(), model: z.string().min(1)}),
})

/** One-release compatibility for injected factories carrying the former VoiceMem tag. */
export function legacyMemoryComposition(factory: unknown): MemoryComposition | undefined {
  const parsed = legacyLocalConfigSchema.safeParse((factory as {localMemoryConfig?: unknown} | undefined)?.localMemoryConfig)
  const local: LocalPersonalMemoryConfig | undefined = parsed.success ? parsed.data : undefined
  return local ? {kind: 'ledger', engine: 'ledger', extractors: ['ledger'], local, migrateLegacy: {path: local.path, userId: local.userId}} : undefined
}
