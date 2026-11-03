import {legacyMemoryComposition} from './factory.js'
import type {MemoryComposition, Settings} from '../config/config.js'
import type {HostSpaceConfig} from '../space-host/config.js'
import type {PersonalMemoryResource} from './personal-memory.js'
import type {PersonalMemoryFactory} from './factory.js'

export interface MemoryToolCapabilities {
  readonly recall: boolean
  readonly evidence: boolean
  readonly sourceFilter: boolean
  readonly lookup: boolean
  readonly remember: boolean
  readonly engine: 'ledger' | 'mem0' | 'voicemem' | 'remote' | 'knowledge' | 'none'
}
export const FULL_MEMORY_TOOLS: MemoryToolCapabilities = Object.freeze({recall: true, evidence: true, sourceFilter: true, lookup: true, remember: true, engine: 'ledger'})
export const NO_MEMORY_TOOLS: MemoryToolCapabilities = Object.freeze({recall: false, evidence: false, sourceFilter: false, lookup: false, remember: false, engine: 'none'})

export function deriveMemoryToolCapabilities(resource: PersonalMemoryResource | undefined, engine: MemoryToolCapabilities['engine'] = 'none'): MemoryToolCapabilities {
  // Session recall remains available even without a personal resource.
  return {recall: true, evidence: !!resource?.readEvidence, sourceFilter: !!resource?.recallSources,
    lookup: !!resource?.lookupExplicit && !!resource.get, remember: !!resource?.beginExplicitTurn && !!resource.writeExplicit, engine}
}

interface MemoryPlanInput {memoryComposition?: MemoryComposition; settings: Settings; createPersonalMemory?: unknown; knowledge: boolean; spaceConfig?: HostSpaceConfig}

/** The same branch predicate owns both static tool planning and resource composition. */
export function useLocalLedger(input: Pick<MemoryPlanInput, 'createPersonalMemory' | 'knowledge' | 'spaceConfig' | 'memoryComposition'>): boolean {
  return (input.spaceConfig !== undefined && input.spaceConfig.data_mode !== 'existing')
    || (input.memoryComposition ?? legacyMemoryComposition(input.createPersonalMemory))?.kind === 'ledger'
    || (input.knowledge && input.createPersonalMemory === undefined && (!input.memoryComposition || input.memoryComposition.kind === 'disabled'))
}

export function planMemoryToolCapabilities(input: MemoryPlanInput): MemoryToolCapabilities {
  if (useLocalLedger(input)) {
    const isolated = input.spaceConfig !== undefined && input.spaceConfig.data_mode !== 'existing'
    const local = (input.memoryComposition ?? legacyMemoryComposition(input.createPersonalMemory))?.kind === 'ledger'
    return isolated || local ? FULL_MEMORY_TOOLS : {...NO_MEMORY_TOOLS, recall: true, evidence: true, engine: 'knowledge'}
  }
  if (input.memoryComposition?.kind === 'remote') return {...NO_MEMORY_TOOLS, recall: true, engine: 'remote'}
  if (input.memoryComposition?.kind === 'standalone-mem0') return {...NO_MEMORY_TOOLS, recall: true, evidence: true, engine: 'mem0'}
  if (input.createPersonalMemory === undefined) return {...NO_MEMORY_TOOLS, recall: true}
  const backend = (input.createPersonalMemory as PersonalMemoryFactory).memoryBackend
  if (input.settings.memory_connection === 'remote' || backend === 'remote') return {...NO_MEMORY_TOOLS, recall: true, engine: 'remote'}
  if (backend === 'mem0') return {...NO_MEMORY_TOOLS, recall: true, evidence: true, engine: 'mem0'}
  // Untagged injected factories retain legacy tools; live resources refine this plan.
  return FULL_MEMORY_TOOLS
}

export function memoryToolsFor(caps: MemoryToolCapabilities, mode: {scheduled: boolean; sourceProcessing: boolean}): MemoryToolCapabilities {
  return mode.scheduled || mode.sourceProcessing ? {...caps, remember: false, lookup: false} : caps
}

/** Shared conversations may compile before the owning graph has created its resource. */
export function resolveMemoryToolCapabilities(resource: PersonalMemoryResource | undefined, planned: MemoryToolCapabilities): MemoryToolCapabilities {
  if (!resource) return planned
  const engine = resource.writeExplicit ? 'ledger' : planned.engine === 'mem0' ? 'mem0' : resource.readEvidence ? 'knowledge' : planned.engine
  return deriveMemoryToolCapabilities(resource, engine)
}
