import type { ExecutorAdmission } from '../causal-runtime.js'
import type { Clock } from '../clock.js'
import type { CodingProgressNarrationState } from '../coding-progress-narration.js'
import { type EventRecord,type JsonValue } from '../events.js'
import {
type MemoryItem
} from '../memory.js'
import type { ExecutorRole } from '../ports.js'
import {
type HostItemOwner
} from './service-state.js'

export interface DelegateLike {
  readonly delegate_id: string
  readonly executor: string
  readonly op: string
  readonly origin_ref: string
  readonly routing_class: string
}

export interface ExecutorManifestLike {
  readonly name: string
  readonly display_name?: string | undefined
  readonly roles: readonly ExecutorRole[]
  readonly ops: readonly {readonly name: string; readonly sync_result?: boolean}[]
  readonly model_visibility?: 'direct' | 'hidden' | undefined
  readonly policy: {
    readonly priority: number
    readonly operation_class?: 'task' | 'monitor'
    readonly alert_delivery?: 'none' | 'deferred' | 'preemptive'
    readonly suggest?: boolean
    readonly progress_via_surrogate?: boolean
  }
}

export interface ServiceRuntime {
  readonly codingProgressNarration?: CodingProgressNarrationState
  readonly clock: Clock
  readonly executors: ReadonlyMap<string, {
    readonly manifest: ExecutorManifestLike
    admitRequest?(op: string, request: Readonly<Record<string, JsonValue>>): ExecutorAdmission | null
  }>
  observe(observer: (event: EventRecord, currentConversation?: boolean) => void): () => void
  serve(stop: AbortSignal): Promise<void>
  clearConversation?(): Promise<void>
  flushMemory?(maintenance?: boolean): Promise<void>
  /** The delegate a handoff claimed, if this exact event claimed one. */
  claimedHandoff(seq: number): DelegateLike | undefined
  /** Whether this exact deadline is the one that terminated its delegate. */
  terminatedByDeadline(seq: number, delegateId: string): boolean
  /** The delegate from either table, whether or not it is still in flight. */
  delegateFor(delegateId: string): DelegateLike | undefined
  /** The delegate only if it is still in flight. */
  inFlightDelegate(delegateId: string): DelegateLike | undefined
  /** A suggestion by id, for attributing a turn to what it was answering. Optional. */
  suggestionFor?: (suggestionId: string) => {
    readonly kind: string
    readonly evidence_refs: readonly string[]
  } | null
  /** Mark a suggestion as actually offered. Optional. */
  confirmSuggestionSpoken?: (suggestionId: string) => void
  /**
   * The blackboard, for the conversation history a replacement provider is seeded with.
   *
   * Optional because the history arms are off by default, and a runtime that never reconnects for a
   * preemptive alert
   * has no reason to expose it.
   */
  readonly memory?: {
    readonly policies: ReadonlyMap<string, {readonly progress_via_surrogate?: boolean}>
    readonly channels: ReadonlyMap<string, {readonly items: readonly MemoryItem[]}>
  }
}
export interface HostItemOptions {
      readonly semanticEventId?: string | null
      readonly priority?: number
      readonly preemptive?: boolean
      /** A monitor policy has authorized this as a preemptive alert. */
      readonly preemptiveAlert?: boolean
      readonly preemptiveAlertDelegateId?: string | null
      readonly owner?: HostItemOwner | null
      readonly expiresAt?: number | null
    }
