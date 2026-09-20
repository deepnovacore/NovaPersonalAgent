import type {MemoryInspectionQuery} from '../memory/personal-memory-inspection.js'
import type {UsageReporter} from '../realtime/usage.js'
import {recentDispatchSources} from '../realtime/history.js'
import type {ApprovalController} from '../core/approval-port.js'
import {capabilityStatus, type CapabilityStatus} from '../config/capability-registry.js'
import { randomUUID } from 'node:crypto'
import { AssemblyError, type Assembly, type AssemblyOptions } from './assembly.js'
import {attachKnowledgeReferences} from '../knowledge/references.js'
import { canonicalJson, compareCodePoints } from '../text/canonical-json.js'
import type {PublicProjectContext} from '../projects/project-store.js'
import type { JsonValue } from '../core/events.js'
import {
  executorWithRole,
  type CancelTargetResolver,
  type CodingExecutorResource,
  type ProjectExecutorAdapter,
} from '../executors/coding-executor.js'
import {
  PlaybackRegistry,
  type PlaybackCompletion,
  type PlaybackFrame,
} from '../realtime/playback.js'
import type { CompiledTools } from '../core/tool-schema.js'
import { RealtimeRuntimeBridge } from '../realtime/bridge.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
  ProjectConfirmationView,
} from '../projects/project-confirmation.js'
import type { RealtimeProvider, ResponseAdaptationContext } from '../realtime/protocol.js'
import { RealtimeProviderSession } from '../realtime/provider-session.js'
import { RealtimeService } from '../realtime/service.js'
import type { ExecutorState, PreemptiveAlertHistoryRecovery } from '../realtime/service-state.js'
import { RealtimeSession } from '../realtime/session.js'
import type { CaptionFrame } from '../realtime/session-state.js'
import type { RealtimeTelemetry } from '../realtime/telemetry.js'
import {renderActiveExecutorContext, renderActiveProjectContext} from '../realtime/frontend-instructions.js'
import type {Suggestion} from '../core/suggestions.js'
import type {WakeReason} from '../core/slots.js'
import {USER_PRIORITY, parseMemoryRef} from '../core/memory.js'
import type {CoordinatorDecision} from '../executors/coding-executor.js'

/** Intake-issued delegate requests carry the user's own priority (the voice model awaited them). */
const USER_AWAITED_TOOL = {kind: 'realtime_tool', priority: USER_PRIORITY, routing_class: 'user_awaited', origin: null, selected_suggestion: null} as const
import {intakeModels, type IntakeModels} from '../executors/coding/intake-model.js'
import type {IntakeOptions, IntakeSettings, IntakeSession} from '../executors/coding/intake.js'
import type {ModelGateway} from '../model/model-gateway.js'
import type {PersonalMemoryResource} from '../memory/personal-memory.js'

export type {CodingAgentControllerFactory} from '../executors/coding-executor.js'
import type {CodingAgentControllerFactory} from '../executors/coding-executor.js'

/** Production compositions derive intake from settings only when an executor carries `coding`; an explicit `intake` without one still fails assembly. */
export function defaultIntake(
  core: Assembly,
  gateway: ModelGateway,
  settings: IntakeSettings & {readonly surrogate_model: string; readonly planner_model: string; readonly fast_model: string},
): RealtimeAssemblyOptions['intake'] {
  if (executorWithRole([...core.runtime.executors.values()].map(adapter => adapter.manifest), 'coding') === null) return undefined
  return {models: intakeModels(gateway, settings.surrogate_model, settings.planner_model || settings.fast_model), settings}
}

export const REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS = 1_000
interface PriorAssistantReplyCandidate {
  readonly sessionEpoch: number
  readonly userInputRevision: number
  readonly text: string
}

const MAX_CAPTURED_PRIOR_REPLIES = 16

/**
 * Captures the already-audible adjacent reply before transcript persistence can yield. Delivery
 * after that point belongs to a later user boundary and must not be retroactively attached.
 */
class PersonalMemoryTurnTracker {
  #candidate: PriorAssistantReplyCandidate | null = null
  readonly #captured = new Map<string, string | undefined>()

  reset(): void {
    this.#candidate = null
    this.#captured.clear()
  }

  onDelivery(
    completion: PlaybackCompletion,
    responseUserInputRevision: number | undefined,
    currentUserInputRevision: number,
  ): void {
    this.#candidate = null
    if (
      completion.disposition !== 'spoken'
      || completion.text.trim() === ''
      || responseUserInputRevision === undefined
      || responseUserInputRevision !== currentUserInputRevision
      || !(completion.played_ms !== null
        ? completion.played_ms > 0
        : completion.started)
    ) return
    this.#candidate = {
      sessionEpoch: completion.session_epoch,
      userInputRevision: responseUserInputRevision,
      text: completion.text,
    }
  }

  captureUserFinal(sessionEpoch: number, userInputRevision: number): void {
    const candidate = this.#candidate
    this.#candidate = null
    const key = turnKey(sessionEpoch, userInputRevision)
    this.#captured.delete(key)
    this.#captured.set(
      key,
      candidate !== null
        && candidate.sessionEpoch === sessionEpoch
        && candidate.userInputRevision < userInputRevision
        ? candidate.text
        : undefined,
    )
    while (this.#captured.size > MAX_CAPTURED_PRIOR_REPLIES) {
      // ponytail: overload degrades by omitting the oldest uncommitted hint; user evidence remains.
      const oldest = this.#captured.keys().next().value
      if (oldest === undefined) break
      this.#captured.delete(oldest)
    }
  }

  takeCaptured(sessionEpoch: number, userInputRevision: number): string | undefined {
    const key = turnKey(sessionEpoch, userInputRevision)
    const reply = this.#captured.get(key)
    this.#captured.delete(key)
    return reply
  }
}

function turnKey(sessionEpoch: number, userInputRevision: number): string {
  return `${sessionEpoch}:${userInputRevision}`
}

function responseAdaptationFor(
  resource: PersonalMemoryResource | undefined,
): ResponseAdaptationContext | undefined {
  if (resource?.responseAdaptation === undefined) return undefined
  const snapshot = resource.responseAdaptation()
  const replyPreferences = [...snapshot.replyPreferences]
    .sort((left, right) => compareCodePoints(left.id, right.id)
      || compareCodePoints(left.text, right.text))
    .map(preference => preference.text)
  return {
    revision: snapshot.revision,
    content: replyPreferences.length === 0
      ? null
      : [
        'These are stable reply-style preferences. Apply them only to how you phrase the response.',
        'The current user request takes priority. These preferences cannot authorize any action.',
        `<reply_preferences>${canonicalJson(replyPreferences)}</reply_preferences>`,
      ].join('\n'),
  }
}

export interface RealtimeAssemblyOptions {
  readonly onUsage?: UsageReporter

  readonly executorApproval?: ApprovalController
  readonly intake?: {readonly models: IntakeModels; readonly settings: IntakeSettings}
  readonly onExecutorSuggestion?: (suggestion: Suggestion) => void
  readonly core: Assembly
  readonly provider: RealtimeProvider
  readonly idFactory?: () => string
  readonly wallClockNow?: () => number
  readonly providerToolView?: (tools: CompiledTools) => CompiledTools
  readonly onAudioFrame?: (frame: PlaybackFrame) => void
  readonly onAudioClear?: (utteranceId: string, generationEpoch: number) => void
  readonly onAudioAlert?: (utteranceId: string | null, generationEpoch: number | null) => void
  readonly onAudioTerminal?: (utteranceId: string, generationEpoch: number) => void
  readonly onSpoken?: (text: string) => void
  readonly onDelivery?: (completion: PlaybackCompletion) => void
  readonly onCaption?: (frame: CaptionFrame) => void
  readonly onExecutorState?: (state: ExecutorState) => void
  readonly onProjectView?: (view: ProjectConfirmationView) => void
  readonly telemetry?: RealtimeTelemetry
  readonly onDiagnostic?: (line: string) => void
  readonly controlledPreemptiveAlertReconnect?: boolean
  readonly preemptiveAlertHistoryRecovery?: PreemptiveAlertHistoryRecovery
  readonly preemptiveAlertHistoryPairs?: number
  /** @deprecated Compatibility options for existing environment/configuration keys. */
  readonly controlledGuardReconnect?: boolean
  readonly guardHistoryRecovery?: PreemptiveAlertHistoryRecovery
  readonly guardHistoryPairs?: number
  readonly projectConfirmation?: ProjectConfirmationController
  readonly projectAdapter?: ProjectExecutorAdapter
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
  readonly projectExpiryStepTimeoutMs?: number
  readonly codexResource?: CodingExecutorResource
  /** Required only when the resolved runtime has a coding role. */
  readonly codingAgentControllerFactory?: CodingAgentControllerFactory
  /** Personal-memory allocation occurs only after the final tool and executor validation. */
  readonly createPersonalMemory?: () => PersonalMemoryResource
}

type LifecycleState = 'new' | 'starting' | 'started' | 'stopping' | 'stopped'

type CleanupResult =
  | {readonly kind: 'resolved'}
  | {readonly kind: 'rejected'; readonly error: unknown}
  | {readonly kind: 'abandoned'}

/**
 * One provider-neutral realtime object graph around one already-built core assembly.
 *
 * This owner is deliberately the only caller of `RealtimeService.start()`: the service in turn is
 * the only owner of `runtime.serve()`. Lifecycle state lives outside both resources because a
 * stopped `RealtimeProviderSession` and a served `CausalRuntime` are terminal even though their
 * lower-level classes expose individually idempotent methods.
 */
export class RealtimeAssembly {
  readonly capabilityStatus: CapabilityStatus
  readonly core: Assembly
  readonly provider: RealtimeProvider
  readonly providerSession: RealtimeProviderSession
  readonly playback: PlaybackRegistry
  readonly session: RealtimeSession
  readonly bridge: RealtimeRuntimeBridge
  readonly service: RealtimeService
  readonly runtime: Assembly['runtime']
  readonly tools: CompiledTools

  readonly #onDiagnostic: (line: string) => void
  readonly #projectAdapter: ProjectExecutorAdapter | undefined
  readonly #codexResource: CodingExecutorResource | undefined
  readonly #unsubscribeProjectView: (() => void) | undefined
  readonly #unsubscribeProjectContext: (() => void) | undefined
  readonly #unsubscribeProviderConnected: (() => void) | undefined
  readonly #personalMemoryTurnTracker: PersonalMemoryTurnTracker
  readonly #idFactory: () => string
  readonly #unbindSuggestionSelected: (() => void) | undefined
  readonly #createPersonalMemory: (() => PersonalMemoryResource) | undefined
  #personalMemory: PersonalMemoryResource | undefined
  #currentHostWorkspaceId: string | null = null
  #latestProjectView: ProjectConfirmationView | null = null
  #projectContextRevision = 0
  #lastProjectContextKey: string | null = null
  #lastProjectContextScopeId: string | null = null
  #projectContextOwnershipUncertain = false
  #providerConnectionObserved = false
  #projectContextTail: Promise<void> = Promise.resolve()
  #state: LifecycleState = 'new'
  #startOperation: Promise<void> | null = null
  #stopOperation: Promise<void> | null = null
  #clearConversationOperation: Promise<void> | null = null

  constructor(input: {
    readonly toolCount?: number
    readonly core: Assembly
    readonly provider: RealtimeProvider
    readonly providerSession: RealtimeProviderSession
    readonly playback: PlaybackRegistry
    readonly session: RealtimeSession
    readonly bridge: RealtimeRuntimeBridge
    readonly service: RealtimeService
    readonly onDiagnostic: (line: string) => void
    readonly projectAdapter?: ProjectExecutorAdapter
    readonly onProjectView?: (view: ProjectConfirmationView) => void
    readonly codexResource?: CodingExecutorResource
    readonly idFactory: () => string
    readonly wallClockNow: () => number
    readonly unbindSuggestionSelected?: () => void
    readonly personalMemory?: PersonalMemoryResource
    readonly createPersonalMemory?: () => PersonalMemoryResource
    readonly personalMemoryTurnTracker: PersonalMemoryTurnTracker
  }) {
    this.core = input.core
    this.capabilityStatus = capabilityStatus(input.core.capabilities, input.toolCount ?? input.core.tools.schemas.length)
    this.provider = input.provider
    this.providerSession = input.providerSession
    this.playback = input.playback
    this.session = input.session
    this.bridge = input.bridge
    this.service = input.service
    this.runtime = input.core.runtime
    this.tools = input.core.tools
    this.#onDiagnostic = input.onDiagnostic
    this.#projectAdapter = input.projectAdapter
    this.#codexResource = input.codexResource
    this.#idFactory = input.idFactory
    this.#unbindSuggestionSelected = input.unbindSuggestionSelected
    this.#personalMemory = input.personalMemory
    this.#createPersonalMemory = input.createPersonalMemory
    this.#personalMemoryTurnTracker = input.personalMemoryTurnTracker
    this.#unsubscribeProjectView = input.projectAdapter === undefined
      ? undefined
      : input.projectAdapter.observeProjectView(view => {
        input.onProjectView?.(view)
      })
    this.#unsubscribeProjectContext = input.projectAdapter === undefined
      ? undefined
      : input.projectAdapter.observeProjectContext(async context => {
        this.#acceptProjectContext(context)
        await this.#enqueueProjectContextPublication(true)
      })
    this.#unsubscribeProviderConnected = input.providerSession.observeConnected(async () => {
      input.personalMemoryTurnTracker.reset()
      if (input.projectAdapter === undefined) return
      // Initial delivery is owned by #startFresh's bounded publication step.
      // Lifecycle observation owns only fresh reconnect epochs.
      if (!this.#providerConnectionObserved) {
        this.#providerConnectionObserved = true
        return
      }
      await this.#enqueueProjectContextPublication()
    })
  }

  inspectPersonalMemory(query: MemoryInspectionQuery) {
    return this.#personalMemory?.inspect?.(query) ?? Promise.resolve(null)
  }

  start(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      return Promise.reject(new AssemblyError('realtime assembly cannot restart after stop'))
    }
    if (this.#state === 'started') return Promise.resolve()
    if (this.#startOperation !== null) return this.#startOperation

    this.#state = 'starting'
    const operation = this.#startFresh()
    this.#startOperation = operation
    void operation.then(
      () => {
        if (this.#startOperation === operation) this.#startOperation = null
      },
      () => {
        if (this.#startOperation === operation) this.#startOperation = null
      },
    )
    return operation
  }

  stop(): Promise<void> {
    if (this.#state === 'stopped') return Promise.resolve()
    if (this.#stopOperation !== null) return this.#stopOperation

    const starting = this.#startOperation
    this.#state = 'stopping'
    const operation = this.#stopAfter(starting)
    this.#stopOperation = operation
    void operation.then(
      () => {
        if (this.#stopOperation === operation) this.#stopOperation = null
      },
      () => {
        if (this.#stopOperation === operation) this.#stopOperation = null
      },
    )
    return operation
  }

  /** Replace the audible conversation and its durable blackboard while preserving external work. */
  clearConversation(): Promise<void> {
    if (this.#clearConversationOperation !== null) return this.#clearConversationOperation
    if (this.#state !== 'started') {
      return Promise.reject(new AssemblyError('realtime assembly must be started before conversation clear'))
    }
    this.#personalMemoryTurnTracker.reset()
    let resolveOperation!: () => void
    let rejectOperation!: (error: unknown) => void
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    this.#clearConversationOperation = operation
    try {
      void this.service.clearConversation().then(async () => {
        // Provider connection observation already publishes this under the new epoch. This explicit
        // pass makes the public clear contract hold for assemblies without that optional observer and
        // deduplicates when the observer delivered it successfully.
        await this.#enqueueProjectContextPublication()
      }).then(resolveOperation, rejectOperation)
    } catch (error) {
      rejectOperation(error)
    }
    void operation.then(
      () => { if (this.#clearConversationOperation === operation) this.#clearConversationOperation = null },
      () => { if (this.#clearConversationOperation === operation) this.#clearConversationOperation = null },
    )
    return operation
  }

  /** Refresh provider workspace context when in-flight delegate progress changes. */
  enqueueActiveWorkContextPublication(): Promise<void> {
    return this.#enqueueProjectContextPublication()
  }

  async #startFresh(): Promise<void> {
    if (this.#projectAdapter !== undefined
      && typeof this.provider.injectWorkspaceContext !== 'function') {
      await this.#closePersonalMemory()
      if (this.#state === 'starting') this.#state = 'new'
      throw new AssemblyError('selected realtime provider cannot deliver active project context')
    }
    try {
      await this.#openPersonalMemory()
    } catch (error) {
      if (this.#state === 'starting') this.#state = 'new'
      throw error
    }
    if (this.#state !== 'starting') {
      throw new AssemblyError('realtime assembly start was abandoned by stop')
    }
    try {
      if (this.#projectAdapter !== undefined) {
        await this.#projectAdapter.initialize()
        const context = this.#projectAdapter.publicProjectContext(
          this.#projectAdapter.confirmationController.pending,
        )
        this.#acceptProjectContext(context)
      }
      await this.core.start()
    } catch (error) {
      if (this.#state === 'starting') {
        await this.#closePersonalMemory()
        if (this.#state === 'starting') this.#state = 'new'
      }
      throw error
    }
    if (this.#state !== 'starting') {
      throw new AssemblyError('realtime assembly start was abandoned by stop')
    }
    try {
      await this.service.start()
    } catch (error) {
      if (this.#state === 'starting') {
        // A failed connect has not started serve. Keep the restored session for this instance's retry.
        if (!this.core.runtime.hasPersistentMemory) {
          await this.#cleanupWithinGrace(
            () => this.core.stop(),
            'assembly_core_stop_abandoned',
          )
        }
        await this.#closePersonalMemory()
        if (this.#state === 'starting') this.#state = 'new'
      }
      throw error
    }
    const initialPublication = await this.#cleanupWithinGrace(
      () => this.#enqueueProjectContextPublication(),
      'workspace_context_delivery_abandoned',
    )
    if (initialPublication.kind === 'rejected') {
      this.#diagnose('workspace_context_delivery_failed')
      void this.#enqueueProjectContextPublication().catch(() => {
        this.#diagnose('workspace_context_delivery_failed')
      })
    }
    if (this.#state === 'starting') {
      this.#state = 'started'
      if (this.#codexResource !== undefined) {
        try {
          void this.#codexResource.start().catch(() => undefined)
        } catch {
          // A live prewarm is advisory. A real launch remains lazy on first delegation.
        }
      }
    }
  }

  async #stopAfter(starting: Promise<void> | null): Promise<void> {
    if (starting !== null) {
      await this.#settleWithinGrace(starting, 'assembly_start_abandoned')
    }

    this.#unbindSuggestionSelected?.()

    let firstFailure: {readonly error: unknown} | null = null
    let cleanupComplete = true
    const service = await this.#cleanupWithinGrace(
      () => this.service.close(),
      'assembly_service_close_abandoned',
    )
    if (service.kind !== 'resolved') cleanupComplete = false
    if (service.kind === 'rejected') firstFailure = {error: service.error}

    // Transport/task grace must not abandon an admitted SQLite transaction.
    try { await this.core.runtime.closeMemory() }
    catch (error) { cleanupComplete = false; firstFailure ??= {error} }

    const personalMemory = await this.#closePersonalMemory()
    if (personalMemory.kind !== 'resolved') cleanupComplete = false
    if (firstFailure === null && personalMemory.kind === 'rejected') {
      firstFailure = {error: personalMemory.error}
    }

    const core = await this.#cleanupWithinGrace(
      () => this.core.stop(),
      'assembly_core_stop_abandoned',
    )
    if (core.kind !== 'resolved') cleanupComplete = false
    if (firstFailure === null && core.kind === 'rejected') firstFailure = {error: core.error}

    if (this.#codexResource !== undefined) {
      const codex = await this.#cleanupWithinGrace(
        () => this.#codexResource!.close(),
        'codex_close_abandoned',
      )
      if (codex.kind !== 'resolved') cleanupComplete = false
      if (firstFailure === null && codex.kind === 'rejected') firstFailure = {error: codex.error}
    } else if (this.#projectAdapter !== undefined) {
      const project = await this.#cleanupWithinGrace(
        () => this.#projectAdapter!.close(),
        'assembly_project_adapter_close_abandoned',
      )
      if (project.kind !== 'resolved') cleanupComplete = false
      if (firstFailure === null && project.kind === 'rejected') firstFailure = {error: project.error}
    }
    this.#unsubscribeProjectView?.()
    this.#unsubscribeProjectContext?.()
    this.#unsubscribeProviderConnected?.()

    if (cleanupComplete) this.#state = 'stopped'
    if (firstFailure !== null) throw firstFailure.error
  }

  #acceptProjectContext(context: PublicProjectContext): void {
    this.service.onProjectWorkspaceChanged(context.workspace_id)
    this.#latestProjectView = Object.freeze({...context.view})
    this.#currentHostWorkspaceId = context.workspace_id
  }

  #enqueueProjectContextPublication(requireDelivery = false): Promise<void> {
    const view = this.#latestProjectView
    const hostWorkspaceId = this.#currentHostWorkspaceId
    const operation = this.#projectContextTail.then(async () => {
      await this.#injectCurrentProjectContext(
        view,
        hostWorkspaceId,
        requireDelivery,
      )
    })
    this.#projectContextTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #injectCurrentProjectContext(
    view: ProjectConfirmationView | null,
    hostWorkspaceId: string | null,
    requireDelivery: boolean,
  ): Promise<void> {
    const activeExecutorContext = renderActiveExecutorContext(
      this.session.snapshot().active_delegates,
      channel => this.service.agentNameForChannel(channel),
    )
    if (
      view === null
      && activeExecutorContext === null
      && this.#lastProjectContextScopeId === null
    ) return
    if (this.provider.injectWorkspaceContext === undefined) {
      if (requireDelivery) throw new AssemblyError('active project context delivery is unavailable')
      return
    }
    const identity = this.providerSession.identity
    if (identity === null) {
      if (requireDelivery) throw new AssemblyError('active project context provider is disconnected')
      return
    }
    const contextScopeId = hostWorkspaceId ?? 'active-executor-context'
    const content = [
      view === null ? null : renderActiveProjectContext(view),
      activeExecutorContext,
    ].filter((part): part is string => part !== null).join('\n') || [
      '<runtime_context>',
      'active_project=false',
      'active_executor=false',
      '</runtime_context>',
    ].join('\n')
    const contextKey = canonicalJson({
      session_epoch: identity.epoch,
      workspace_instance_id: contextScopeId,
      content,
    })
    if (!this.#projectContextOwnershipUncertain && contextKey === this.#lastProjectContextKey) return
    this.#projectContextRevision += 1
    try {
      await this.providerSession.injectWorkspaceContext({
        kind: 'workspace_context',
        host_item_id: this.#idFactory(),
        event_id: this.#idFactory(),
        content,
        call_id: null,
        session_epoch: identity.epoch,
        workspace_instance_id: contextScopeId,
        revision: this.#projectContextRevision,
      })
    } catch (error) {
      this.#projectContextOwnershipUncertain = true
      this.#lastProjectContextKey = null
      throw error
    }
    this.#lastProjectContextKey = contextKey
    this.#lastProjectContextScopeId = contextScopeId
    this.#projectContextOwnershipUncertain = false
  }

  #diagnose(code: string): void {
    try {
      this.#onDiagnostic(`[realtime-diagnostic] ${code}`)
    } catch {
      // Context diagnostics are best-effort and never change voice/project outcomes.
    }
  }

  async #cleanupWithinGrace(
    cleanup: () => Promise<void>,
    abandonedDiagnostic: string,
  ): Promise<CleanupResult> {
    let work: Promise<void>
    try {
      work = cleanup()
    } catch (error) {
      return {kind: 'rejected', error}
    }
    return this.#settleWithinGrace(work, abandonedDiagnostic)
  }

  async #closePersonalMemory(): Promise<CleanupResult> {
    const personalMemory = this.#personalMemory
    if (personalMemory === undefined) return {kind: 'resolved'}
    this.#personalMemory = undefined
    return this.#cleanupWithinGrace(
      () => personalMemory.close(),
      'personal_memory_close_abandoned',
    )
  }

  async #openPersonalMemory(): Promise<void> {
    try {
      if (this.#personalMemory === undefined && this.#createPersonalMemory !== undefined) {
        this.#personalMemory = this.#createPersonalMemory()
      }
      if (this.#personalMemory === undefined) return
      // Cold SDK/Worker initialization needs the full memory RPC deadline, not shutdown grace.
      const opened = await this.#settleWithinGrace(
        this.#personalMemory.open(),
        'personal_memory_open_abandoned',
        5_000,
      )
      if (opened.kind === 'rejected') throw opened.error
      if (opened.kind === 'abandoned') throw new AssemblyError('personal memory open was abandoned')
    } catch (error) {
      await this.#closePersonalMemory()
      throw error
    }
  }

  async #settleWithinGrace(
    work: Promise<void>,
    abandonedDiagnostic: string,
    timeoutMs = REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS,
  ): Promise<CleanupResult> {
    const settled: Promise<CleanupResult> = work.then(
      () => ({kind: 'resolved'}),
      (error: unknown) => ({kind: 'rejected', error}),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<CleanupResult>(resolve => {
      timer = setTimeout(
        () => resolve({kind: 'abandoned'}),
        timeoutMs,
      )
    })
    const result = await Promise.race([settled, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (result.kind === 'abandoned') {
      try {
        this.#onDiagnostic(`[realtime-diagnostic] ${abandonedDiagnostic}`)
      } catch {
        // Diagnostics are best-effort. Cleanup order must not depend on an observer.
      }
    }
    return result
  }
}

/** Build the provider-neutral realtime resources in their ownership order. */
export function buildRealtimeAssembly(options: RealtimeAssemblyOptions): RealtimeAssembly {
  const core = options.core
  const resourceAdapter = options.codexResource?.adapter
  const codingManifest = executorWithRole([...core.runtime.executors.values()].map(adapter => adapter.manifest), 'coding')
  if (
    options.codexResource !== undefined
    && (codingManifest === null || core.runtime.executors.get(codingManifest.name) !== resourceAdapter)
  ) throw new AssemblyError('coding resource must be the registered coding executor')
  if (options.projectAdapter !== undefined && options.codexResource !== undefined) {
    throw new AssemblyError('manual project adapter cannot be combined with coding resource')
  }
  const projectAdapter = options.codexResource?.mode === 'project'
    ? asProjectAdapter(resourceAdapter)
    : options.projectAdapter
  if (projectAdapter !== undefined) {
    if (options.projectConfirmation !== undefined || options.commitProjectOperation !== undefined) {
      throw new AssemblyError('project adapter cannot be combined with manual project wiring')
    }
    if (codingManifest === null || core.runtime.executors.get(codingManifest.name) !== projectAdapter) {
      throw new AssemblyError('project adapter must be the registered coding executor')
    }
  }
  const projectConfirmation = projectAdapter?.confirmationController ?? options.projectConfirmation
  const commitProjectOperation = projectAdapter === undefined
    ? options.commitProjectOperation
    : ((operation: ConfirmedProjectOperation) => projectAdapter.commitConfirmed(
        operation,
        (request, reason, capability, launchAuthorized) => core.runtime.dispatchConfirmedExternal(
          request,
          reason,
          capability,
          launchAuthorized,
        ),
      ))
  const provider = options.provider
  const onDiagnostic = options.onDiagnostic ?? (line => { console.log(line) })
  const personalMemoryHolder: {current: PersonalMemoryResource | undefined} = {current: undefined}
  const personalMemoryTurnTracker = new PersonalMemoryTurnTracker()
  let responseAdaptationRevision = 0
  let responseAdaptationSignature: string | undefined
  const providerSession = new RealtimeProviderSession(provider, {
    responseAdaptation: () => {
      const preferences = responseAdaptationFor(personalMemoryHolder.current)
      const conversation = core.runtime.memory.channels.get('conversation')
      const sources = recentDispatchSources(conversation?.items ?? [])
      const recovery = sessionHolder.current?.deliveryRecoveryContext()
      const context = {
        content: [preferences?.content, recovery?.content].filter(Boolean).join('\n') || null,
        ...(recovery?.content ? {delivery_version: recovery.version} : {}),
        ...(sources.length === 0 ? {} : {user_sources: sources}),
      }
      const signature = JSON.stringify({context, preferenceRevision: preferences?.revision})
      if (signature !== responseAdaptationSignature) {
        responseAdaptationRevision++
        responseAdaptationSignature = signature
      }
      return {revision: responseAdaptationRevision, ...context}
    },
    onResponseAdaptationApplied: (context, epoch) => {
      if (context.delivery_version !== undefined) sessionHolder.current?.confirmDeliveryRecovery(context.delivery_version, epoch)
    },
    onDiagnostic: diagnostic => {
      onDiagnostic(
        `[realtime-diagnostic] response_adaptation_${diagnostic.reason} epoch=${diagnostic.epoch} revision=${diagnostic.revision ?? 'none'}`,
      )
    },
  })
  const providerTools = options.providerToolView?.(core.tools) ?? core.tools
  const providerSchemas = validateProviderToolView(core.tools, providerTools)
  const count = providerSchemas.length
  const budget = core.capabilities.frontbrainToolBudget
  if (count > budget) throw new FrontbrainToolBudgetError(count, budget)
  const idFactory = options.idFactory ?? (() => `nova_${randomUUID().replaceAll('-', '')}`)
  const wallClockNow = options.wallClockNow ?? (() => Date.now() / 1_000)
  const playback = new PlaybackRegistry({
    idFactory,
    onFrame: options.onAudioFrame ?? noop,
    onClear: options.onAudioClear ?? noop,
    ...(options.onAudioAlert === undefined ? {} : {onAlert: options.onAudioAlert}),
  })
  const sessionHolder: {current: RealtimeSession | null} = {current: null}
  const session = new RealtimeSession({
    provider: providerSession,
    playback,
    idFactory,
    clock: core.runtime.clock,
    ...(options.onSpoken === undefined ? {} : {onSpoken: options.onSpoken}),
    onDelivery: completion => {
      const currentSession = sessionHolder.current
      const currentIdentity = providerSession.identity
      if (currentSession !== null && currentIdentity?.epoch === completion.session_epoch) {
        personalMemoryTurnTracker.onDelivery(
          completion,
          currentSession.providerTurnUserInputRevision(completion.response_id),
          currentSession.userInputRevision,
        )
      }
      options.onDelivery?.(completion)
    },
    onDiagnostic,
  })
  sessionHolder.current = session
  const assemblyHolder: {current: RealtimeAssembly | null} = {current: null}
  if (options.intake !== undefined && projectAdapter === undefined) {
    throw new AssemblyError('no executor with role coding')
  }
  if (codingManifest !== null && options.codingAgentControllerFactory === undefined) {
    throw new AssemblyError('coding agent controller factory required')
  }
  if (codingManifest === null && options.codingAgentControllerFactory !== undefined) {
    throw new AssemblyError('coding agent controller factory requires a coding executor')
  }
  const personalMemorySessionId = randomUUID()
  const bridge = new RealtimeRuntimeBridge({
    runtime: core.runtime,
    ...(options.createPersonalMemory === undefined ? {} : {personalMemory: {
      recall: (...input) => {
        const current = personalMemoryHolder.current
        return current === undefined
          ? Promise.reject(new Error('personal memory is unavailable'))
          : current.recall(...input)
      },
    }}),
    tools: core.tools,
    idFactory,
  })
  // Qwen/Cascaded resolve their default intake before entering this assembly. Preserve that
  // exact resolver for the composed controller; a direct no-intake test seam remains safely
  // unable to guess an ambiguous running-work target.
  const resolvedIntakeModels = options.intake?.models
  const resolveCancelTarget: CancelTargetResolver = resolvedIntakeModels === undefined
    ? () => Promise.resolve(null)
    : (instruction, running) => resolvedIntakeModels.resolveCancelTarget(instruction, running)
  const agentDispatchPort = {
    cancelPendingDispatch: (id: string) => core.runtime.cancelPendingDispatch(id),
    dispatch: (request: {
      readonly channel: string
      readonly op: string
      readonly request: Readonly<Record<string, JsonValue>>
      readonly origin_ref: string
      readonly stillWanted: () => boolean
    }) => {
      // This is the runtime-side fence paired with the controller's last check. It must be
      // immediately adjacent to dispatchExternal so a superseding user turn cannot start work.
      if (!request.stillWanted()) return {accepted: false, delegate_id: null}
      return core.runtime.dispatchExternal({
        executor: request.channel, op: request.op, request: request.request, origin_ref: request.origin_ref,
      }, USER_AWAITED_TOOL, undefined, request.stillWanted)
    },
  }
  const agentControllerFactory = codingManifest === null ? undefined : {
    create: ({intake}: {readonly intake: IntakeOptions | undefined}) =>
      options.codingAgentControllerFactory!.create({
        channel: codingManifest.name,
        intake,
        executor: projectAdapter,
        dispatchPort: agentDispatchPort,
        resolveCancelTarget,
      }),
  }
  const agentControllers = core.visionController === undefined ? [] : [core.visionController]
  const service = new RealtimeService({
    ...(options.createPersonalMemory === undefined ? {} : {onUserTranscriptAccepted: (turn: {
      readonly text: string; readonly originRef: string; readonly sessionEpoch: number
      readonly userInputRevision: number
    }) => {
      const previousAssistantReply = personalMemoryTurnTracker.takeCaptured(
        turn.sessionEpoch,
        turn.userInputRevision,
      )
      const resource = personalMemoryHolder.current
      if (resource?.remember === undefined) return
      const [, sequence] = parseMemoryRef(turn.originRef)
      return resource.remember({
        sourceId: `${personalMemorySessionId}:${turn.originRef}`,
        sessionId: personalMemorySessionId,
        sequence,
        text: turn.text,
        occurredAt: new Date(wallClockNow() * 1_000).toISOString(),
        ...(previousAssistantReply === undefined ? {} : {previousAssistantReply}),
      }).then(() => undefined)
    }}),
    provider: providerSession,
    runtime: core.runtime,
    tools: core.tools,
    providerSchemas,
    session,
    bridge,
    ...(agentControllerFactory === undefined ? {} : {agentControllerFactory}),
    ...(agentControllers.length === 0 ? {} : {agentControllers}),
    ...(options.intake === undefined || projectAdapter === undefined ? {} : {intake: {
      ...options.intake,
      ...(core.knowledge === undefined ? {} : {attachEvidence: ((order, workspace, signal) => attachKnowledgeReferences(
        core.knowledge!.service, order.objective, workspace, Object.hasOwn(core.knowledge!.codexEntries, 'nova_knowledge'), signal,
      )) satisfies NonNullable<IntakeOptions['attachEvidence']>}),
      roster: () => projectAdapter.roster(),
      running: () => projectAdapter.running(),
      activeProject: () => projectAdapter.publicProjectView(false).workspace_display_name,
      resolveTarget: (decision: CoordinatorDecision) => projectAdapter.resolveIntakeTarget(decision),
      // Spec 08: the coordinator's decision rides with the work order; the adapter re-resolves at run time.
      dispatch: (intake: IntakeSession, stillWanted?: () => boolean) => core.runtime.dispatchExternal({
        executor: projectAdapter.manifest.name, op: 'run', origin_ref: intake.origin_ref,
        request: {
          work_order: intake.work_order!, project: intake.target?.workspace_display_name ?? null,
          ...(intake.target?.session_id ? {session_id: intake.target.session_id} : {}),
          session: intake.decision?.session ?? 'latest', ...(intake.title === null ? {} : {title: intake.title}),
        },
      }, USER_AWAITED_TOOL, undefined, stillWanted),
      steer: (intake: IntakeSession, project: string | null, instruction: string, stillWanted?: () => boolean) => core.runtime.dispatchExternal({
        executor: projectAdapter.manifest.name, op: 'steer', origin_ref: intake.origin_ref, request: {instruction, project},
      }, USER_AWAITED_TOOL, undefined, stillWanted),
      record: (intake: IntakeSession, kind: string, data: Readonly<Record<string, JsonValue>>) => {
        core.runtime.memory.append(projectAdapter.manifest.name, {
          ts: core.runtime.clock.now(), trust: 'trusted_system', priority: USER_PRIORITY - 1,
          content: {kind, intake_id: intake.intake_id, revision: intake.revision, ...data}, refs: [intake.origin_ref],
        })
        void core.runtime.flushMemory().catch(() => { /* runtime owns the fatal storage diagnostic */ })
      },
    }}),
    idFactory,
    onProviderTerminal: generation => {
      options.onAudioTerminal?.(generation.utterance_id, generation.generation_epoch)
    },
    ...(options.onExecutorState === undefined ? {} : {onExecutorState: options.onExecutorState}),
    onActiveWorkChanged: () => {
      void assemblyHolder.current?.enqueueActiveWorkContextPublication().catch(() => {
        onDiagnostic('[realtime-diagnostic] active_executor_context_delivery_failed')
      })
    },
    ...((options.createPersonalMemory === undefined && options.onCaption === undefined) ? {} : {onCaption: (frame: CaptionFrame) => {
      if (frame.role === 'user' && frame.final && frame.text.trim() !== '') {
        personalMemoryTurnTracker.captureUserFinal(session.sessionEpoch, session.userInputRevision)
      }
      options.onCaption?.(frame)
    }}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.controlledPreemptiveAlertReconnect === undefined && options.controlledGuardReconnect === undefined
      ? {}
      : {controlledPreemptiveAlertReconnect: options.controlledPreemptiveAlertReconnect
        ?? options.controlledGuardReconnect}),
    ...(options.preemptiveAlertHistoryRecovery === undefined && options.guardHistoryRecovery === undefined
      ? {}
      : {preemptiveAlertHistoryRecovery: options.preemptiveAlertHistoryRecovery
        ?? options.guardHistoryRecovery}),
    ...(options.preemptiveAlertHistoryPairs === undefined && options.guardHistoryPairs === undefined
      ? {}
      : {preemptiveAlertHistoryPairs: options.preemptiveAlertHistoryPairs ?? options.guardHistoryPairs}),
    ...(projectConfirmation === undefined
      ? {}
      : {projectConfirmation}),
    ...((options.executorApproval ?? options.codexResource?.approvalController) == null
      ? {}
      : {executorApproval: (options.executorApproval ?? options.codexResource?.approvalController)!}),
    ...(commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation}),
    ...(projectAdapter === undefined
      ? {}
      : {projectViewProvider: (pending: boolean) => projectAdapter.publicProjectView(pending)}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.projectExpiryStepTimeoutMs === undefined
      ? {}
      : {projectExpiryStepTimeoutMs: options.projectExpiryStepTimeoutMs}),
    onDiagnostic,
  })
  const unbindSuggestionSelected = core.runtime.bindSuggestionSelected(
    (suggestion: Suggestion, reason: WakeReason) => {
      try { options.onExecutorSuggestion?.(suggestion) } catch { /* observability cannot own speech */ }
      service.onSuggestionSelected(suggestion, reason)
    },
  )
  const personalMemory = options.createPersonalMemory?.()
  personalMemoryHolder.current = personalMemory
  return assignAssembly(new RealtimeAssembly({
    toolCount: count,
    core,
    provider,
    providerSession,
    playback,
    session,
    bridge,
    service,
    onDiagnostic,
    idFactory,
    wallClockNow,
    unbindSuggestionSelected,
    ...(personalMemory === undefined ? {} : {personalMemory}),
    ...(options.createPersonalMemory === undefined ? {} : {
      createPersonalMemory: () => {
        const created = options.createPersonalMemory!()
        personalMemoryHolder.current = created
        return created
      },
    }),
    personalMemoryTurnTracker,
    ...(projectAdapter === undefined ? {} : {projectAdapter}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
  }), assemblyHolder)
}

function assignAssembly(
  assembly: RealtimeAssembly,
  holder: {current: RealtimeAssembly | null},
): RealtimeAssembly {
  holder.current = assembly
  return assembly
}

function asProjectAdapter(adapter: unknown): ProjectExecutorAdapter {
  if (
    typeof adapter !== 'object'
    || adapter === null
    || !('confirmationController' in adapter)
    || !('commitConfirmed' in adapter)
    || !('publicProjectView' in adapter)
    || !('publicProjectContext' in adapter)
    || !('activeCommittedWorkspace' in adapter)
    || !('observeProjectView' in adapter)
    || !('observeProjectContext' in adapter)
  ) throw new AssemblyError('project coding resource has an invalid adapter')
  return adapter as ProjectExecutorAdapter
}

function validateProviderToolView(
  full: CompiledTools,
  provider: unknown,
): readonly Readonly<Record<string, JsonValue>>[] {
  if (!isUnknownObject(provider) || !('bindings' in provider) || !('schemas' in provider)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  if (provider.bindings !== full.bindings) {
    throw new AssemblyError('provider tool view must reuse core tool bindings')
  }
  if (!Array.isArray(provider.schemas)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  const fullByName = new Map<string, string>()
  for (const schema of full.schemas) {
    const snapshot = snapshotJsonObject(schema)
    if (snapshot === null) throw new AssemblyError('core tool view contains a malformed schema')
    const name = validFunctionSchemaName(snapshot)
    if (name === null || fullByName.has(name)) {
      throw new AssemblyError('core tool view contains a malformed schema')
    }
    let canonical: string
    try {
      canonical = canonicalJson(snapshot)
    } catch {
      throw new AssemblyError('core tool view contains a malformed schema')
    }
    fullByName.set(name, canonical)
  }
  const providerNames = new Set<string>()
  const providerSchemas: Readonly<Record<string, JsonValue>>[] = []
  for (const schema of provider.schemas) {
    const snapshot = snapshotJsonObject(schema)
    if (snapshot === null) {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    const name = validFunctionSchemaName(snapshot)
    if (name === null || providerNames.has(name)) {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    providerNames.add(name)
    const fullCanonical = fullByName.get(name)
    if (fullCanonical === undefined) {
      throw new AssemblyError('provider tool view contains an unknown schema')
    }
    let providerCanonical: string
    try {
      providerCanonical = canonicalJson(snapshot)
    } catch {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    if (providerCanonical !== fullCanonical) {
      throw new AssemblyError('provider tool view schema must match core schema')
    }
    providerSchemas.push(snapshot)
  }
  return providerSchemas
}

function validFunctionSchemaName(schema: unknown): string | null {
  if (!isUnknownObject(schema)) return null
  if (schema.type !== 'function') return null
  const declaration = schema.function
  if (!isUnknownObject(declaration)) return null
  const {name, description, parameters} = declaration
  if (typeof name !== 'string' || name === '') return null
  if (typeof description !== 'string' || description === '') return null
  if (!isUnknownObject(parameters) || parameters.type !== 'object') return null
  if (!isUnknownObject(parameters.properties)) return null
  return name
}

function isUnknownObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotJsonObject(value: unknown): Readonly<Record<string, JsonValue>> | null {
  const snapshot = snapshotJsonValue(value, new Set<object>())
  return isJsonObject(snapshot) ? snapshot : null
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return value
  if (typeof value !== 'object' || ancestors.has(value)) return undefined

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.some(key => key !== 'length' && (
        typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)
      ))) return undefined
      const snapshot: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !('value' in descriptor)) return undefined
        const item = snapshotJsonValue(descriptor.value, ancestors)
        if (item === undefined) return undefined
        snapshot.push(item)
      }
      return snapshot
    }

    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const snapshot: Record<string, JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return undefined
      }
      const field = snapshotJsonValue(descriptor.value, ancestors)
      if (field === undefined) return undefined
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: field,
        writable: true,
      })
    }
    return snapshot
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function noop(): void {
  return
}

export class FrontbrainToolBudgetError extends AssemblyError {
  readonly code = 'frontbrain_tool_budget_exceeded'
  constructor(readonly toolCount: number, readonly toolBudget: number) {
    super(`frontbrain_tool_budget_exceeded: ${toolCount}/${toolBudget}`)
  }
}

/** Apply the role gate before any concrete resource/controller composition, including injected builders. */
export function filterDisabledCoding<T extends AssemblyOptions & Pick<RealtimeAssemblyOptions,
  'codexResource' | 'codingAgentControllerFactory' | 'intake' | 'projectAdapter'>>(options: T): T {
  if (options.capabilities === undefined && options.externalMcp !== undefined) {
    options = {...options, capabilities: options.externalMcp.capabilities}
  }
  if (options.capabilities?.modules.coding.enabled !== false) return options
  const disabled = new Set([
    ...(options.executors ?? []).filter(adapter => adapter.manifest.roles.includes('coding')).map(adapter => adapter.manifest.name),
    ...(options.codexResource === undefined ? [] : [options.codexResource.adapter.manifest.name]),
    ...(options.projectAdapter === undefined ? [] : [options.projectAdapter.manifest.name]),
  ])
  const selected: {-readonly [Key in keyof T]: T[Key]} = {...options}
  selected.settings = {...options.settings, executors: options.settings.executors.filter(name => !disabled.has(name))}
  if (selected.executors !== undefined) selected.executors = selected.executors.filter(adapter => !disabled.has(adapter.manifest.name))
  if (selected.agentDescriptors !== undefined) selected.agentDescriptors = selected.agentDescriptors.filter(descriptor => !descriptor.ownedChannels.some(channel => disabled.has(channel)))
  delete selected.codexResource
  delete selected.codingAgentControllerFactory
  delete selected.intake
  delete selected.projectAdapter
  return selected
}

/** Shared production wiring; provider policy remains at each pipeline boundary. */
export function composeRealtime(
  core: Assembly,
  provider: RealtimeProvider,
  options: Omit<RealtimeAssemblyOptions, 'core' | 'provider' | 'idFactory'> & {readonly settings: AssemblyOptions['settings']; readonly idFactory: () => string},
  providerTuning: Required<Pick<RealtimeAssemblyOptions, 'controlledPreemptiveAlertReconnect' | 'preemptiveAlertHistoryRecovery' | 'preemptiveAlertHistoryPairs'>>,
): RealtimeAssembly {
  return buildRealtimeAssembly({
    core,
    provider,
    ...(options.intake === undefined ? {} : {intake: options.intake}),
    ...(options.onExecutorSuggestion === undefined ? {} : {onExecutorSuggestion: options.onExecutorSuggestion}),
    idFactory: options.idFactory,
    ...providerTuning,
    ...(options.createPersonalMemory === undefined ? {} : {createPersonalMemory: options.createPersonalMemory}),
    ...(options.providerToolView === undefined
      ? {}
      : {providerToolView: options.providerToolView}),
    ...(options.onAudioFrame === undefined ? {} : {onAudioFrame: options.onAudioFrame}),
    ...(options.onAudioClear === undefined ? {} : {onAudioClear: options.onAudioClear}),
    ...(options.onAudioAlert === undefined ? {} : {onAudioAlert: options.onAudioAlert}),
    ...(options.onAudioTerminal === undefined ? {} : {onAudioTerminal: options.onAudioTerminal}),
    ...(options.onSpoken === undefined ? {} : {onSpoken: options.onSpoken}),
    ...(options.onDelivery === undefined ? {} : {onDelivery: options.onDelivery}),
    ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
    ...(options.onExecutorState === undefined ? {} : {onExecutorState: options.onExecutorState}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
    ...(options.projectConfirmation === undefined
      ? {}
      : {projectConfirmation: options.projectConfirmation}),
    ...(options.commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation: options.commitProjectOperation}),
    ...(options.projectExpiryStepTimeoutMs === undefined
      ? {}
      : {projectExpiryStepTimeoutMs: options.projectExpiryStepTimeoutMs}),
    ...(options.executorApproval === undefined ? {} : {executorApproval: options.executorApproval}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
    ...(options.codingAgentControllerFactory === undefined
      ? {}
      : {codingAgentControllerFactory: options.codingAgentControllerFactory}),
  })
}

export function validateCodingResource(options: Pick<AssemblyOptions, 'settings'> & Pick<RealtimeAssemblyOptions, 'codexResource'>): void {
  if (
    options.codexResource !== undefined
    && !options.settings.executors.includes(options.codexResource.adapter.manifest.name)
  ) throw new AssemblyError('realtime coding resource selection mismatch')
  if (options.codexResource !== undefined && options.codexResource.mode !== 'project') {
    throw new AssemblyError('realtime coding resource project mode mismatch')
  }
}
