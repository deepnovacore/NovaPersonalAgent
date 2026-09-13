import { CodingProgressNarrationState,type CodingProgressNarration } from '../coding-progress-narration.js'
import { HostDelivery } from './host-delivery.js'
import { ProviderProjection } from './provider-projection.js'
import type { BoundToolOrigin,DeliverySnapshot,HostItemOptions,ProviderReconnectReason,ServiceRuntime } from './service-ports.js'
import { Mutex,Signal,diagnosticName,isAbort } from './service-state.js'
import { ToolContinuations } from './tool-continuations.js'
export type { DelegateLike,DeliverySnapshot,ExecutorManifestLike,ServiceRuntime } from './service-ports.js'
/**
 * Production orchestration between a realtime FrontBrain and the existing Runtime.
 *
 * Ported from `src/nova_audio_agent/realtime/service.py`. The session below it owns *provider*
 * state -- turns, fences, playback generations -- and this layer owns everything that has to be
 * decided across turns: which host fact gets the floor next, which tool calls belong to the same
 * continuation, and what happens to all of it when the provider session is replaced underneath.
 *
 * Two structural facts shape the whole file.
 *
 * **Almost every ledger is keyed on `(session_epoch, id)`.** That is the reconnect contract, not
 * defensive prefixing: after a reconnect the provider may reuse an item or response id, and a ledger
 * keyed on the id alone would let the new session's item answer the old session's question.
 *
 * **The two locks have a fixed order and one of them must never be held across a public call.**
 * `_reconnect_lock` is taken before `_delivery_lock`, never the reverse. And the reconnect path calls
 * the private `#deliveryPass` rather than the public `flushHostItems`, because the public wrapper
 * would re-enter reconnect and deadlock against the lock already held.
 *
 * Preemptive-alert behavior (controlled reconnect, arbitration, clear deadlines) and project
 * confirmation are gated behind composition settings and a supplied controller. They are not
 * ported yet; where the core path touches them it reaches an explicit boundary that throws rather
 * than silently taking the inert branch, so a test that gets there fails loudly.
 */

import { createHash,randomUUID } from 'node:crypto'
import {
createAgentControllerRegistry,
type AgentController,
type AgentControllerRegistry
} from '../agent-controller.js'
import type { ApprovalController as ExecutorApprovalController } from '../approval-port.js'
import { ApprovalHost } from '../approval.js'
import { canonicalJson } from '../canonical-json.js'
import type { Clock } from '../clock.js'
import { type EventRecord,type JsonValue } from '../events.js'
import {
type IntakeEventPort,
type IntakeOptions,
} from '../executors/coding/intake.js'
import {
USER_PRIORITY,
isMonitorPolicy,
monitorAlertDelivery
} from '../memory.js'
import type { PlaybackCompletion,PlaybackGeneration } from '../playback.js'
import type {
ConfirmedProjectOperation,
ProjectConfirmationController,
ProjectConfirmationView,
} from '../project-confirmation.js'
import { codePointLengthLikePython } from '../python-text.js'
import type { WakeReason } from '../slots.js'
import type { Suggestion } from '../suggestions.js'
import type { CompiledTools } from '../tool-schema.js'
import { CONFIRM_TOOL,confirmArguments } from '../work-tools.js'
import type { RealtimeRuntimeBridge,ToolCallReady } from './bridge.js'
import { ConfirmationTurnIsolation } from './confirmation-turn-isolation.js'
import { type CodingChannel } from './evidence.js'
import { packRecoveryTurns,projectRecoveryTurns,type RecoveryTurn } from './history.js'
import type {
HostContextItem,
HostResponseIntent,
RealtimeProviderEvent,
} from './protocol.js'
import { ItemDeliveryUncertainError } from './protocol.js'
import {
MAX_HOST_FACT_CHARS,
MAX_TRACKED_TOOL_CALLS,
PROJECT_EXPIRY_STEP_TIMEOUT_S,
USER_HOLD_MAX_S,
callKey,
hostFactIntent,
parseCallKey,
projectCommitFailureText,
type ContinuationBatch,
type ExecutorState,
type PreemptiveAlertHistoryRecovery,
type ProjectExpiryBatch,
type QueuedHostResponse,
type SemanticAcknowledgement,
type ToolCallAcceptanceSnapshot,
type ToolCallState,
type UrgentHostResponseOwner
} from './service-state.js'
import {
activeExecutorContextData,
type CaptionFrame
} from './session-state.js'
import { RealtimeDeliveryError,type RealtimeSession } from './session.js'
import type { RealtimeTelemetry } from './telemetry.js'
import { UserOriginBindingLedger } from './user-origin-binding.js'

const PROJECT_CONFIRMATION_CARRIER_RELEASE_TIMEOUT_S = 3

function sameAgentDescriptors(
  left: readonly {readonly name: string; readonly summary: string; readonly ownedChannels: readonly string[]}[],
  right: readonly {readonly name: string; readonly summary: string; readonly ownedChannels: readonly string[]}[],
): boolean {
  return left.length === right.length && left.every((descriptor, index) => {
    const other = right[index]
    return other?.name === descriptor.name
      && descriptor.summary === other.summary
      && descriptor.ownedChannels.length === other.ownedChannels.length
      && descriptor.ownedChannels.every((channel, channelIndex) => channel === other.ownedChannels[channelIndex])
  })
}

interface ProjectConfirmationDecisionRetry {
  readonly item_key: string
  readonly source_response_id: string
  requested: boolean
  retry_response_id: string | null
}

/** The provider surface the service uses directly: three calls, everything else via the session. */
export interface ServiceProvider {
  transcribeDraft?(pcm: Uint8Array, signal: AbortSignal): Promise<string>
  submitText?(text: string, signal: AbortSignal): Promise<void>
  sendAudio(pcm: Uint8Array, signal?: AbortSignal): Promise<void>
  /**
   * The event stream.
   *
   * Takes the stop signal because a parked stream is the normal case at shutdown: the provider has
   * nothing to say and the iterator is suspended. Without the signal, `close()` would wait on an
   * iteration that cannot be cancelled from outside.
   */
  events(signal: AbortSignal): AsyncIterable<RealtimeProviderEvent>
  close(): Promise<void>
}

export interface RealtimeServiceOptions {
  readonly intake?: Pick<
    IntakeOptions,
    'models' | 'settings' | 'roster' | 'running' | 'activeProject' | 'resolveTarget' | 'dispatch' | 'steer' | 'cancel' | 'record'
  >
  /** Supplies the coding controller with host callbacks; the controller owns intake construction. */
  readonly agentControllerFactory?: AgentControllerFactory
  /** Additional host-owned controllers. */
  readonly agentControllers?: readonly AgentController[]
  readonly provider: ServiceProvider
  readonly runtime: ServiceRuntime
  readonly tools: CompiledTools
  readonly providerSchemas?: readonly Readonly<Record<string, JsonValue>>[]
  readonly session: RealtimeSession
  readonly bridge: RealtimeRuntimeBridge
  readonly idFactory?: () => string
  readonly onProviderTerminal?: (generation: PlaybackGeneration) => void
  readonly onExecutorState?: (state: ExecutorState) => void
  /** Fired when active delegate progress changes so provider context can refresh. */
  readonly onActiveWorkChanged?: () => void
  readonly onCaption?: (frame: CaptionFrame) => void
  /** Receives a user transcript only after the core accepted its evidence; it must not block audio. */
  readonly onUserTranscriptAccepted?: (turn: {
    readonly text: string
    readonly originRef: string
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userInputRevision: number
  }) => void | Promise<void>
  readonly telemetry?: RealtimeTelemetry
  /** Generic composition seam; the legacy Guard-named options below remain accepted. */
  readonly controlledPreemptiveAlertReconnect?: boolean
  readonly preemptiveAlertHistoryRecovery?: PreemptiveAlertHistoryRecovery
  readonly preemptiveAlertHistoryPairs?: number
  /** @deprecated Compatibility options for existing environment/configuration keys. */
  readonly controlledGuardReconnect?: boolean
  readonly guardHistoryRecovery?: PreemptiveAlertHistoryRecovery
  readonly guardHistoryPairs?: number
  /** Absent means project confirmation is off, and every branch of it is inert. */
  readonly projectConfirmation?: ProjectConfirmationController
  /** Independent one-shot Codex permission authority; absent on non-brokered transports. */
  readonly executorApproval?: ExecutorApprovalController
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
  ) => Promise<{
    readonly accepted: boolean
    readonly code: string
    readonly delegate_id?: string
  }>
  readonly onProjectView?: (view: ProjectConfirmationView) => void
  readonly projectViewProvider?: (pendingConfirmation: boolean) => ProjectConfirmationView
  /**
   * How long one expiry cleanup step may take before it is abandoned.
   *
   * Injectable because the default is five seconds of wall clock, and the behaviour that matters -- what
   * happens *after* a step is abandoned -- is otherwise only reachable by waiting that long.
   */
  readonly projectExpiryStepTimeoutMs?: number
  /** Where a diagnostic goes. Defaults to stdout, which is what the oracle captures. */
  readonly onDiagnostic?: (line: string) => void
}

export interface AgentControllerFactory {
  create(context: {
    readonly intake: IntakeOptions | undefined
  }): AgentController & {readonly intake?: IntakeEventPort | undefined}
}

/**
 * How long `close` waits for a task that is not responding to its abort signal.
 *
 * Short: every loop here checks the signal at its next suspension point, so a task still running after
 * this is stuck rather than slow, and waiting longer would only delay the diagnostic.
 */
const SHUTDOWN_GRACE_MS = 250

export class RealtimeService {
  readonly #continuations: ToolContinuations

  get toolCallDispositionsForTest(): readonly (string | null)[] { return this.#continuations.toolCallDispositionsForTest }

  driveContinuations(): Promise<void> { return this.#continuations.driveContinuations() }

  toolCallAcceptances(): readonly ToolCallAcceptanceSnapshot[] { return this.#continuations.toolCallAcceptances() }

  readonly #host: HostDelivery

  get urgentOwnerForTest(): UrgentHostResponseOwner | null { return this.#host.urgentOwnerForTest }

  seedUrgentOwnerForTest(input: {
    readonly sessionEpoch: number
    readonly eventId: string
    readonly responseId: string | null
  }): void { return this.#host.seedUrgentOwnerForTest(input) }

  takeNextQueuedHostItem(): QueuedHostResponse | undefined { return this.#host.takeNextQueuedHostItem() }

  queuedHostItems(): readonly QueuedHostResponse[] { return this.#host.queuedHostItems() }

  get armedPreemptPriority(): number | null { return this.#host.armedPreemptPriority }

  get pendingHostItemCount(): number { return this.#host.pendingHostItemCount }

  playbackDisconnected(
    options: {readonly resumeDelivery?: boolean} = {},
  ): Promise<boolean> { return this.#host.playbackDisconnected(options) }

  playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean> { return this.#host.playbackStopped(utteranceId, generationEpoch, playedMs) }

  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean { return this.#host.playbackCleared(utteranceId, generationEpoch, playedMs) }

  playbackDone(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean { return this.#host.playbackDone(utteranceId, generationEpoch, playedMs) }

  queueHostItem(
    intent: HostResponseIntent,
    options: HostItemOptions = {},
  ): void { return this.#host.queueHostItem(intent, options) }

  semanticAcknowledgementFor(responseId: string): string | null { return this.#host.semanticAcknowledgementFor(responseId) }

  readonly #projection: ProviderProjection

  projectRuntimeEvent(event: EventRecord, currentConversation = true): void {
    this.#projection.projectRuntimeEvent(event, currentConversation)
  }

  onSuggestionSelected(suggestion: Suggestion, reason: WakeReason): void {
    this.#projection.onSuggestionSelected(suggestion, reason)
  }

  readonly session: RealtimeSession
  readonly #intake: IntakeEventPort | undefined
  #intakeUser: {text: string; origin_ref: string; epoch: number; inputRevision: number; localOnsetRevision: number} | null = null
  #localSpeechOnsetRevision = 0
  #lastLocalSpeechOnsetId: string | null = null

  readonly #provider: ServiceProvider
  readonly #runtime: ServiceRuntime
  readonly #clock: Clock
  #unsubscribeCodingProgress: (() => void) | null = null
  readonly #codingProgressNarration: CodingProgressNarrationState
  readonly #tools: CompiledTools
  readonly #providerSchemas: readonly Readonly<Record<string, JsonValue>>[]
  readonly #bridge: RealtimeRuntimeBridge
  readonly #idFactory: () => string
  readonly #onProviderTerminal: (generation: PlaybackGeneration) => void
  readonly #onExecutorState: (state: ExecutorState) => void
  readonly #onActiveWorkChanged: () => void
  readonly #onCaption: ((frame: CaptionFrame) => void) | undefined
  readonly #onUserTranscriptAccepted: RealtimeServiceOptions['onUserTranscriptAccepted']
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #onDiagnostic: (line: string) => void
  readonly #controlledPreemptiveAlertReconnect: boolean
  readonly #preemptiveAlertHistoryRecovery: PreemptiveAlertHistoryRecovery
  readonly #preemptiveAlertHistoryPairs: number
  readonly #projectConfirmation: ProjectConfirmationController | undefined
  readonly #approvalHost: ApprovalHost
  /** The coding-role executor's channel and label, resolved once from the registered manifests. */
  readonly #coding: CodingChannel | null
  readonly #agentRegistry: AgentControllerRegistry
  /** Public agent name -> host controller; never inferred from runtime manifest metadata. */
  readonly #agentControllers: ReadonlyMap<string, AgentController>
  readonly #commitProjectOperation:
    | ((operation: ConfirmedProjectOperation) => Promise<{
      readonly accepted: boolean
      readonly code: string
      readonly delegate_id?: string
    }>)
    | undefined
  readonly #onProjectView: ((view: ProjectConfirmationView) => void) | undefined
  readonly #projectViewProvider:
    | ((pendingConfirmation: boolean) => ProjectConfirmationView)
    | undefined
  readonly #projectExpiryStepTimeoutMs: number
  readonly #reconnectLock = new Mutex()
  readonly #pendingIngress = new Set<Promise<void>>()
  readonly #deliveryReady = new Signal()
  /**
   * The stop flag, as a real `AbortController`.
   *
   * Not a look-alike carrying only `aborted`: the runtime's `serve` registers an abort listener on
   * whatever it is handed, so anything less than the real thing throws on the first `start()`.
   * Replaced on each `start()` rather than reset, because an `AbortController` cannot be un-aborted.
   */
  #stop = new AbortController()

  #unsubscribe: (() => void) | null = null
  #tasks: Promise<void>[] = []
  #connected = false
  #providerFailed = false
  #clearingConversation = false
  #clearConversationOperation: Promise<void> | null = null
  #conversationClearRevision = 0
  #executorState: ExecutorState = 'idle'
  /** Compact fingerprint of delegate progress for context refresh. */
  #activeWorkFingerprint = canonicalJson(activeExecutorContextData([]))
  readonly #audioStarted = new Set<string>()
  /** Exact revision-scoped join from provider user items to responses and Memory origins. */
  readonly #userOrigins = new UserOriginBindingLedger(MAX_TRACKED_TOOL_CALLS)
  /** Policy-free project turn identity state; never shared with Codex approval occupancy. */
  readonly #projectConfirmationIsolation = new ConfirmationTurnIsolation<ToolCallReady>(
    MAX_TRACKED_TOOL_CALLS,
  )
  /** Later utterances captured while another item owns the same confirmation. */
  readonly #projectConfirmationShadowItems = new Set<string>()
  /** Items mid-close: no longer answerable, still blocking tool calls. */
  readonly #projectConfirmationClosingItems = new Set<string>()
  /** Bounded carrier cancel/watchdog work, observed so it cannot outlive service shutdown silently. */
  readonly #projectConfirmationCarrierReleaseTasks = new Set<Promise<void>>()
  /** Carrier recovery waits here while a newer user turn is still being transcribed. */
  readonly #projectConfirmationCarrierReconnectAfterUser = new Map<
    string,
    {readonly sessionEpoch: number; readonly responseId: string; readonly reason: string}
  >()
  /** Epoch whose requested confirmation retry has not revealed its response id yet. */
  #projectConfirmationPendingQuarantineEpoch: number | null = null
  readonly #projectConfirmationClosingCalls = new Set<string>()
  /** Voice decision handlers whose exact tool output must precede expiry cleanup when possible. */
  readonly #projectConfirmationDecisionGates = new Map<string, Promise<void>>()
  /** Insertion-ordered so the oldest closed call is the one evicted. */
  readonly #projectConfirmationClosedCalls = new Map<string, null>()
  #projectConfirmationDecisionRetry: ProjectConfirmationDecisionRetry | null = null
  /** Confirmation commits whose terminal user-facing fact has not been selected yet. */
  readonly #projectConfirmationCommittingLifecycles = new Set<string>()
  /** Active commits for which the expiry observer owns the terminal fact. */
  readonly #projectConfirmationExpiryFactOwners = new Set<string>()
  readonly #projectExpiryBatches: ProjectExpiryBatch[] = []
  #projectExpiryDraining: Promise<void> | null = null
  #unsubscribeProjectExpiry: (() => void) | null = null
  #unsubscribeExecutorApproval: (() => void) | null = null
  #awaitingUserOrigin = false
  #userOriginPreexistingResponseId: string | null = null

  constructor(options: RealtimeServiceOptions) {
    const recovery = options.preemptiveAlertHistoryRecovery ?? options.guardHistoryRecovery ?? 'none'
    if (recovery !== 'none' && recovery !== 'packed') {
      throw new TypeError('unknown preemptive-alert history recovery arm')
    }
    const pairs = options.preemptiveAlertHistoryPairs ?? options.guardHistoryPairs ?? 4
    // 1, 2, or 4 rather than any positive number: these are the arms the recovery experiment has,
    // and an unlisted value would silently be a fifth arm nobody measured.
    if (pairs !== 1 && pairs !== 2 && pairs !== 4) {
      throw new TypeError('preemptive-alert history pair budget must be 1, 2, or 4')
    }
    this.#provider = options.provider
    this.#runtime = options.runtime
    this.#clock = options.runtime.clock
    this.#codingProgressNarration = options.runtime.codingProgressNarration ?? new CodingProgressNarrationState()
    this.#subscribeCodingProgress()
    this.#tools = options.tools
    // Deep-copied at construction: the provider is handed these on every connect, including after a
    // reconnect, and a caller that mutated its own array afterwards would change what the model is
    // told its tools are, mid-session.
    this.#providerSchemas = structuredClone(options.providerSchemas ?? options.tools.schemas)
    this.session = options.session
    this.#bridge = options.bridge
    this.#idFactory = options.idFactory ?? (() => `host_${randomHex()}`)
    this.#onProviderTerminal = options.onProviderTerminal ?? noop
    this.#onExecutorState = options.onExecutorState ?? noop
    this.#onActiveWorkChanged = options.onActiveWorkChanged ?? noop
    this.#onCaption = options.onCaption
    this.#onUserTranscriptAccepted = options.onUserTranscriptAccepted
    this.#telemetry = options.telemetry
    this.#onDiagnostic = options.onDiagnostic ?? ((line: string): void => {
      console.log(line)
    })
    this.#controlledPreemptiveAlertReconnect = options.controlledPreemptiveAlertReconnect
      ?? options.controlledGuardReconnect
      ?? false
    this.#preemptiveAlertHistoryRecovery = recovery
    this.#preemptiveAlertHistoryPairs = pairs
    this.#projectConfirmation = options.projectConfirmation
    const intake: IntakeOptions | undefined = options.intake === undefined ? undefined : {
      ...options.intake,
      idFactory: this.#idFactory,
      dispatch: async (intake, stillWanted) => {
        const result = await options.intake!.dispatch(intake, stillWanted)
        if (result.accepted && result.delegate_id !== null && result.delegate_id !== undefined) {
          const title = intake.title ?? intake.target?.session_title
          this.session.registerDelegate(result.delegate_id, {
            summary: intake.slots.goal.note.slice(0, 240),
            state: 'running',
            channel: this.#coding?.channel ?? 'coding',
            ...(intake.target === null ? {} : {project: intake.target.workspace_display_name}),
            ...(title === undefined || title === null ? {} : {title}),
          })
          this.#telemetry?.record('executor.dispatch', {delegate_id: result.delegate_id})
          this.#publishExecutorState()
        }
        return result
      },
      diagnostic: code => this.#onDiagnostic(`[realtime-diagnostic] ${code}`),
      invalidateProposal: () => this.#invalidateProjectConfirmation('intake_amended'),
      fact: (intake, text) => {
        this.queueHostItem(hostFactIntent({
          kind: 'final', host_item_id: this.#idFactory(),
          event_id: `intake:${intake.intake_id}:${intake.revision}:${this.#idFactory()}`,
          content: [...text].slice(0, MAX_HOST_FACT_CHARS).join(''),
        }), {priority: USER_PRIORITY - 1, preemptive: false})
        this.#deliveryReady.set()
      },
      prepare: intake => {
        if (intake.target === null || this.#projectConfirmation === undefined) throw new TypeError('intake_confirmation_unavailable')
        const target = intake.target
        const proposal = this.#projectConfirmation.prepare({
          action: target.action, workspace_display_name: target.workspace_display_name,
          workspace_id: target.workspace_id, session_title: target.session_title, session_id: target.session_id,
          work_order: intake.work_order, origin_ref: intake.origin_ref,
          intake_id: intake.intake_id, plan_revision: intake.plan_revision!,
        })
        this.#syncProjectConfirmationIsolation()
        this.#publishProjectView()
        return proposal
      },
    }
    this.#approvalHost = new ApprovalHost({
      session: this.session, clock: this.#clock, idFactory: this.#idFactory,
      controller: options.executorApproval, telemetry: this.#telemetry,
      projectBlocking: () => this.#projectConfirmation?.pending === true || this.#projectConfirmation?.committing === true,
      displayName: () => this.#coding?.display_name ?? '执行器',
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      deliveryReady: () => this.#deliveryReady.set(),
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      retireProviderHostEventNow: eventId => this.#host.retireProviderHostEventNow(eventId),
      retireProviderHostEvent: eventId => this.#host.retireProviderHostEvent(eventId),
      removeQueuedPrompt: id => this.#host.removeQueuedExecutorApprovalPrompt(id),
      releaseQuestion: id => this.#host.releaseExecutorApprovalQuestion(id),
    })
    this.#coding = null
    for (const adapter of options.runtime.executors.values()) {
      if (adapter.manifest.roles.includes('coding')) {
        this.#coding = {channel: adapter.manifest.name, display_name: adapter.manifest.display_name ?? adapter.manifest.name}
        break
      }
    }
    this.#host = new HostDelivery({
      session: this.session, runtime: this.#runtime, clock: this.#clock,
      telemetry: this.#telemetry, approvalHost: this.#approvalHost,
      controlledPreemptiveAlertReconnect: this.#controlledPreemptiveAlertReconnect,
      clearingConversation: () => this.#clearingConversation,
      stopped: () => this.#stop.signal.aborted,
      providerFailed: () => this.#providerFailed,
      wake: () => this.#deliveryReady.set(),
      intakeFactEligible: (id, epoch) => this.#intake?.factEligible(id, epoch),
      executorPriority: channel => this.#executorPriority(channel),
      executorDisplayName: channel => this.#executorDisplayName(channel),
      idFactory: this.#idFactory, onDiagnostic: this.#onDiagnostic,
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      originCanReferenceProof: key => this.#continuations.originCanReferenceProof(key),
      originHasNonterminalReference: key => this.#continuations.originHasNonterminalReference(key),
    })
    const controllers = [...(options.agentControllers ?? [])]
    if (options.agentControllerFactory !== undefined) {
      const controller = options.agentControllerFactory.create({intake})
      this.#intake = controller.intake
      controllers.unshift(controller)
    }
    this.#agentRegistry = createAgentControllerRegistry({
      controllers,
      manifests: [...options.runtime.executors.values()].map(adapter => adapter.manifest),
    })
    if (!sameAgentDescriptors(this.#agentRegistry.descriptors, options.tools.agent_descriptors)) {
      throw new TypeError('agent controller registry does not match compiled tool descriptors')
    }
    this.#agentControllers = this.#agentRegistry.controllers
    this.#continuations = new ToolContinuations({
      session: this.session, host: this.#host, runtime: this.#runtime,
      bridge: this.#bridge, tools: this.#tools, intake: this.#intake, approvalHost: this.#approvalHost,
      coding: this.#coding, telemetry: this.#telemetry, idFactory: this.#idFactory,
      executorPriority: channel => this.#executorPriority(channel),
      executorDisplayName: channel => this.#executorDisplayName(channel),
      publishExecutorState: () => this.#publishExecutorState(),
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      wakeDelivery: () => this.#deliveryReady.set(),
      userOrigins: {
        itemForResponse: (epoch, response) => this.#userOrigins.itemForResponse(epoch, response),
        revisionForItem: (epoch, item) => this.#userOrigins.revisionForItem(epoch, item),
        originRefForItem: (epoch, item) => this.#userOrigins.originRefForItem(epoch, item),
        bindRetryResponse: input => this.#userOrigins.bindRetryResponse(input),
      },
      confirmTarget: event => this.#confirmTarget(event),
      isProjectConfirmationShadowItem: (epoch, item) => this.#isProjectConfirmationShadowItem(epoch, item),
      closeProjectConfirmationTool: event => this.#closeProjectConfirmationTool(event),
      handleProjectConfirmationDecision: (event, origin) => this.#handleProjectConfirmationDecision(event, origin),
      reconnectProviderSession: options => this.#reconnectProviderSession(options),
      deliveryPass: () => this.#deliveryPass(),
      recoverUncertainDelivery: failure => this.#recoverUncertainDelivery(failure),
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      awaitingUserOrigin: () => this.#awaitingUserOrigin,
      userOriginPreexistingResponseId: () => this.#userOriginPreexistingResponseId,
      discardedInputEpoch: () => this.#discardedInputEpoch,
      stopSignal: () => this.#stop.signal,
      intakeUser: () => this.#intakeUser,
      currentUserTurn: (event, origin) => this.#currentUserTurn(event, origin),
      agentController: name => this.#agentControllers.get(name),
    })
    this.#commitProjectOperation = options.commitProjectOperation
    this.#onProjectView = options.onProjectView
    this.#projectViewProvider = options.projectViewProvider
    this.#projectExpiryStepTimeoutMs = options.projectExpiryStepTimeoutMs
      ?? PROJECT_EXPIRY_STEP_TIMEOUT_S * 1_000

    // Subscribed at construction: a proposal can expire before anything else happens, and the observer
    // is the only notice of it.
    this.#unsubscribeProjectExpiry = options.projectConfirmation?.observeExpiry(() => {
      const proposalId = this.#projectConfirmation?.lifecycleId
      this.#projectConfirmationExpired()
      if (proposalId !== undefined && proposalId !== null) this.#intake?.decline(proposalId)
    }) ?? null
    this.#unsubscribeExecutorApproval = options.executorApproval?.observe(view => {
      this.#approvalHost.syncExecutorApproval(view)
    }) ?? null
    if (options.executorApproval !== undefined) this.#approvalHost.syncExecutorApproval(options.executorApproval.view)
  
    this.#projection = new ProviderProjection({
      session: this.session, runtime: this.#runtime, clock: this.#clock, coding: this.#coding,
      codingProgressNarration: this.#codingProgressNarration, telemetry: this.#telemetry,
      idFactory: this.#idFactory,
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      executorDisplayName: channel => this.#executorDisplayName(channel),
      publishExecutorState: () => this.#publishExecutorState(),
      resolveSyncResult: event => this.#continuations.resolveSyncResult(event),
      expireSyncResult: event => this.#continuations.expireSyncResult(event),
      hasSemanticAcknowledgement: id => this.#host.hasSemanticAcknowledgement(id),
      fenceSemanticAcknowledgement: delegate => this.#host.fenceSemanticAcknowledgement(delegate),
      retireDelegateHostEvents: delegate => this.#host.retireDelegateHostEvents(delegate),
      rememberDelegateHostEvent: (delegate, event) => this.#host.rememberDelegateHostEvent(delegate, event),
      rememberCodingProgressHostEvent: event => this.#host.rememberCodingProgressHostEvent(event),
      coalesceCodingProgress: () => {
        this.#host.coalesceCodingProgress()
      },
    })
}

  get executorState(): ExecutorState {
    return this.#executorState
  }

  agentNameForChannel(channel: string): string | null { return this.#agentRegistry.agentNameForChannel(channel) }

  onProjectWorkspaceChanged(workspaceId: string | null): void {
    this.#intake?.workspaceChanged(workspaceId)
  }

  get stopped(): boolean {
    return this.#stop.signal.aborted
  }

  /** True from the synchronous clear fence until a blank provider epoch is fully ready. */
  get clearingConversation(): boolean {
    return this.#clearingConversation
  }

  /** Clear the current conversation while leaving independently running executors alone. */
  clearConversation(): Promise<void> {
    if (this.#clearConversationOperation !== null) return this.#clearConversationOperation
    if (!this.#connected || this.stopped || this.#providerFailed) {
      return Promise.reject(new Error('realtime service is not available for conversation clear'))
    }

    // Publish single-flight ownership before playback/confirmation callbacks can reenter clear.
    const operation = Promise.resolve().then(() => this.#clearConversationAfterFence())
    this.#clearConversationOperation = operation

    // Install every externally visible fence before returning the Promise. Old provider input and
    // user authority must become unusable in the same synchronous turn as the clear request.
    this.#conversationClearRevision += 1
    this.#clearingConversation = true
    this.#host.pauseForConversationClear()
    const clearingGeneration = this.session.beginConversationClear()
    if (clearingGeneration !== null) this.#host.startPreemptiveAlertClearDeadline(clearingGeneration)
    this.#intake?.cancel()
    this.#intakeUser = null
    this.#host.releaseUrgentOwner()
    this.#invalidateProjectConfirmation('conversation_cleared')
    do {
      this.#approvalHost.invalidateExecutorApproval('conversation_cleared')
    } while (this.#approvalHost.pending)

    void operation.then(
      () => {
        if (this.#clearConversationOperation !== operation) return
        this.#clearConversationOperation = null
        this.#clearingConversation = false
        this.#host.resumeAfterConversationClear()
        this.#deliveryReady.set()
      },
      failure => {
        if (this.#clearConversationOperation !== operation) return
        this.#clearConversationOperation = null
        this.#onDiagnostic(
          `[realtime-diagnostic] conversation_clear_failed type=${diagnosticName(failure)}`,
        )
        // A failed durable clear or replacement cannot leave a live service silently dropping input.
        // Use the existing fatal lifecycle; a new service must reopen and revalidate its resources.
        this.#taskFailed(this.#stop)
      },
    )
    return operation
  }

  async #clearConversationAfterFence(): Promise<void> {
    // Normal ingress stays concurrent: a newer user turn must be able to supersede a pending tool.
    // The synchronous clear fence prevents new admissions while existing handlers settle.
    await Promise.allSettled([...this.#pendingIngress])
    await this.#reconnectLock.run(async () => {
        await this.#host.withDeliveryLock(async () => {
          if (this.#runtime.clearConversation === undefined) {
            throw new Error('runtime conversation clear is unavailable')
          }
          await this.#runtime.clearConversation()
          this.#resetConversationLedgers()
          await this.session.resetConversation({tools: structuredClone(this.#providerSchemas)})
          this.#userOrigins.beginEpoch(this.session.sessionEpoch)
          this.#clearCaptions()
          this.#publishExecutorState()
        })
      })
  }

  #subscribeCodingProgress(): void {
    if (this.#unsubscribeCodingProgress !== null) return
    this.#unsubscribeCodingProgress = this.#codingProgressNarration.observe(() => {
      this.#host.retireCodingProgress()
    })
  }

  async connect(): Promise<void> {
    this.#subscribeCodingProgress()
    if (this.#connected) return
    await this.session.connect({tools: structuredClone(this.#providerSchemas)})
    if (Number.isInteger(this.session.sessionEpoch) && this.session.sessionEpoch >= 0) {
      this.#userOrigins.beginEpoch(this.session.sessionEpoch)
    }
    this.#syncProjectConfirmationIsolation()
    this.#approvalHost.sync()
    this.#unsubscribe = this.#runtime.observe((event, currentConversation = true) => {
      this.projectRuntimeEvent(event, currentConversation)
    })
    this.#connected = true
  }

  /**
   * Start the three long-lived loops.
   *
   * Idempotent by design: `start` is called from more than one place during bring-up, and a second
   * set of loops would consume the same provider stream twice.
   */
  async start(): Promise<void> {
    await this.connect()
    if (this.#tasks.length > 0) return
    // A fresh controller: an aborted one cannot be reused, and `start` after `close` has to work.
    // Each guard is handed the controller it belongs to, so a task abandoned by an earlier close
    // cannot report a failure against the run that replaced it.
    const run = new AbortController()
    this.#stop = run
    const signal = run.signal
    this.#tasks = [
      this.#guardTask(this.#receiveLoop(signal), run),
      this.#guardTask(this.#deliveryLoop(signal), run),
      this.#guardTask(this.#runtime.serve(signal), run),
    ]
  }

  /**
   * Stop everything, and surface a provider close failure rather than swallowing it.
   *
   * The order matters. State that could authorize new work is cleared *before* awaiting anything, so
   * a task still running during the await cannot act on it. The provider close is attempted even if
   * that clearing threw, and its own failure is held and re-raised after every task has been
   * cancelled -- a close that failed still has to leave the service stopped.
   */
  async close(): Promise<void> {
    this.#unsubscribeCodingProgress?.()
    this.#unsubscribeCodingProgress = null
    this.#stop.abort()
    this.#invalidateProjectConfirmation('service_closed')
    this.#approvalHost.invalidateExecutorApproval('service_closed')
    if (this.#unsubscribeProjectExpiry !== null) {
      this.#unsubscribeProjectExpiry()
      this.#unsubscribeProjectExpiry = null
    }
    if (this.#unsubscribeExecutorApproval !== null) {
      this.#unsubscribeExecutorApproval()
      this.#unsubscribeExecutorApproval = null
    }
    this.#projectExpiryBatches.length = 0
    // The drain is shutdown-owned work. A promise cannot be cancelled, so its continuations check the
    // signal instead -- and this waits, bounded, so a reconnect cannot land after `close` returned.
    const draining = this.#projectExpiryDraining
    this.#host.close()
    this.#deliveryReady.set()
    if (this.#unsubscribe !== null) {
      this.#unsubscribe()
      this.#unsubscribe = null
    }
    // Held rather than propagated immediately: a close that failed still has to leave every task
    // cancelled and the service marked disconnected, so the failure is re-raised only after that.
    let closeFailure: {readonly cause: unknown} | null = null
    let closeAbandoned = false
    try {
      // Bounded like the loops are. A transport that never finishes closing would otherwise block
      // application shutdown forever, which is exactly the failure mode a degraded transport has.
      closeAbandoned = !await resolvedWithin(this.#provider.close(), SHUTDOWN_GRACE_MS)
    } catch (cause) {
      closeFailure = {cause}
    }
    if (closeAbandoned) {
      this.#onDiagnostic('[realtime-diagnostic] shutdown_provider_close_abandoned')
    }
    const backgroundTasks = [
      ...this.#tasks,
      ...this.#host.retirementTasks(),
      ...this.#approvalHost.pendingTasks,
      ...this.#host.acknowledgementReleaseTasks(),
      ...this.#projectConfirmationCarrierReleaseTasks,
    ]
    const tasks = draining === null ? backgroundTasks : [...backgroundTasks, draining]
    this.#tasks = []
    // Bounded. A promise cannot be cancelled from outside the way an asyncio task can, so a loop that
    // ignores the abort would make `close` wait forever -- and a service that never finishes closing
    // is worse than one that reports a task it could not stop. The loops all observe the signal, so
    // reaching the timeout means one of them is genuinely stuck.
    const abandoned = await settleWithin(tasks, SHUTDOWN_GRACE_MS)
    this.#connected = false
    if (abandoned > 0) {
      this.#onDiagnostic(
        `[realtime-diagnostic] shutdown_tasks_abandoned count=${abandoned}`,
      )
    }
    if (closeFailure !== null) throw asError(closeFailure.cause)
  }

  #inputController = new AbortController()
  #inputReady: Promise<void> | null = null
  readonly #inputChanged = new Signal()
  #discardedInputEpoch = -1

  /** Replace only the provider session; host work remains owned by the existing graph. */
  discardInputAudio(): Promise<void> {
    // A phone-owned provider may still be awaiting its first successful SDK handshake.
    if (!this.#connected) return Promise.resolve()
    this.#inputController.abort()
    this.#inputController = new AbortController()
    this.#discardedInputEpoch = this.session.sessionEpoch
    // Serialize repeated disconnects, including one during a pending replacement. A failed
    // replacement deliberately leaves this barrier rejected so subsequent input stays closed.
    const previous = this.#inputReady
    const replace = async () => {
      this.#discardedInputEpoch = this.session.sessionEpoch
      await this.#reconnectProviderSession({reason: 'client_disconnect'})
    }
    const ready = previous === null ? replace() : previous.then(replace, replace)
    this.#inputReady = ready
    this.#inputChanged.set()
    void ready.catch(() => undefined)
    return ready
  }

  async transcribeDraft(pcm: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!this.#provider.transcribeDraft) throw new Error('dictation unavailable')
    return this.#provider.transcribeDraft(pcm, AbortSignal.any([signal, this.#inputController.signal]))
  }

  async submitText(text: string): Promise<void> {
    const controller = this.#inputController
    if (this.#inputReady !== null) await this.#inputReady
    if (controller.signal.aborted || !this.#provider.submitText) throw new Error('text input unavailable')
    await this.#provider.submitText(text, controller.signal)
  }

  async sendAudio(pcm: Uint8Array): Promise<void> {
    if (this.#clearingConversation) return
    const controller = this.#inputController
    if (this.#inputReady !== null) await this.#inputReady
    if (controller.signal.aborted || this.#clearingConversation) return
    await this.#provider.sendAudio(pcm, controller.signal)
  }

  async localSpeechOnset(speechId: string): Promise<void> {
    if (this.#clearingConversation) return
    if (speechId !== this.#lastLocalSpeechOnsetId) {
      this.#lastLocalSpeechOnsetId = speechId
      this.#localSpeechOnsetRevision += 1
    }
    this.#intake?.userInputStarted()
    this.#approvalHost.noteExecutorApprovalOnsetBeforeContext()
    const generation = this.session.currentGeneration
    if (generation !== null) {
      const key = callKey(generation.session_epoch, generation.response_id)
      this.#host.rememberLocalSpeechInterruption(key)
    }
    this.#approvalHost.releaseQuestionOnOnset()
    await this.session.localSpeechOnset(speechId)
  }

  /** Settle the exact proposal shown by the renderer; the controller remains the sole authority. */
  projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void> {
    return this.#trackIngress(() => this.#projectConfirmationDecision(proposalId, confirmed))
  }

  async #projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void> {
    const controller = this.#projectConfirmation
    const lifecycleId = controller?.lifecycleId ?? 'none'
    this.#telemetry?.record('project_confirmation.ui_decision_requested', {
      proposal_id: proposalId,
      confirmed,
      lifecycle_id: lifecycleId,
    })
    if (controller === undefined) return
    const outcome = controller.acceptDirectDecision({proposalId, confirmed})
    if (outcome.kind === 'cancelled') this.#intake?.decline(proposalId)
    if (outcome.kind === 'ignored') {
      this.#telemetry?.record('project_confirmation.ui_decision_refused', {
        proposal_id: proposalId,
        reason: 'stale_or_not_pending',
      })
      return
    }
    this.#publishProjectView()

    // A click wins the same one-shot authority race as a function call. Close every voice carrier
    // before awaiting commit I/O so a late provider call cannot act on the settled proposal.
    const reserved = this.#projectConfirmationIsolation.reservation
    const items = reserved === null
      ? []
      : [{sessionEpoch: reserved.sessionEpoch, id: reserved.itemId}]
    const retry = this.#projectConfirmationDecisionRetry
    const reconnectOutstandingRetry = retry?.requested === true
      && retry.retry_response_id === null
      && parseCallKey(retry.item_key).sessionEpoch === this.session.sessionEpoch
    if (reconnectOutstandingRetry) {
      this.#projectConfirmationPendingQuarantineEpoch = this.session.sessionEpoch
    }
    for (const item of items) this.#beginProjectConfirmationClose(item.sessionEpoch, item.id)
    if (reconnectOutstandingRetry) {
      this.#projectConfirmationPendingQuarantineEpoch = this.session.sessionEpoch
    }
    await this.#quarantineProjectConfirmationResponses(this.session.sessionEpoch)

    let state = outcome.kind === 'confirmed' ? 'accepted' : 'refused'
    let text = outcome.response_text
    let expiryOwnsFact = false
    try {
      for (const item of items) await this.#closeConfirmationDeferredCalls(item.id)
      if (outcome.kind === 'confirmed' && outcome.operation !== null) {
        const committed = await this.#commitConfirmedProjectOperation(outcome.operation)
        state = committed.state
        text = committed.text
        expiryOwnsFact = committed.expiryOwnsFact
      }
      if (reconnectOutstandingRetry) {
        try {
          await this.#reconnectProviderSession({
            reason: 'project_confirmation_ui_retry',
            expectedEpoch: this.session.sessionEpoch,
          })
        } catch (failure) {
          this.#reportDeliveryFailure(failure instanceof RealtimeDeliveryError
            ? failure
            : new RealtimeDeliveryError(String(failure)))
        }
      }
    } finally {
      for (const item of items) this.#endProjectConfirmationClose(item.sessionEpoch, item.id)
      this.#projectConfirmationShadowItems.clear()
      this.#projectConfirmationClosingItems.clear()
      this.#projectConfirmationDecisionRetry = null
      this.#projectConfirmationIsolation.setResponseFencePending(false)
    }
    // Expiry publishes through its observer-owned cleanup batch. Queuing here as well would create
    // two differently keyed host facts for the same deadline transition.
    if (outcome.kind !== 'expired' && !expiryOwnsFact && text !== null && text !== '') {
      this.#queueProjectConfirmationFact(
        text,
        lifecycleId,
        `ui-decision:${outcome.kind}:${state}`,
      )
    }
    this.#publishProjectView()
    this.#telemetry?.record('project_confirmation.ui_decision_completed', {
      proposal_id: proposalId,
      outcome: outcome.kind,
      state,
    })
  }

  /** Renderer clicks are direct local-user authority on the same one-shot controller as voice. */
  executorApprovalDecision(approvalId: string, approved: boolean, scope?: 'session'): boolean {
    if (this.#clearingConversation) return false
    return this.#approvalHost.executorApprovalDecision(approvalId, approved, scope)
  }

  async waitStopped(): Promise<void> {
    await Promise.allSettled(this.#tasks)
  }

  /**
   * Deliver everything the floor currently allows.
   *
   * The public entry point. It exists to translate an uncertain delivery into a reconnect attempt;
   * the reconnect path itself must call `#deliveryPass` instead, or it would re-enter here while
   * holding the reconnect lock.
   */
  async flushHostItems(): Promise<void> {
    try {
      await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        await this.#recoverUncertainDelivery(cause)
        return
      }
      throw cause
    }
  }

  /**
   * An injection whose outcome the provider never confirmed.
   *
   * Retried exactly once per item, and never for a recovery item -- a recovery injection is what a
   * reconnect *is*, so retrying it through another reconnect would recurse. A second uncertainty for
   * the same item means the transport cannot be trusted to report anything, and the service stops
   * rather than guessing whether the model has seen a fact.
   */
  async #recoverUncertainDelivery(failure: ItemDeliveryUncertainError): Promise<void> {
    if (failure.item_kind === 'recovery') {
      this.#failUncertainDelivery()
      return
    }
    if (!this.#host.admitUncertainDeliveryRetry(failure.host_item_id)) {
      this.#failUncertainDelivery()
      return
    }
    try {
      const reconnected = await this.#reconnectProviderSession({
        reason: 'uncertain_delivery',
        expectedEpoch: failure.session_epoch,
      })
      if (!reconnected) await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        this.#failUncertainDelivery()
        return
      }
      throw cause
    }
  }

  #failUncertainDelivery(): void {
    this.#onDiagnostic('[realtime-diagnostic] uncertain_delivery_exhausted')
    this.#providerFailed = true
    this.#host.releaseFailedDelivery()
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  /**
   * One pass over the queue, under the delivery lock.
   *
   * The stale-hold release happens first and unconditionally: a user hold that has outlived its
   * window blocks every delivery, so checking it after the floor test would let one abandoned hold
   * stall the queue indefinitely.
   *
   * The continuation re-drive at the end is the subtle part. A preempt that was armed and is no
   * longer armed means the thing blocking continuations has cleared, and nothing else will notice --
   * so this pass has to hand off. It happens *outside* the lock because the continuation drive takes
   * its own, and CP3 says the two are never held together.
   */
  async #deliveryPass(): Promise<void> {
    if (await this.#host.deliveryPass()) await this.driveContinuations()
  }

  /** Blank dead-epoch speculative text on both roles after a reconnect. */
  #clearCaptions(): void {
    this.session.resetCaptions()
    if (this.#onCaption !== undefined) {
      this.#onCaption({role: 'assistant', text: '', final: true})
      this.#onCaption({role: 'user', text: '', final: true})
    }
  }

  /** Drop every service projection that could make the fresh provider epoch describe old dialogue. */
  #resetConversationLedgers(): void {
    this.#host.resetDelivery()
    this.#host.resetUncertainDeliveryRetries()
    this.#continuations.resetCalls()
    this.#host.resetAcknowledgements()
    this.#audioStarted.clear()
    this.#continuations.resetDeferredAndSync()
    this.#projectConfirmationIsolation.invalidate()
    this.#projectConfirmationShadowItems.clear()
    this.#projectConfirmationClosingItems.clear()
    this.#projectConfirmationCarrierReconnectAfterUser.clear()
    this.#projectConfirmationPendingQuarantineEpoch = null
    this.#projectConfirmationClosingCalls.clear()
    this.#projectConfirmationDecisionGates.clear()
    this.#projectConfirmationClosedCalls.clear()
    this.#projectConfirmationDecisionRetry = null
    this.#projectConfirmationCommittingLifecycles.clear()
    this.#projectConfirmationExpiryFactOwners.clear()
    this.#projectExpiryBatches.length = 0
    this.#projection.reset()
    this.#host.resetOriginProofs()
    this.#awaitingUserOrigin = false
    this.#userOriginPreexistingResponseId = null
    this.#intakeUser = null
    this.#localSpeechOnsetRevision = 0
    this.#lastLocalSpeechOnsetId = null
    this.#deliveryReady.clear()
  }

  /** A channel's manifest priority, or the default when there is no manifest for it. */
  #executorPriority(channel: string | null): number {
    if (channel === null) return 50
    return this.#runtime.executors.get(channel)?.manifest.policy.priority ?? 50
  }

  /**
   * Replace the provider session, and reconcile everything that referred to the old one.
   *
   * Ported from `_reconnect_provider_session`. The whole method runs under `#reconnectLock`, and the
   * two things that look like implementation detail are both load-bearing:
   *
   * The source epoch is armed *before* the await, so a preemptive alert already waiting on the session's
   * response-request lock can see that the provider identity advanced even if it runs before this
   * resumes. Arming it after would let that alert act against a session that no longer exists.
   *
   * The tail calls the private `#deliveryPass` rather than the public `flushHostItems`. The public
   * wrapper turns an uncertain delivery into a reconnect, and reconnecting while already holding the
   * lock would deadlock. Confirmation uncertainty is meant to escape to the caller here.
   *
   * Returns false when the epoch moved while waiting for the lock: someone else already replaced the
   * session, and doing it again would discard a *live* one.
   */
  async #reconnectProviderSession(
    options: {readonly reason: ProviderReconnectReason; readonly expectedEpoch?: number},
  ): Promise<boolean> {
    const requestedEpoch = options.expectedEpoch ?? this.session.sessionEpoch
    this.#telemetry?.record('provider.reconnect', {reason: options.reason, outcome: 'started'})
    try {
      return await this.#reconnectLock.run(async () => {
        if (this.session.sessionEpoch !== requestedEpoch) {
          this.#telemetry?.record('provider.reconnect', {
            reason: options.reason,
            outcome: 'skipped_epoch',
          })
          return false
        }
        const oldEpoch = this.session.sessionEpoch
        this.#invalidateProjectConfirmation('provider_replaced')
        this.#approvalHost.invalidateExecutorApproval('provider_replaced')
        this.#host.beginReconnect(oldEpoch)
        await this.session.reconnect({tools: structuredClone(this.#providerSchemas)})
        // Only if nothing cleared it while we were awaiting. A user who started speaking during the
        // reconnect has already activated the new session, so demanding an activation would be wrong.
        this.#host.finishReconnect(oldEpoch)
        const retryOwner = this.#host.currentUrgentOwner

        // Every origin binding named items in a session that is gone. Keeping any of it would let a
        // tool call cite evidence the new provider has never seen.
        this.#awaitingUserOrigin = false
        this.#userOriginPreexistingResponseId = null
        this.#userOrigins.beginEpoch(this.session.sessionEpoch)
        this.#continuations.clearDeferred()

        this.#host.releaseUrgentHostResponseForEpoch(oldEpoch)
        // An urgent item that was injected but never got a response is the one case worth retrying: it
        // was delivered into a session that died before speaking it, so the user heard nothing. One that
        // *did* get a response was taken up by the provider, and re-queueing would say it twice.
        if (retryOwner?.session_epoch === oldEpoch && retryOwner.response_id === null) {
          this.#host.requeueHostItem(retryOwner.queued)
        }
        this.#clearCaptions()
        this.#audioStarted.clear()
        this.#continuations.reconcileToolStateAfterReconnect(oldEpoch)
        this.#host.reopenFailedSemanticAcknowledgements()
        this.#host.reconcileSemanticAcknowledgementsAfterReconnect()
        await this.driveContinuations()
        await this.#deliveryPass()
        this.#telemetry?.record('provider.reconnect', {
          reason: options.reason,
          outcome: 'completed',
        })
        return true
      })
    } catch (failure) {
      this.#telemetry?.record('provider.reconnect', {reason: options.reason, outcome: 'failed'})
      throw failure
    }
  }

  /** Live host preference: switching never stops or restarts executor work. */
  setCodingProgressNarration(mode: CodingProgressNarration): void { this.#codingProgressNarration.setMode(mode) }

  /**
   * Consume the provider stream until it ends or the service stops.
   *
   * The epoch filter is the first thing in the loop and it is not redundant with the session's own:
   * `events()` already drops mismatched events, and dropping them again here is what makes a
   * reconnect that happens *while* an event is in flight safe.
   *
   * The outer loop distinguishes three endings. A stopped service or a failed provider returns. An
   * epoch that changed means a reconnect replaced the stream, so it re-subscribes. A stream that
   * ended having yielded nothing is a provider that is simply gone.
   */
  async #receiveLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const streamEpoch = this.session.sessionEpoch
      let received = false
      // The signal goes to the provider: at shutdown the stream is normally parked with nothing to
      // say, and an iterator suspended in `await` cannot be stopped from out here.
      for await (const event of this.#provider.events(signal)) {
        if (signal.aborted) return
        if (event.session_epoch <= this.#discardedInputEpoch) continue
        if (event.session_epoch !== this.session.sessionEpoch) continue
        received = true
        try {
          await this.handleEvent(event)
        } catch (cause) {
          if (cause instanceof ItemDeliveryUncertainError) {
            await this.#recoverUncertainDelivery(cause)
          } else if (cause instanceof RealtimeDeliveryError) {
            this.#reportDeliveryFailure(cause)
          } else {
            throw cause
          }
        }
        if (this.#stop.signal.aborted) return
      }
      if (this.#stop.signal.aborted || this.#providerFailed) return
      if (streamEpoch <= this.#discardedInputEpoch && this.#inputReady !== null) {
        while (!signal.aborted) {
          const ready: Promise<void> = this.#inputReady
          try {
            await ready
            if (ready === this.#inputReady) break
          } catch {
            // Stay fail-closed until another remote disconnect requests a replacement.
            this.#inputChanged.clear()
            if (ready === this.#inputReady) await this.#inputChanged.wait(signal)
          }
        }
        if (this.#stop.signal.aborted) return
      }
      // Reconnect closes the old iterator before connect/observers publish the new session epoch.
      // Join that transition before deciding an ended stream means the provider disappeared.
      await this.#reconnectLock.run(() => Promise.resolve())
      if (this.#stop.signal.aborted || this.#providerFailed) return
      if (this.session.sessionEpoch !== streamEpoch) continue
      if (!received) return
    }
  }

  /**
   * Deliver queued host items whenever something signals there may be work.
   *
   * A delivery failure is reported and the loop continues: one item the provider refused must not
   * take down the loop that would deliver the next one.
   */
  async #deliveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // Raced against the signal, not just checked after: the wait is where this loop spends almost
      // all of its time, and a latch nobody sets again would hold it past shutdown.
      await this.#deliveryReady.wait(signal)
      this.#deliveryReady.clear()
      if (signal.aborted) return
      try {
        await this.flushHostItems()
        // R105: a sync resolution may have made a held batch ready. The drive is reentrancy-safe --
        // it early-returns while a batch is requested or bound.
        await this.driveContinuations()
      } catch (cause) {
        if (cause instanceof RealtimeDeliveryError) {
          this.#reportDeliveryFailure(cause)
        } else {
          throw cause
        }
      }
    }
  }

  /**
   * Ingest one provider event.
   *
   * The shape is a sequence of `if isinstance` blocks in the oracle and stays one here, deliberately:
   * a single event can be several things at once to this layer -- a `ResponseStarted` binds a user
   * origin *and* a semantic acknowledgement *and* a continuation -- so a switch that ran one arm per
   * event would have to duplicate the shared tail.
   *
   * Two events never reach the session at all. A cancel rejection is routed by response ownership:
   * confirmation carriers recover their provider epoch, while every other rejection is the preemptive alert's to
   * arbitrate. A provider error is about the transport rather than the conversation.
   *
   * The tail is the part worth reading twice: after everything an event implies has been recorded,
   * continuations are driven (only if the session accepted it -- a rejected event changed nothing to
   * speak about) and then a delivery pass runs unconditionally, because the floor may have opened even
   * for an event the session refused.
   */
  handleEvent(event: RealtimeProviderEvent): Promise<void> {
    return this.#trackIngress(() => this.#handleEvent(event))
  }

  #trackIngress(action: () => Promise<void>): Promise<void> {
    if (this.#clearingConversation) return Promise.resolve()
    // Register before invoking callbacks so a reentrant clear also joins this handler.
    const operation = Promise.resolve().then(async () => {
      if (!this.#clearingConversation) await action()
    })
    this.#pendingIngress.add(operation)
    void operation.then(
      () => { this.#pendingIngress.delete(operation) },
      () => { this.#pendingIngress.delete(operation) },
    )
    return operation
  }

  async #handleEvent(event: RealtimeProviderEvent): Promise<void> {
    if (event.session_epoch <= this.#discardedInputEpoch) return
    this.#syncProjectConfirmationIsolation()
    if (event.kind === 'response_cancel_rejected') {
      if (this.#projectConfirmationIsolation.responseState({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })?.quarantined === true) {
        await this.#recoverProjectConfirmationCarrier(
          event.session_epoch,
          event.response_id,
          'cancel_rejected',
        )
        return
      }
      // The provider kept speaking through a preemption. The preemptive-alert arbiter owns it, and it does not reach
      // the session at all: this is about the transport, not the conversation.
      await this.#handlePreemptiveAlertCancelRejected(event)
      return
    }
    if (event.kind === 'provider_error') {
      await this.session.accept(event)
      this.#onDiagnostic(
        `[realtime-diagnostic] provider_error code=${event.code} recoverable=${event.recoverable}`,
      )
      if (event.recoverable) {
        await this.#reconnectProviderSession({
          reason: 'recoverable_provider_error',
          expectedEpoch: this.session.sessionEpoch,
        })
        this.#clearCaptions()
      } else {
        this.#providerFailed = true
        this.#approvalHost.invalidateExecutorApproval('provider_failed')
        this.#host.releaseUrgentOwner()
        this.#host.releasePreemptionAfterFailure()
        this.#stop.abort()
      }
      return
    }

    const approvalEvent = this.#approvalHost.beforeEvent(event)
    if (this.#telemetry !== undefined) {
      if (event.kind === 'response_audio_delta') {
        // First delta only: the metric is time-to-first-audio, and recording every delta would make
        // it a throughput counter instead.
        if (!this.#audioStarted.has(event.response_id)) {
          this.#audioStarted.add(event.response_id)
          this.#telemetry.record('provider.first_audio_delta', {response_id: event.response_id})
        }
      } else if (event.kind === 'response_terminal') {
        this.#audioStarted.delete(event.response_id)
      }
    }

    // Captured before `accept`, because a terminal is what *removes* the owner's response and the
    // release below needs to know which owner this terminal belonged to.
    const terminalOwner = event.kind === 'response_terminal'
      ? this.#host.urgentOwnerForResponse(event.session_epoch, event.response_id)
      : null

    // A tool call in a turn that is meant to be waiting for a confirmation is refused before the
    // session sees it: letting it through would have the model acting inside the very turn whose answer
    // it is supposed to be waiting for.
    const confirmTarget = event.kind === 'tool_call_ready' ? this.#confirmTarget(event) : null
    const isConfirmationDecision = confirmTarget === 'project'
    const blockedConfirmationTool = event.kind === 'tool_call_ready'
      && this.#blocksProjectConfirmationTool(event)
      && !isConfirmationDecision
    const isExecutorApprovalDecision = confirmTarget === 'approval'
    const blockedExecutorApprovalTool = event.kind === 'tool_call_ready'
      && this.#approvalHost.blocksExecutorApprovalTool(event)
      && !isExecutorApprovalDecision
    // An automatic provider may create the response that will emit the confirmation function before VAD reports
    // speech end. That response is an authorization carrier, not an audible assistant turn. Let it
    // acquire an origin while the user still owns the floor, but never bypass the one-shot fence for
    // a stale host-requested confirmation question.
    const confirmationFencePendingAtStart = this.#projectConfirmationIsolation.responseFencePending
    const confirmationResponseStartsDuringSpeech = event.kind === 'response_started'
      && event.session_epoch === this.session.sessionEpoch
      && this.session.floor.state === 'user_speaking'
      && !this.#projectConfirmationIsolation.responseFencePending
      && this.#projectConfirmationIsolation.reservation?.sessionEpoch === event.session_epoch
    const accepted = blockedConfirmationTool || blockedExecutorApprovalTool
      ? false
      : await this.session.accept(event, {
          allowResponseStartDuringUserSpeech: confirmationResponseStartsDuringSpeech
            || approvalEvent.responseStartsDuringSpeech
            || approvalEvent.orphanedExecutorRetryCandidate,
        })
    const executorQuarantinedResponse = await this.#approvalHost.afterEventAccepted(event, accepted, approvalEvent)
    if (
      event.kind === 'response_started'
      && this.#projectConfirmationPendingQuarantineEpoch === event.session_epoch
    ) {
      this.#projectConfirmationPendingQuarantineEpoch = null
      this.#projectConfirmationIsolation.markBlockedResponse({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })
      this.#projectConfirmationIsolation.markQuarantined({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })
      this.session.suppressResponse(event.response_id)
    }
    if (
      event.kind === 'response_started'
      && event.session_epoch === this.session.sessionEpoch
      && this.#projectConfirmationIsBlocking()
    ) {
      // A fenced pre-start response is the stale question the user interrupted, not the response to
      // their answer. It spends the one-shot fence but must not bind or release the reserved item.
      if (accepted) {
        this.#projectConfirmationIsolation.markBlockedResponse({
          sessionEpoch: event.session_epoch,
          responseId: event.response_id,
        })
        if (this.#userOrigins.itemForResponse(event.session_epoch, event.response_id) === undefined) {
          if (!this.#bindProjectConfirmationRetryResponse(event.session_epoch, event.response_id)) {
            this.#bindResponseUserOrigin(event.session_epoch, event.response_id)
          }
        }
        this.#bindProjectConfirmationResponse(event.session_epoch, event.response_id)
        if (confirmationResponseStartsDuringSpeech) {
          // The provider may now finish its structured function call, but it must not start talking
          // after the user's floor opens. The deterministic confirmation fact remains the reply owner.
          this.session.suppressResponse(event.response_id)
        }
      }
      // The armed fence has been spent by this response, so it no longer holds the block open.
      this.#projectConfirmationIsolation.setResponseFencePending(false)
    }
    if (
      event.kind === 'response_started'
      && this.#projectConfirmationIsolation.reservation?.sessionEpoch === event.session_epoch
    ) {
      this.#telemetry?.record('project_confirmation.response_started', {
        session_epoch: event.session_epoch,
        response_id: event.response_id,
        accepted,
        started_during_user_speech: confirmationResponseStartsDuringSpeech,
        fence_pending: confirmationFencePendingAtStart,
        origin_bound: accepted
          && this.#userOrigins.itemForResponse(event.session_epoch, event.response_id) !== undefined,
        confirmation_item_count: this.#projectConfirmationIsolation.reservation === null ? 0 : 1,
        proposal_id: this.#projectConfirmation?.lifecycleId ?? 'none',
        proposal_origin_ref: this.#projectConfirmation?.proposalOriginRef ?? 'none',
        delegate_origin_ref: this.#projectConfirmation?.proposalOriginRef ?? 'none',
        user_input_revision: this.session.providerTurnUserInputRevision(event.response_id) ?? -1,
        item_id: this.#userOrigins.itemForResponse(
          event.session_epoch,
          event.response_id,
        ) ?? 'none',
      })
    }
    if (event.kind === 'response_started' || event.kind === 'response_audio_delta') {
      this.#host.learnPreemptedResponse(event)
      this.#host.recordPreemptiveAlertCancelSent(event.response_id)
    }
    // Unconditional, and before the accepted-only work: a fence receipt is destructive to read, so it
    // has to be consumed on every event or a later one would see a stale interruption.
    this.#host.retireFencedPrestartUrgent()
    if (accepted && (event.kind === 'response_started' || event.kind === 'response_audio_delta')) {
      this.#host.bindUrgentHostResponse(event)
      this.#host.finishPreemptiveAlertFirstAudio(event)
    }

    if (event.kind === 'response_started' && accepted) {
      // Only for a response with no events yet: one that already has them has been bound, and
      // rebinding would take a second user turn for the same response.
      if (this.session.responseEventIds(event.response_id).length === 0) {
        this.#bindResponseUserOrigin(event.session_epoch, event.response_id)
      }
      this.#host.suppressCancelledSemanticAcknowledgement(event.response_id)
      this.#host.bindRequestedSemanticAcknowledgement(event.response_id)
      this.#continuations.bindContinuation(event.response_id)
      this.#continuations.bindToolContinuationOrigin(event.session_epoch, event.response_id)
      this.#suppressShadowConfirmationResponse(event.session_epoch, event.response_id)
    }
    if (event.kind === 'response_started') {
      this.#telemetry?.record('provider.response_started', {
        session_epoch: event.session_epoch,
        response_id: event.response_id,
        accepted,
        user_input_revision: this.session.providerTurnUserInputRevision(event.response_id) ?? -1,
        item_id: this.#userOrigins.itemForResponse(
          event.session_epoch,
          event.response_id,
        ) ?? 'none',
      })
    }

    if (this.#onCaption !== undefined) {
      const caption = this.session.captionFor(
        event,
        event.kind === 'user_transcript_final' ? {accepted} : undefined,
      )
      if (caption !== null) this.#onCaption(caption)
    }

    if (event.kind === 'user_speech_started' && accepted) {
      this.#intake?.userInputStarted()
      this.#host.acceptUserActivation(event.session_epoch)
      this.#host.revokePreemptiveReconnect()
      // An automatic provider may finish its function call before emitting this turn's transcript final. Do not let
      // that call bind to provider-authored placeholder text or the previous user turn.
      this.#awaitingUserOrigin = true
      this.#userOriginPreexistingResponseId = this.session.activeProviderResponseId
      if (event.provider_item_id !== null) {
        this.#rememberUnboundUserOrigin(
          event.session_epoch,
          this.session.userInputRevision,
          event.provider_item_id,
        )
      }
      this.#approvalHost.noteExecutorApprovalOnsetBeforeContext()
      this.#approvalHost.releaseQuestionOnOnset()
      await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.provider_item_id)
      this.#reserveProjectConfirmation(event)
    }
    if (
      event.kind === 'user_speech_ended'
      && accepted
      && event.provider_item_id !== null
    ) {
      this.#rememberUnboundUserOrigin(
        event.session_epoch,
        this.session.userInputRevision,
        event.provider_item_id,
      )
      await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.provider_item_id)
      await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
    }

    if (event.kind === 'response_terminal' && accepted) {
      this.#approvalHost.noteTerminal(event)
      this.#host.recordPreemptiveAlertCancelTerminal(event)
      const generation = this.session.currentGeneration
      if (
        generation !== null
        && generation.session_epoch === event.session_epoch
        && generation.response_id === event.response_id
      ) {
        this.#onProviderTerminal(generation)
      }
      this.#host.finishSemanticAcknowledgement(event)
      this.#continuations.finishContinuation(event)
      this.#continuations.finishOrigin(event.response_id)
      const itemId = this.#userOrigins.itemForResponse(event.session_epoch, event.response_id)
      if (
        itemId !== undefined
        && this.#isProjectConfirmationItem(event.session_epoch, itemId)
      ) {
        const controller = this.#projectConfirmation
        const itemKey = callKey(event.session_epoch, itemId)
        const retry = this.#projectConfirmationDecisionRetry
        const isRetryTerminal = retry?.item_key === itemKey
          && retry.retry_response_id === event.response_id
        // A transport-level cancelled/failed terminal can be just as empty as completed. What
        // matters at this boundary is whether the response supplied any audible decision, not the
        // provider's terminal label.
        const silentTerminal = !this.session.responseHasSpoken(event.response_id)
        this.#telemetry?.record('project_confirmation.response_terminal', {
          session_epoch: event.session_epoch,
          response_id: event.response_id,
          item_id: itemId,
          status: event.status,
          transcript_ready: this.#userOrigins.hasOriginRef(event.session_epoch, itemId),
          decision_seen: false,
          retry_attempt: isRetryTerminal ? 1 : 0,
          user_input_revision: this.#userOrigins.revisionForItem(
            event.session_epoch,
            itemId,
          ) ?? -1,
          proposal_id: controller?.lifecycleId ?? 'none',
          proposal_origin_ref: controller?.proposalOriginRef ?? 'none',
          delegate_origin_ref: controller?.proposalOriginRef ?? 'none',
        })
        if (silentTerminal && controller?.pending === true && !isRetryTerminal) {
          this.#projectConfirmationDecisionRetry ??= {
            item_key: itemKey,
            source_response_id: event.response_id,
            requested: false,
            retry_response_id: null,
          }
          await this.#maybeRequestProjectConfirmationDecisionRetry(event.session_epoch, itemId)
        } else {
          controller?.releaseUndecided({epoch: event.session_epoch, itemId})
          this.#endProjectConfirmationItem(event.session_epoch, itemId)
          if (isRetryTerminal) {
            this.#telemetry?.record('project_confirmation.decision_retry_exhausted', {
              session_epoch: event.session_epoch,
              item_id: itemId,
              response_id: event.response_id,
              proposal_id: controller?.lifecycleId ?? 'none',
              proposal_origin_ref: controller?.proposalOriginRef ?? 'none',
              delegate_origin_ref: controller?.proposalOriginRef ?? 'none',
              user_input_revision: this.#userOrigins.revisionForItem(
                event.session_epoch,
                itemId,
              ) ?? -1,
              reason: 'no_confirmation_function',
            })
          }
        }
      }
      await this.#approvalHost.settleTerminal(event)
      if (itemId !== undefined) {
        this.#projectConfirmationShadowItems.delete(callKey(event.session_epoch, itemId))
      }
      // Released only when the terminal is *not* the current generation: if it is, playback is still
      // running and the owner is what keeps the alert's audio attributable.
      if (
        generation?.session_epoch !== event.session_epoch
        || generation.response_id !== event.response_id
      ) {
        this.#host.releaseUrgentHostResponse(terminalOwner)
      }
      this.#host.markPreemptiveAlertReplacementTerminal(terminalOwner)
    }
    if (event.kind === 'response_terminal' && executorQuarantinedResponse) {
      await this.#approvalHost.finishPendingExecutorApprovalResponseQuarantine(
        event.session_epoch,
        event.response_id,
      )
    }

    if (event.kind === 'user_transcript_final') {
      if (accepted) {
        const localOnsetRevision = this.#localSpeechOnsetRevision
        // A delayed final still belongs to its original VAD item, not a newer speech onset.
        const inputRevision = this.#userOrigins.revisionForItem(event.session_epoch, event.item_id)
          ?? this.session.userInputRevision
        this.#host.acceptUserActivation(event.session_epoch)
        if (this.#userOrigins.revisionForItem(event.session_epoch, event.item_id) === undefined) {
          // Some realtime transports can deliver a final transcript without a preceding VAD item id.
          // `RealtimeSession.accept()` has already advanced the exact item as the current user turn;
          // mirror that accepted identity into the evidence ledger rather than dropping the transcript.
          this.#rememberUnboundUserOrigin(
            event.session_epoch,
            this.session.userInputRevision,
            event.item_id,
          )
        }
        await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.item_id)
        if (event.session_epoch <= this.#discardedInputEpoch) return
        await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
        if (event.session_epoch <= this.#discardedInputEpoch) return
        const originRef = await this.#bridge.acceptUserTranscript(event.text)
        if (event.session_epoch <= this.#discardedInputEpoch) return
        this.#notifyAcceptedUserTranscript({
          text: event.text, originRef, sessionEpoch: event.session_epoch, itemId: event.item_id, userInputRevision: inputRevision,
        })
        this.#rememberUserOriginRef(event.session_epoch, event.item_id, originRef)
        this.#intakeUser = {text: event.text, origin_ref: originRef, epoch: event.session_epoch, inputRevision, localOnsetRevision}
        this.#intake?.userTurn(event.text, originRef, String(event.session_epoch))
        this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
          event.session_epoch,
          this.session.userInputRevision,
        )
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        if (
          this.#isProjectConfirmationItem(event.session_epoch, event.item_id)
          && this.#projectConfirmation?.pending !== true
        ) {
          await this.#closeConfirmationDeferredCalls(event.item_id)
        } else if (this.#isProjectConfirmationShadowItem(event.session_epoch, event.item_id)) {
          await this.#closeConfirmationDeferredCalls(event.item_id)
        } else {
          await this.#continuations.releaseDeferredOriginCalls(event.item_id, originRef)
        }
        if (this.#isProjectConfirmationItem(event.session_epoch, event.item_id)) {
          await this.#maybeRequestProjectConfirmationDecisionRetry(event.session_epoch, event.item_id)
        }
      }
    } else if (event.kind === 'user_transcript_failed') {
      if (accepted) {
        this.#intake?.cancel()
        if (this.#userOrigins.revisionForItem(event.session_epoch, event.item_id) === undefined) {
          this.#rememberUnboundUserOrigin(
            event.session_epoch,
            this.session.userInputRevision,
            event.item_id,
          )
        }
        await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.item_id)
        await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
        // The transcript will never arrive, so anything waiting on it is waiting forever. Released
        // with a null ref: the calls still need an answer, and the bridge refuses them for want of
        // evidence rather than this layer dropping them silently.
        this.#failUserOriginTranscript(event.session_epoch, event.item_id)
        this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
          event.session_epoch,
          this.session.userInputRevision,
        )
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        if (this.#isProjectConfirmationItem(event.session_epoch, event.item_id)) {
          await this.#failProjectConfirmation(event.session_epoch, event.item_id)
        } else if (this.#isProjectConfirmationShadowItem(event.session_epoch, event.item_id)) {
          await this.#closeConfirmationDeferredCalls(event.item_id)
        } else {
          await this.#continuations.releaseDeferredOriginCalls(event.item_id, null)
        }
      }
    } else if (event.kind === 'tool_call_ready') {
      this.#telemetry?.record('tool.call', {
        name: this.#tools.bindings.get(event.name)?.logical_name ?? (event.name === 'confirm' ? 'confirm' : 'unknown'),
        call_id: event.call_id, outcome: accepted ? 'received' : 'rejected',
      })
      if (!accepted) {
        // A refused confirmation tool still owes the provider a terminal result, or the protocol stalls
        // waiting for one that will never come.
        if (blockedConfirmationTool) await this.#closeProjectConfirmationTool(event)
        else if (blockedExecutorApprovalTool) await this.#approvalHost.closeExecutorApprovalCarrierTool(event)
        else if (
          isExecutorApprovalDecision
          && event.session_epoch === this.session.sessionEpoch
        ) {
          await this.#approvalHost.handleExecutorApprovalDecision(event, {
            observedProviderResponseId: event.response_id,
            originItemId: null,
            originRef: null,
          })
        }
        return
      }
      await this.#continuations.routeToolCall(event)
    }
    if (event.kind === 'user_transcript_final' || event.kind === 'user_transcript_failed') {
      await this.#resumeProjectConfirmationCarrierRecoveryAfterUser()
    }
    if (event.kind === 'response_terminal') {
      this.#projectConfirmationIsolation.clearResponse({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })
      if (this.#projectConfirmationPendingQuarantineEpoch === event.session_epoch) {
        this.#projectConfirmationPendingQuarantineEpoch = null
      }
      this.#approvalHost.clearTerminal(event)
    }

    if (accepted) await this.driveContinuations()
    await this.#deliveryPass()
  }

  #notifyAcceptedUserTranscript(turn: {
    readonly text: string
    readonly originRef: string
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userInputRevision: number
  }): void {
    const callback = this.#onUserTranscriptAccepted
    if (callback === undefined) return
    try {
      void Promise.resolve(callback(turn)).catch(() => {
        this.#onDiagnostic('[realtime-diagnostic] personal_memory_admission_failed')
      })
    } catch {
      this.#onDiagnostic('[realtime-diagnostic] personal_memory_admission_failed')
    }
  }

  /**
   * Decide whether a tool call can be handled now, or has to wait for its evidence.
   *
   * Three cases, in the order the oracle checks them. If the response already has a bound user item,
   * the call has its evidence -- unless the transcript for that item has not landed, in which case it
   * waits. If no item is bound but a user turn is in flight, the call may belong to *that* turn, and
   * the question becomes whether the response it names is the one that turn will answer. If nothing is
   * pending at all, the call has whatever evidence it is going to get.
   *
   * The deferral queue is bounded. Full means the provider is producing calls faster than transcripts
   * arrive, and no amount of waiting will fix it -- reconnecting is the way back to a session whose
   * state can be reasoned about.
   */
  /**
   * Which confirmation FSM a `confirm(id, accepted)` call answers (spec 08: one tool for both).
   *
   * An id the approval FSM knows -- live, still holding voice authority, or its expiry tombstone --
   * wins, so a late answer keeps that FSM's own classification; then the project proposal's id. Any
   * other well-formed id names nothing and is `'none'` (`unknown_confirmation`, refused in
   * `#interceptHost`); only a null / malformed id falls through to whichever FSM is pending, so each
   * keeps its own malformed-call accounting. `null` is any other tool. The id is read through
   * `confirmArguments` so a provider-supplied accessor is never evaluated here.
   */
  #confirmTarget(event: ToolCallReady): 'approval' | 'project' | 'none' | null {
    if (event.name !== CONFIRM_TOOL) return null
    const id = confirmArguments(event.arguments)?.id ?? null
    const project = this.#projectConfirmation
    if (id !== null && this.#approvalHost.ownsId(id)) return 'approval'
    if (id !== null && project?.lifecycleId === id) return 'project'
    if (id !== null) return 'none'
    if (project?.pending === true) return 'project'
    if (this.#approvalHost.pending) return 'approval'
    if (
      event.response_id !== null
      && this.#approvalHost.isExecutorApprovalResponseQuarantined(event.session_epoch, event.response_id)
    ) return 'approval'
    return 'none'
  }

  /**
   * Wrap a loop so its failure stops the service instead of vanishing.
   *
   * An unobserved rejection in one of three long-lived loops is the worst outcome available: the
   * service would look alive while no longer consuming its provider. A loop that ends *at all*
   * without the service being asked to stop is treated as a failure for the same reason.
   */
  async #guardTask(task: Promise<void>, run: AbortController): Promise<void> {
    try {
      await task
      if (!run.signal.aborted) this.#taskFailed(run)
    } catch (cause) {
      this.#onDiagnostic(`[realtime-diagnostic] task_failure type=${diagnosticName(cause)}`)
      this.#taskFailed(run)
    }
  }

  /**
   * Stop the service because one of its loops ended when it should not have.
   *
   * Scoped to the run that started the task, not to whatever run is current. A task abandoned by an
   * earlier `close` can still resolve later, and without this check it would read the *replacement*
   * controller, find it un-aborted, and take down a service that had already been restarted.
   */
  #taskFailed(run: AbortController): void {
    if (run !== this.#stop) {
      // From a run that is already over. Its outcome cannot bear on the current one.
      this.#onDiagnostic('[realtime-diagnostic] task_failure_from_previous_run')
      return
    }
    this.#providerFailed = true
    this.#approvalHost.invalidateExecutorApproval('task_failed')
    this.#host.releaseFailedDelivery()
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  #reportDeliveryFailure(failure: RealtimeDeliveryError): void {
    this.#onDiagnostic(`[realtime-diagnostic] delivery_failure type=${diagnosticName(failure)}`)
  }

  // ---------------------------------------------------------------------------------------------
  // Family H: binding a tool call to the user turn that justifies it.
  //
  // A tool proposal needs evidence, and the evidence is the user transcript of the turn the model was
  // responding to. The provider does not hand those over together -- An automatic provider can finish a function call
  // before emitting the turn's transcript final -- so the binding is built here from two streams that
  // arrive out of order. Getting it wrong does not fail loudly; it attaches a proposal to the
  // *previous* user turn, which is precisely the kind of citation the origin check exists to stop.
  // ---------------------------------------------------------------------------------------------

  /** Register one provider item against the exact user revision that introduced it. */
  #rememberUnboundUserOrigin(epoch: number, revision: number, itemId: string): void {
    const registered = this.#userOrigins.registerUserItem({epoch, revision, itemId})
    this.#telemetry?.record('user_origin.item_registered', {
      session_epoch: epoch,
      user_input_revision: revision,
      item_id: itemId,
      registered,
    })
  }

  /**
   * Claim only the user item from the revision this provider response captured at open.
   */
  #bindResponseUserOrigin(epoch: number, responseId: string): boolean {
    if (epoch !== this.session.sessionEpoch) {
      this.#recordUserOriginResponseBinding(epoch, responseId, -1, 'epoch_mismatch', 'none')
      return false
    }
    const revision = this.session.providerTurnUserInputRevision(responseId)
    if (revision === undefined) {
      this.#recordUserOriginResponseBinding(epoch, responseId, -1, 'revision_missing', 'none')
      return false
    }
    const origin = this.session.providerResponseOrigin(responseId)
    if (origin !== undefined && (
      origin.kind !== 'user_item'
      || this.#userOrigins.revisionForItem(epoch, origin.item_id) !== revision
      || !this.session.responseMatchesUserItem(responseId, origin.item_id, revision)
    )) {
      this.#recordUserOriginResponseBinding(epoch, responseId, revision, 'provider_origin_mismatch', 'none')
      return false
    }
    const result = this.#userOrigins.bindResponse({epoch, responseId, revision})
    this.#recordUserOriginResponseBinding(
      epoch,
      responseId,
      revision,
      result.status,
      result.status === 'bound' ? result.item_id : 'none',
    )
    this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
      epoch,
      this.session.userInputRevision,
    )
    if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
    return result.status === 'bound'
  }

  #recordUserOriginResponseBinding(
    epoch: number,
    responseId: string,
    revision: number,
    status: string,
    itemId: string,
  ): void {
    this.#telemetry?.record('user_origin.response_binding', {
      session_epoch: epoch,
      user_input_revision: revision,
      response_id: responseId,
      item_id: itemId,
      status,
      proposal_id: this.#projectConfirmation?.lifecycleId ?? 'none',
      proposal_origin_ref: this.#projectConfirmation?.proposalOriginRef ?? 'none',
    })
  }

  /** Record the Memory ref produced by the transcript for this exact provider item. */
  #rememberUserOriginRef(epoch: number, itemId: string, originRef: string): void {
    const resolved = this.#userOrigins.resolveTranscript({epoch, itemId, originRef})
    this.#telemetry?.record('user_origin.transcript_resolution', {
      session_epoch: epoch,
      user_input_revision: this.#userOrigins.revisionForItem(epoch, itemId) ?? -1,
      item_id: itemId,
      origin_ref: originRef,
      status: resolved ? 'resolved' : 'rejected',
    })
  }

  #failUserOriginTranscript(epoch: number, itemId: string): boolean {
    const revision = this.#userOrigins.revisionForItem(epoch, itemId) ?? -1
    const failed = this.#userOrigins.failTranscript(epoch, itemId)
    this.#telemetry?.record('user_origin.transcript_resolution', {
      session_epoch: epoch,
      user_input_revision: revision,
      item_id: itemId,
      origin_ref: 'none',
      status: failed ? 'failed' : 'missing',
    })
    return failed
  }

  /** Same current-user fence for controller actions and direct external MCP effects. */
  #currentUserTurn(event: ToolCallReady, originRef: string | null) {
    const user = this.#intakeUser
    if (event.session_epoch <= this.#discardedInputEpoch || originRef === null || user?.epoch !== event.session_epoch || originRef !== user.origin_ref
      || user.localOnsetRevision !== this.#localSpeechOnsetRevision || user.inputRevision !== this.session.userInputRevision) return null
    const revision = this.session.userInputRevision
    const localOnsetRevision = this.#localSpeechOnsetRevision
    return {originRef, sessionEpoch: event.session_epoch, acceptedUserInputRevision: revision,
      stillWanted: (): boolean => event.session_epoch > this.#discardedInputEpoch
        && this.session.sessionEpoch === event.session_epoch
        && this.session.userInputRevision === revision
        && this.#localSpeechOnsetRevision === localOnsetRevision
        && this.#intakeUser?.origin_ref === originRef}
  }

  #executorDisplayName(channel: string): string {
    const agent = this.#agentRegistry.agentNameForChannel(channel)
    if (agent !== null) return agent
    const manifest = this.#runtime.executors.get(channel)?.manifest
    if (manifest !== undefined && isMonitorPolicy(manifest.policy)) {
      return monitorAlertDelivery(manifest.policy) === 'deferred' ? '观察' : '监控'
    }
    return manifest?.display_name ?? channel
  }

  /**
   * Tell the renderer whether Codex is working, when that changes.
   *
   * Derived from the session's live delegates rather than counted here: the session is what knows
   * when one finishes, and a separate counter would drift the moment a delegate ended by any route
   * this layer does not see.
   */
  #publishExecutorState(): void {
    const delegates = this.session.snapshot().active_delegates
    const fingerprint = canonicalJson(activeExecutorContextData(
      delegates,
      channel => this.#agentRegistry.agentNameForChannel(channel),
    ))
    if (fingerprint !== this.#activeWorkFingerprint) {
      this.#activeWorkFingerprint = fingerprint
      if (!this.#clearingConversation) {
        try {
          this.#onActiveWorkChanged()
        } catch (cause) {
          this.#onDiagnostic(
            `[realtime-diagnostic] active_work_observer_failed type=${diagnosticName(cause)}`,
          )
        }
      }
    }
    const next: ExecutorState = delegates.some(([, record]) => record.channel === this.#coding?.channel)
      ? 'running'
      : 'idle'
    if (next === this.#executorState) return
    this.#executorState = next
    try {
      this.#onExecutorState(next)
    } catch (cause) {
      // A renderer that cannot accept the state must not stop the service that produced it.
      this.#onDiagnostic(`[realtime-diagnostic] codex_state_observer_failed type=${diagnosticName(cause)}`)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Family N: the acknowledgement a delegated call owes the user.
  // ---------------------------------------------------------------------------------------------

  /** Mirror a newly visible controller lifecycle without importing its expiry policy. */
  #syncProjectConfirmationIsolation(): void {
    const controller = this.#projectConfirmation
    const lifecycleId = controller?.lifecycleId
    const sessionEpoch = this.session.sessionEpoch
    if (
      controller?.pending !== true
      || lifecycleId === null
      || lifecycleId === undefined
      || sessionEpoch < 1
    ) return
    // Spec 08: a colliding executor approval waits behind the project confirmation. Its voice authority
    // is withdrawn and its TTL paused (`hold`, never declined); `#publishProjectView` re-arms both once
    // this one settles.
    this.#approvalHost.hold()
    const current = this.#projectConfirmationIsolation.authority
    if (current?.authorityId === lifecycleId && current.sessionEpoch === sessionEpoch) return
    const remaining = controller.view.pending_expires_in_seconds
    if (remaining === undefined || remaining === null || !Number.isFinite(remaining)) return
    this.#projectConfirmationIsolation.beginAuthority({
      authorityId: lifecycleId,
      sessionEpoch,
      createdUserRevision: this.session.userInputRevision,
      expiresAt: this.#clock.now() + Math.max(0, remaining),
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Family I: project confirmation.
  //
  // Changing which workspace the agent operates in needs the user to say yes out loud, and this is the
  // machinery that makes that answer trustworthy in a conversation that keeps moving. The controller
  // owns the decision; this owns the *isolation* around it.
  //
  // Three overlapping guards, because the failure modes are different. The reserved item makes one
  // transcript the answer and nothing else. The response block permits only the dedicated decision
  // function. And the pending-only fence cancels an old host-requested question without cancelling the
  // model response that must produce that function. Each closes a hole the other two leave open.
  // ---------------------------------------------------------------------------------------------

  /**
   * Claim the user's next utterance as the answer to a pending proposal.
   *
   * An utterance with no provider item id cannot be reserved, and an unreservable one cannot be
   * answered -- so the proposal is cancelled outright rather than left waiting for a reply that can
   * never be attributed to it.
   */
  #reserveProjectConfirmation(event: {
    readonly session_epoch: number
    readonly provider_item_id: string | null
  }): void {
    if (this.#projectConfirmation?.pending !== true) return
    const itemId = event.provider_item_id
    if (itemId === null) {
      const lifecycleId = this.#projectConfirmationLifecycleId()
      this.#invalidateProjectConfirmation('missing_item_correlation')
      this.#queueProjectConfirmationFact(
        '缺少语音确认关联，本次操作已取消。',
        lifecycleId,
        'missing-item-correlation',
      )
      return
    }
    if (!this.#projectConfirmation.reserveUserItem({epoch: event.session_epoch, itemId})) {
      if (!this.#isProjectConfirmationItem(event.session_epoch, itemId)) {
        this.#projectConfirmationShadowItems.add(callKey(event.session_epoch, itemId))
      }
      return
    }
    const mirrored = this.#projectConfirmationIsolation.reserveUserItem({
      sessionEpoch: event.session_epoch,
      itemId,
      userRevision: this.session.userInputRevision,
    })
    if (mirrored !== 'reserved' && mirrored !== 'idempotent') {
      const lifecycleId = this.#projectConfirmationLifecycleId()
      this.#invalidateProjectConfirmation('missing_item_correlation')
      this.#queueProjectConfirmationFact(
        '缺少语音确认关联，本次操作已取消。',
        lifecycleId,
        'missing-item-correlation',
      )
      return
    }
    // Cancel only a confirmation question whose host-requested response has not started yet. The
    // response created from this user answer must remain alive so the provider can emit the structured
    // confirmation function after its response start.
    this.#projectConfirmationIsolation.setResponseFencePending(
      this.session.armPendingResponseFence(),
    )
    this.#publishProjectView()
  }

  /** Bind an initial carrier only after the shared origin ledger proves the exact item/revision. */
  #bindProjectConfirmationResponse(epoch: number, responseId: string): boolean {
    const itemId = this.#userOrigins.itemForResponse(epoch, responseId)
    const revision = itemId === undefined
      ? undefined
      : this.#userOrigins.revisionForItem(epoch, itemId)
    if (itemId === undefined || revision === undefined) return false
    const result = this.#projectConfirmationIsolation.bindResponse({
      sessionEpoch: epoch,
      itemId,
      userRevision: revision,
      responseId,
    })
    return result === 'bound' || result === 'idempotent'
  }

  /** Bind the provider response created by the one bounded retry to its original user evidence. */
  #bindProjectConfirmationRetryResponse(epoch: number, responseId: string): boolean {
    const retry = this.#projectConfirmationDecisionRetry
    if (retry === null || !retry.requested || retry.retry_response_id !== null) return false
    const item = parseCallKey(retry.item_key)
    if (item.sessionEpoch !== epoch) return false
    const revision = this.#userOrigins.revisionForItem(epoch, item.id)
    if (revision === undefined || !this.session.responseMatchesUserItem(responseId, item.id, revision)) return false
    if (!this.#userOrigins.bindRetryResponse({epoch, responseId, itemId: item.id})) return false
    const isolated = this.#projectConfirmationIsolation.bindRetryResponse({
      sessionEpoch: epoch,
      itemId: item.id,
      userRevision: revision,
      responseId,
    })
    if (isolated !== 'bound' && isolated !== 'idempotent') return false
    retry.retry_response_id = responseId
    this.#telemetry?.record('project_confirmation.decision_retry_started', {
      session_epoch: epoch,
      item_id: item.id,
      response_id: responseId,
      source_response_id: retry.source_response_id,
      proposal_id: this.#projectConfirmation?.lifecycleId ?? 'none',
      proposal_origin_ref: this.#projectConfirmation?.proposalOriginRef ?? 'none',
      delegate_origin_ref: this.#projectConfirmation?.proposalOriginRef ?? 'none',
      user_input_revision: this.#userOrigins.revisionForItem(epoch, item.id) ?? -1,
    })
    return true
  }

  /** Once the same turn's transcript exists, ask the provider once more for the structured decision. */
  async #maybeRequestProjectConfirmationDecisionRetry(epoch: number, itemId: string): Promise<void> {
    const retry = this.#projectConfirmationDecisionRetry
    const controller = this.#projectConfirmation
    if (
      retry?.item_key !== callKey(epoch, itemId)
      || retry.requested
      || !this.#userOrigins.hasOriginRef(epoch, itemId)
      || controller?.pending !== true
    ) return
    retry.requested = true
    this.#telemetry?.record('project_confirmation.decision_retry_requested', {
      session_epoch: epoch,
      item_id: itemId,
      source_response_id: retry.source_response_id,
      proposal_id: controller.lifecycleId ?? 'none',
      transcript_ready: true,
      retry_attempt: 1,
      proposal_origin_ref: controller.proposalOriginRef ?? 'none',
      delegate_origin_ref: controller.proposalOriginRef ?? 'none',
      user_input_revision: this.#userOrigins.revisionForItem(epoch, itemId) ?? -1,
    })
    let requested = false
    try {
      requested = await this.session.requestUserResponse()
    } catch (failure) {
      this.#reportDeliveryFailure(failure instanceof RealtimeDeliveryError
        ? failure
        : new RealtimeDeliveryError(String(failure)))
    }
    if (requested) return

    controller.releaseUndecided({epoch, itemId})
    this.#endProjectConfirmationItem(epoch, itemId)
    this.#telemetry?.record('project_confirmation.decision_retry_exhausted', {
      session_epoch: epoch,
      item_id: itemId,
      response_id: retry.source_response_id,
      proposal_id: controller.lifecycleId ?? 'none',
      reason: 'provider_retry_unavailable',
      proposal_origin_ref: controller.proposalOriginRef ?? 'none',
      delegate_origin_ref: controller.proposalOriginRef ?? 'none',
      user_input_revision: this.#userOrigins.revisionForItem(epoch, itemId) ?? -1,
    })
  }

  /**
   * Whether this tool call arrives in a turn that is supposed to be waiting for a confirmation.
   *
   * Blocked by *epoch* as well as by response, because a reconnect renumbers responses and a
   * confirmation spanning one would otherwise stop blocking. Recording the response id on the way
   * through is what makes the block stick for the rest of that turn.
   */
  #blocksProjectConfirmationTool(event: {
    readonly session_epoch: number
    readonly response_id: string | null
  }): boolean {
    const effectiveResponseId = event.response_id ?? this.session.activeProviderResponseId
    if (
      effectiveResponseId !== null
      && this.#projectConfirmationIsolation.responseState({
        sessionEpoch: event.session_epoch,
        responseId: effectiveResponseId,
      })?.quarantined === true
    ) return true
    if (this.#projectConfirmationIsolation.hasBlockedResponseInEpoch(event.session_epoch)) return true
    if (this.#projectConfirmationIsBlocking()) {
      if (event.response_id !== null) {
        this.#projectConfirmationIsolation.markBlockedResponse({
          sessionEpoch: event.session_epoch,
          responseId: event.response_id,
        })
      }
      return true
    }
    return false
  }

  #isProjectConfirmationItem(epoch: number, itemId: string): boolean {
    const key = callKey(epoch, itemId)
    const reserved = this.#projectConfirmationIsolation.reservation
    return reserved?.sessionEpoch === epoch && reserved.itemId === itemId
      || this.#projectConfirmationClosingItems.has(key)
  }

  #projectConfirmationIsBlocking(): boolean {
    return this.#projectConfirmationIsolation.reservation !== null
      || this.#projectConfirmationClosingItems.size > 0
      || this.#projectConfirmationIsolation.responseFencePending
  }

  #isProjectConfirmationShadowItem(epoch: number, itemId: string): boolean {
    return this.#projectConfirmationShadowItems.has(callKey(epoch, itemId))
  }

  /** A shadow turn is still transcribed into Memory, but it cannot speak or execute tools. */
  #suppressShadowConfirmationResponse(epoch: number, responseId: string): void {
    const itemId = this.#userOrigins.itemForResponse(epoch, responseId)
    if (itemId === undefined || !this.#isProjectConfirmationShadowItem(epoch, itemId)) return
    this.session.suppressResponse(responseId)
  }

  /**
   * Move an item from reserved to closing.
   *
   * A separate set rather than a flag, because closing involves provider I/O: during it the item is no
   * longer accepting an answer but still has to block tool calls, and a single set could not say both.
   */
  #beginProjectConfirmationClose(epoch: number, itemId: string): void {
    const key = callKey(epoch, itemId)
    const reserved = this.#projectConfirmationIsolation.reservation
    if (reserved?.sessionEpoch === epoch && reserved.itemId === itemId) {
      this.#projectConfirmationIsolation.releaseReservation({
        sessionEpoch: epoch,
        itemId,
        userRevision: reserved.userRevision,
      })
    }
    this.#projectConfirmationClosingItems.add(key)
  }

  #endProjectConfirmationClose(epoch: number, itemId: string): void {
    const key = callKey(epoch, itemId)
    this.#projectConfirmationClosingItems.delete(key)
    if (this.#projectConfirmationDecisionRetry?.item_key === key) {
      this.#projectConfirmationDecisionRetry = null
    }
  }

  #endProjectConfirmationItem(epoch: number, itemId: string): void {
    const key = callKey(epoch, itemId)
    const reserved = this.#projectConfirmationIsolation.reservation
    if (reserved?.sessionEpoch === epoch && reserved.itemId === itemId) {
      this.#projectConfirmationIsolation.releaseReservation({
        sessionEpoch: epoch,
        itemId,
        userRevision: reserved.userRevision,
      })
    }
    if (this.#projectConfirmationDecisionRetry?.item_key === key) {
      this.#projectConfirmationDecisionRetry = null
    }
  }

  async #handleProjectConfirmationDecision(
    event: ToolCallReady,
    origin: BoundToolOrigin,
  ): Promise<void> {
    const call = callKey(event.session_epoch, event.call_id)
    if (
      this.#projectConfirmationClosingCalls.has(call)
      || this.#projectConfirmationClosedCalls.has(call)
    ) return
    this.#projectConfirmationClosingCalls.add(call)
    let releaseDecisionGate: (() => void) | undefined
    const decisionGate = new Promise<void>(resolve => { releaseDecisionGate = resolve })
    this.#projectConfirmationDecisionGates.set(call, decisionGate)

    let code = 'confirmation_not_pending'
    let state = 'refused'
    let confirmationText: string | null = null
    let confirmationResponseId: string | null = null
    try {
      const itemId = origin.originItemId
      const controller = this.#projectConfirmation
      if (itemId === null) {
        const recovered = await this.#recoverUnboundProjectConfirmation(event)
        const proposalId = controller?.lifecycleId ?? 'none'
        const responseId = event.response_id ?? 'none'
        const activeResponseId = this.session.activeProviderResponseId ?? 'none'
        const responsePhase = event.response_id === null
          ? 'unknown'
          : this.session.providerTurnPhase(event.response_id) ?? 'unknown'
        const responseFenced = event.response_id !== null
          && this.session.providerTurnWasFenced(event.response_id)
        this.#onDiagnostic(
          '[realtime-diagnostic] project_confirmation_binding_missing'
          + ` session_epoch=${event.session_epoch}`
          + ` call_id=${event.call_id}`
          + ` response_id=${responseId}`
          + ` active_response_id=${activeResponseId}`
          + ` response_phase=${responsePhase}`
          + ` response_fenced=${responseFenced}`
          + ' origin_item_bound=false'
          + ` pending=${controller?.pending === true}`
          + ` recovered=${recovered}`
          + ` proposal_id=${proposalId}`,
        )
        this.#telemetry?.record('project_confirmation.binding_missing', {
          session_epoch: event.session_epoch,
          call_id: event.call_id,
          response_id: responseId,
          active_response_id: activeResponseId,
          response_phase: responsePhase,
          response_fenced: responseFenced,
          origin_item_bound: false,
          pending: controller?.pending === true,
          recovered,
          proposal_id: proposalId,
          proposal_origin_ref: controller?.proposalOriginRef ?? 'none',
          delegate_origin_ref: controller?.proposalOriginRef ?? 'none',
          user_input_revision: event.response_id === null
            ? -1
            : this.session.providerTurnUserInputRevision(event.response_id) ?? -1,
          item_id: 'none',
        })
      }
      if (
        controller !== undefined
        && itemId !== null
        && origin.originRef !== null
        && origin.observedProviderResponseId !== null
        && event.response_id === origin.observedProviderResponseId
        && this.#projectConfirmationIsolation.isAuthorizationCarrier({
          sessionEpoch: event.session_epoch,
          userRevision: this.#userOrigins.revisionForItem(event.session_epoch, itemId) ?? -1,
          responseId: origin.observedProviderResponseId,
        })
        && this.#isProjectConfirmationItem(event.session_epoch, itemId)
      ) {
        let text: string | null = null
        let expiryOwnsFact = false
        const decision = confirmArguments(event.arguments)
        if (decision === null) {
          code = 'confirmation_invalid'
          text = '确认请求无效，操作尚未执行。'
        } else {
          const outcome = controller.acceptDecision({
            epoch: event.session_epoch,
            itemId,
            proposalId: decision.id,
            confirmed: decision.accepted,
          })
          if (outcome.kind === 'cancelled') this.#intake?.decline(decision.id)
          code = outcome.kind === 'ignored' ? 'confirmation_not_pending' : outcome.kind
          state = outcome.kind === 'confirmed' ? 'accepted' : 'refused'
          text = outcome.response_text
          this.#publishProjectView()
          if (outcome.kind !== 'invalid' && outcome.kind !== 'ignored') {
            this.#beginProjectConfirmationClose(event.session_epoch, itemId)
            try {
              await this.#closeConfirmationDeferredCalls(itemId)
              if (outcome.kind === 'confirmed' && outcome.operation !== null) {
                const committed = await this.#commitConfirmedProjectOperation(outcome.operation)
                state = committed.state
                text = committed.text
                expiryOwnsFact = committed.expiryOwnsFact
              }
            } finally {
              this.#endProjectConfirmationClose(event.session_epoch, itemId)
            }
          }
        }
        if (
          text !== null
          && text !== ''
          && !expiryOwnsFact
          && code !== 'confirmation_invalid'
          && code !== 'confirmation_not_pending'
        ) {
          confirmationText = text
          confirmationResponseId = origin.observedProviderResponseId
        }
        this.#publishProjectView()
      }
      const item: HostContextItem = {
        kind: 'tool_output',
        host_item_id: this.#idFactory(),
        event_id: this.#idFactory(),
        call_id: event.call_id,
        content: JSON.stringify({code, state}),
      }
      const toolOutputInjected = await this.session.injectToolOutput(item)
      if (confirmationText !== null) {
        if (toolOutputInjected && confirmationResponseId !== null) {
          this.session.settleUserResponse(confirmationResponseId)
        }
        const carrierNeedsCancellation = confirmationResponseId === null
          ? false
          : this.#prepareProjectConfirmationCarrier(event.session_epoch, confirmationResponseId)
        this.#queueProjectConfirmationFact(
          confirmationText,
          this.#projectConfirmationLifecycleId(),
          `decision:${code}:${state}`,
        )
        if (carrierNeedsCancellation && confirmationResponseId !== null) {
          this.#cancelProjectConfirmationCarrier(event.session_epoch, confirmationResponseId)
        }
      }
    } catch (cause) {
      releaseDecisionGate?.()
      this.#projectConfirmationDecisionGates.delete(call)
      this.#projectConfirmationClosingCalls.delete(call)
      throw cause
    }
    releaseDecisionGate?.()
    this.#projectConfirmationDecisionGates.delete(call)
    this.#projectConfirmationClosingCalls.delete(call)
    this.#rememberClosedProjectConfirmationCall(call)
  }

  async #commitConfirmedProjectOperation(
    operation: ConfirmedProjectOperation,
  ): Promise<{
    readonly state: 'accepted' | 'failed'
    readonly text: string
    readonly expiryOwnsFact: boolean
  }> {
    const intakeOperation = operation.intake_id !== undefined
    if (intakeOperation && this.#intake?.beginConfirmed(operation) !== true) {
      this.#projectConfirmation?.rejectConfirmed(operation)
      return {state: 'failed', text: '计划已失效，尚未执行。请重新提出任务。', expiryOwnsFact: false}
    }
    const callback = this.#commitProjectOperation
    const lifecycleId = operation.proposal_id
    this.#projectConfirmationCommittingLifecycles.add(lifecycleId)
    this.#telemetry?.record('project_confirmation.commit_started', {
      session_epoch: this.session.sessionEpoch,
      proposal_id: operation.proposal_id,
      proposal_origin_ref: operation.origin_ref,
      delegate_origin_ref: operation.origin_ref,
      expires_at: operation.expires_at,
    })
    if (callback === undefined) {
      if (intakeOperation) this.#intake?.settleConfirmed({accepted: false, code: 'callback_missing'})
      this.#projectConfirmation?.rollbackConfirmed(operation)
      this.#telemetry?.record(this.#projectConfirmation?.pending === true
        ? 'project_confirmation.commit_rollback'
        : 'project_confirmation.commit_settled', {
        session_epoch: this.session.sessionEpoch,
        proposal_id: operation.proposal_id,
        proposal_origin_ref: operation.origin_ref,
        delegate_origin_ref: operation.origin_ref,
        code: 'callback_missing',
      })
      return this.#finishConfirmedProjectCommit(lifecycleId, {
        state: 'failed',
        text: '确认处理不可用，本次操作未执行。',
      })
    }
    try {
      const result = await callback(operation)
      const controller = this.#projectConfirmation
      this.#telemetry?.record('project_confirmation.commit_admission', {
        session_epoch: this.session.sessionEpoch,
        proposal_id: operation.proposal_id,
        proposal_origin_ref: operation.origin_ref,
        delegate_origin_ref: operation.origin_ref,
        accepted: result.accepted,
        code: result.code,
        delegate_id: result.delegate_id ?? 'none',
      })
      if (result.accepted && controller?.committing === true) {
        if (intakeOperation) this.#intake?.settleConfirmed({accepted: false, code: 'confirmation_invalid'})
        controller.rejectConfirmed(operation)
        this.#telemetry?.record('project_confirmation.commit_settled', {
          session_epoch: this.session.sessionEpoch,
          proposal_id: operation.proposal_id,
          proposal_origin_ref: operation.origin_ref,
          delegate_origin_ref: operation.origin_ref,
          accepted: false,
          code: 'confirmation_invalid',
          delegate_id: result.delegate_id ?? 'none',
        })
        return this.#finishConfirmedProjectCommit(lifecycleId, {
          state: 'failed',
          text: '确认处理无效，本次操作未执行。',
        })
      }
      if (!result.accepted && controller?.committing === true) {
        if (result.code === 'runtime_rejected') controller.rollbackConfirmed(operation)
        else if (result.code !== 'confirmation_in_progress') controller.rejectConfirmed(operation)
      }
      if (intakeOperation) this.#intake?.settleConfirmed(result)
      const transitionKind = result.code === 'confirmation_in_progress'
        ? 'project_confirmation.commit_duplicate_suppressed'
        : controller?.pending === true
          ? 'project_confirmation.commit_rollback'
          : 'project_confirmation.commit_settled'
      this.#telemetry?.record(transitionKind, {
        session_epoch: this.session.sessionEpoch,
        proposal_id: operation.proposal_id,
        proposal_origin_ref: operation.origin_ref,
        delegate_origin_ref: operation.origin_ref,
        accepted: result.accepted,
        code: result.code,
        delegate_id: result.delegate_id ?? 'none',
      })
      return this.#finishConfirmedProjectCommit(lifecycleId, {
        state: result.accepted ? 'accepted' : 'failed',
        text: result.accepted
          ? projectCommitSuccessText(operation, result.code)
          : result.code === 'confirmation_in_progress'
            ? ''
            : projectCommitFailureText(result.code, this.#coding?.display_name),
      })
    } catch (failure) {
      if (intakeOperation) this.#intake?.settleConfirmed({accepted: false, code: 'callback_failed'})
      if (isAbort(failure)) {
        this.#projectConfirmationCommittingLifecycles.delete(lifecycleId)
        this.#projectConfirmationExpiryFactOwners.delete(lifecycleId)
        throw failure
      }
      this.#projectConfirmation?.rollbackConfirmed(operation)
      this.#telemetry?.record(this.#projectConfirmation?.pending === true
        ? 'project_confirmation.commit_rollback'
        : 'project_confirmation.commit_settled', {
        session_epoch: this.session.sessionEpoch,
        proposal_id: operation.proposal_id,
        proposal_origin_ref: operation.origin_ref,
        delegate_origin_ref: operation.origin_ref,
        code: 'callback_failed',
      })
      return this.#finishConfirmedProjectCommit(lifecycleId, {
        state: 'failed',
        text: '已确认，但操作未执行。',
      })
    }
  }

  #finishConfirmedProjectCommit(
    lifecycleId: string,
    result: {readonly state: 'accepted' | 'failed'; readonly text: string},
  ): {readonly state: 'accepted' | 'failed'; readonly text: string; readonly expiryOwnsFact: boolean} {
    this.#projectConfirmationCommittingLifecycles.delete(lifecycleId)
    return {
      ...result,
      expiryOwnsFact: this.#projectConfirmationExpiryFactOwners.delete(lifecycleId),
    }
  }

  /**
   * End one answer whose confirmation function cannot be tied back to a provider response.
   *
   * Refusing the function is necessary but insufficient: leaving the controller reservation alive
   * turns every later utterance into a shadow and makes a still-valid proposal impossible to answer.
   * Recovery is deliberately narrow -- current epoch, one exact reserved item, and a live proposal --
   * and grants no authority. It only lets the user make a fresh, bindable attempt.
   */
  async #recoverUnboundProjectConfirmation(event: ToolCallReady): Promise<boolean> {
    const controller = this.#projectConfirmation
    if (
      controller?.pending !== true
      || event.session_epoch !== this.session.sessionEpoch
      || this.#projectConfirmationIsolation.responseFencePending
    ) return false
    const reserved = this.#projectConfirmationIsolation.reservation
    const itemId = reserved?.sessionEpoch === event.session_epoch ? reserved.itemId : undefined
    if (itemId === undefined || !controller.releaseUndecided({
      epoch: event.session_epoch,
      itemId,
    })) return false

    this.#beginProjectConfirmationClose(event.session_epoch, itemId)
    try {
      await this.#closeConfirmationDeferredCalls(itemId)
    } finally {
      this.#endProjectConfirmationClose(event.session_epoch, itemId)
    }
    this.#failUserOriginTranscript(event.session_epoch, itemId)
    this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
      event.session_epoch,
      this.session.userInputRevision,
    )
    if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
    this.#queueProjectConfirmationFact(
      '我没能把这次语音和确认请求关联起来；请再说一次“确认”或“取消”。',
      this.#projectConfirmationLifecycleId(),
      `binding-missing:${callKey(event.session_epoch, itemId)}`,
    )
    this.#publishProjectView()
    return true
  }

  /** Transcription failed, so the answer is unknowable and the proposal is cancelled. */
  async #failProjectConfirmation(epoch: number, itemId: string): Promise<void> {
    if (this.#projectConfirmationClosingItems.has(callKey(epoch, itemId))) {
      await this.#closeConfirmationDeferredCalls(itemId)
      return
    }
    this.#beginProjectConfirmationClose(epoch, itemId)
    try {
      await this.#closeConfirmationDeferredCalls(itemId)
    } finally {
      this.#endProjectConfirmationClose(epoch, itemId)
    }
    const controller = this.#projectConfirmation
    if (controller === undefined) return
    const outcome = controller.failTranscript({epoch, itemId})
    if (outcome.response_text !== null && outcome.response_text !== '') {
      this.#queueProjectConfirmationFact(
        outcome.response_text,
        this.#projectConfirmationLifecycleId(),
        `transcript-failed:${callKey(epoch, itemId)}`,
      )
    }
    this.#publishProjectView()
  }

  /**
   * Give the provider a terminal result for a tool call the confirmation refused.
   *
   * Reserved *before* the first await: expiry cleanup and a provider event can both reach the same
   * call, and two terminal outputs for one function call is a protocol violation. Cleared on failure so
   * a retry is possible; recorded on success so a later attempt is a no-op.
   */
  async #closeProjectConfirmationTool(event: ToolCallReady): Promise<void> {
    const key = callKey(event.session_epoch, event.call_id)
    if (
      this.#projectConfirmationClosingCalls.has(key)
      || this.#projectConfirmationClosedCalls.has(key)
    ) {
      return
    }
    this.#projectConfirmationClosingCalls.add(key)
    const item: HostContextItem = {
      kind: 'tool_output',
      host_item_id: this.#idFactory(),
      event_id: this.#idFactory(),
      call_id: event.call_id,
      content: '{"code":"confirmation_reserved","state":"superseded"}',
    }
    try {
      await this.session.injectToolOutput(item)
    } catch (cause) {
      this.#projectConfirmationClosingCalls.delete(key)
      throw cause
    }
    this.#projectConfirmationClosingCalls.delete(key)
    this.#rememberClosedProjectConfirmationCall(key)
  }

  #rememberClosedProjectConfirmationCall(key: string): void {
    this.#projectConfirmationClosedCalls.delete(key)
    this.#projectConfirmationClosedCalls.set(key, null)
    while (this.#projectConfirmationClosedCalls.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#projectConfirmationClosedCalls.keys().next()
      if (oldest.done === true) break
      this.#projectConfirmationClosedCalls.delete(oldest.value)
    }
  }

  /**
   * Refuse the tool calls that were waiting on this transcript.
   *
   * Detached before awaiting: rebuilding the queue from a snapshot after provider I/O would overwrite
   * calls a concurrent event appended in the meantime.
   */
  async #closeConfirmationDeferredCalls(itemId: string): Promise<void> {
    const matching = this.#continuations.takeDeferredForItem(itemId)
    for (const call of matching) {
      await this.#closeProjectConfirmationTool(call.event)
    }
  }

  /** Say something to the user about the confirmation. Just below user priority: urgent, not louder. */
  #queueProjectConfirmationFact(text: string, lifecycleId: string, transition: string): void {
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: projectConfirmationEventId('project-confirmation', lifecycleId, transition),
      content: [...text].slice(0, MAX_HOST_FACT_CHARS).join(''),
    }), {priority: USER_PRIORITY - 1, preemptive: false})
    this.#deliveryReady.set()
  }

  /** Transfer reply ownership locally before any provider I/O can delay the deterministic fact. */
  #prepareProjectConfirmationCarrier(sessionEpoch: number, responseId: string): boolean {
    const phase = this.session.providerTurnPhase(responseId)
    const generation = this.session.currentGeneration
    const live = sessionEpoch === this.session.sessionEpoch && (
      this.session.activeProviderResponseId === responseId
      || phase === 'active'
      || phase === 'cancel_requested'
      || (
        generation !== null
        && generation.session_epoch === sessionEpoch
        && generation.response_id === responseId
      )
    )
    if (live) {
      this.#projectConfirmationIsolation.markQuarantined({sessionEpoch, responseId})
    }
    this.session.suppressResponse(responseId)
    this.#continuations.abandonProjectConfirmationContinuation(sessionEpoch, responseId)
    return live
  }

  /** Cancel the carrier without holding up the event that queued its host-owned reply. */
  #cancelProjectConfirmationCarrier(sessionEpoch: number, responseId: string): void {
    const cancellation = (async (): Promise<void> => {
      try {
        const targeted = await this.session.quarantineResponse(responseId)
        if (!targeted) {
          this.#projectConfirmationIsolation.clearQuarantined({sessionEpoch, responseId})
          return
        }
        if (this.session.providerTurnPhase(responseId) !== 'cancel_requested') {
          // The carrier may have reached terminal while tool output was being confirmed even though
          // its audio was still queued. The exact fence was still required, but no provider terminal
          // remains to release a quarantine entry or justify a reconnect watchdog.
          this.#projectConfirmationIsolation.clearQuarantined({sessionEpoch, responseId})
          return
        }
      } catch (failure) {
        this.#reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
        await this.#recoverProjectConfirmationCarrier(
          sessionEpoch,
          responseId,
          'cancel_failed',
        )
        return
      }
      await this.#projectConfirmationCarrierReleaseWatchdog(sessionEpoch, responseId)
    })()
    this.#trackProjectConfirmationCarrierRelease(cancellation)
  }

  #trackProjectConfirmationCarrierRelease(work: Promise<void>): void {
    const task = work.catch((failure: unknown) => {
      if (!isAbort(failure)) {
        this.#reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
      }
    }).finally(() => {
      this.#projectConfirmationCarrierReleaseTasks.delete(task)
    })
    this.#projectConfirmationCarrierReleaseTasks.add(task)
  }

  async #projectConfirmationCarrierReleaseWatchdog(
    sessionEpoch: number,
    responseId: string,
  ): Promise<void> {
    await this.#clock.sleep(PROJECT_CONFIRMATION_CARRIER_RELEASE_TIMEOUT_S, this.#stop.signal)
    await this.#recoverProjectConfirmationCarrier(sessionEpoch, responseId, 'terminal_timeout')
  }

  async #recoverProjectConfirmationCarrier(
    sessionEpoch: number,
    responseId: string,
    reason: string,
  ): Promise<void> {
    const key = callKey(sessionEpoch, responseId)
    if (
      sessionEpoch !== this.session.sessionEpoch
      || this.#projectConfirmationIsolation.responseState({sessionEpoch, responseId})
        ?.quarantined !== true
      || this.session.providerTurnPhase(responseId) !== 'cancel_requested'
    ) return
    if (this.session.floor.state === 'user_speaking') {
      const alreadyDeferred = this.#projectConfirmationCarrierReconnectAfterUser.has(key)
      this.#projectConfirmationCarrierReconnectAfterUser.set(key, {
        sessionEpoch,
        responseId,
        reason,
      })
      if (!alreadyDeferred) {
        this.#trackProjectConfirmationCarrierRelease(
          this.#recoverProjectConfirmationCarrierAfterStaleUserHold(key),
        )
      }
      return
    }
    this.#projectConfirmationCarrierReconnectAfterUser.delete(key)
    this.#telemetry?.record('project_confirmation.carrier_recovery', {
      session_epoch: sessionEpoch,
      response_id: responseId,
      reason,
    })
    await this.#reconnectProviderSession({
      reason: 'project_confirmation_carrier_recovery',
      expectedEpoch: sessionEpoch,
    })
  }

  async #recoverProjectConfirmationCarrierAfterStaleUserHold(key: string): Promise<void> {
    if (!await this.session.waitForStaleHold(USER_HOLD_MAX_S)) return
    const pending = this.#projectConfirmationCarrierReconnectAfterUser.get(key)
    if (pending === undefined) return
    if (this.session.releaseStaleUserHold(USER_HOLD_MAX_S)) {
      this.#onDiagnostic('[realtime-diagnostic] project_confirmation_stale_user_hold_released')
    }
    await this.#recoverProjectConfirmationCarrier(
      pending.sessionEpoch,
      pending.responseId,
      pending.reason,
    )
  }

  async #resumeProjectConfirmationCarrierRecoveryAfterUser(): Promise<void> {
    if (this.session.floor.state === 'user_speaking') return
    const pending = [...this.#projectConfirmationCarrierReconnectAfterUser.values()]
    this.#projectConfirmationCarrierReconnectAfterUser.clear()
    for (const carrier of pending) {
      await this.#recoverProjectConfirmationCarrier(
        carrier.sessionEpoch,
        carrier.responseId,
        carrier.reason,
      )
    }
  }

  async #quarantineProjectConfirmationResponses(sessionEpoch: number): Promise<void> {
    const carriers: string[] = []
    for (const response of this.#projectConfirmationIsolation.blockedResponses) {
      if (response.sessionEpoch !== sessionEpoch) continue
      if (this.#prepareProjectConfirmationCarrier(sessionEpoch, response.responseId)) {
        carriers.push(response.responseId)
      }
    }
    this.session.armPendingResponseFence()
    if (
      this.#projectConfirmationPendingQuarantineEpoch !== null
      && this.#projectConfirmationPendingQuarantineEpoch === sessionEpoch
    ) {
      try {
        await this.session.quarantineActiveOrAwaitingResponse()
      } catch (failure) {
        this.#reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
      }
    }
    for (const responseId of carriers) {
      this.#cancelProjectConfirmationCarrier(sessionEpoch, responseId)
    }
  }

  /** The proposal id is the lifecycle key; settlement deliberately does not erase it. */
  #projectConfirmationLifecycleId(): string {
    const lifecycleId = this.#projectConfirmation?.lifecycleId
    if (lifecycleId !== null && lifecycleId !== undefined) return lifecycleId
    this.#onDiagnostic('[realtime-diagnostic] project_confirmation_lifecycle_missing')
    return `session:${this.session.sessionEpoch}`
  }

  /**
   * The proposal timed out on its own.
   *
   * Batched and drained by one task rather than handled inline, because cleanup involves provider I/O
   * and possibly a reconnect -- and the expiry observer is called from a timer that must not be left
   * awaiting either. A second expiry while one is draining joins the queue instead of racing it.
   */
  #projectConfirmationExpired(): void {
    const reserved = this.#projectConfirmationIsolation.reservation
    const itemKeys = reserved === null
      ? []
      : [callKey(reserved.sessionEpoch, reserved.itemId)]
    const sourceEpoch = this.session.sessionEpoch
    const lifecycleId = this.#projectConfirmationLifecycleId()
    if (this.#projectConfirmationCommittingLifecycles.has(lifecycleId)) {
      this.#projectConfirmationExpiryFactOwners.add(lifecycleId)
    }
    // A reconnect is needed when the confirmation armed a fence or blocked a response in this epoch:
    // either leaves provider state the next turn would otherwise inherit.
    const reconnect = this.#projectConfirmationIsolation.responseFencePending
      || (this.#projectConfirmationDecisionRetry?.requested === true
        && this.#projectConfirmationDecisionRetry.retry_response_id === null)
      || this.#projectConfirmationIsolation.hasBlockedResponseInEpoch(sourceEpoch)
    for (const key of itemKeys) {
      const {sessionEpoch, id} = parseCallKey(key)
      this.#beginProjectConfirmationClose(sessionEpoch, id)
    }
    this.#projectExpiryBatches.push({
      item_keys: itemKeys,
      source_epoch: sourceEpoch,
      reconnect,
      lifecycle_id: lifecycleId,
    })
    this.#startProjectConfirmationExpiryDrain()
    this.#publishProjectView()
  }

  /** Do not reconnect or inject expiry facts beside an in-flight confirmation tool output. */
  #startProjectConfirmationExpiryDrain(): void {
    if (
      this.#projectExpiryDraining !== null
      || this.#projectExpiryBatches.length === 0
    ) return
    const signal = this.#stop.signal
    this.#projectExpiryDraining = this.#drainProjectConfirmationExpiries(signal)
      .catch((failure: unknown) => {
        this.#onDiagnostic(
          `[realtime-diagnostic] project_expiry_failure type=${diagnosticName(failure)}`,
        )
      })
      .finally(() => {
        this.#projectExpiryDraining = null
        this.#startProjectConfirmationExpiryDrain()
      })
  }

  async #drainProjectConfirmationExpiries(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return
      const batch = this.#projectExpiryBatches.shift()
      if (batch === undefined) return
      await this.#finishProjectConfirmationExpiry(batch, signal)
    }
  }

  /**
   * Clean up after one expired proposal.
   *
   * Every step is deadlined, because each one talks to a provider that may not answer and an expiry
   * that hangs leaves the confirmation state blocking every later turn. A step that times out is
   * treated as a failure of that step, not of the expiry: the loop carries on and the user is still
   * told the proposal lapsed.
   *
   * The re-drain loop matters: closing a call awaits, and a provider event during that await can defer
   * another call for the same epoch. Taking the queue once would leave it behind.
   */
  async #finishProjectConfirmationExpiry(
    batch: ProjectExpiryBatch,
    signal: AbortSignal,
  ): Promise<void> {
    const clearRevision = this.#conversationClearRevision
    if (this.#clearingConversation) return
    let closeFailed = false
    const decisionGates = [...this.#projectConfirmationDecisionGates]
      .filter(([key]) => parseCallKey(key).sessionEpoch === batch.source_epoch)
      .map(([, gate]) => gate)
    if (decisionGates.length > 0) {
      const completed = await this.#runProjectExpiryStep(Promise.all(decisionGates))
      closeFailed = closeFailed || !completed
    }
    for (;;) {
      // Checked at every resumption point, not just on entry: each close awaits the provider, and the
      // service can be closed during any of them. Reconnecting or injecting after that would be a
      // stopped service talking to a provider it has already released.
      if (
        signal.aborted
        || this.#clearingConversation
        || clearRevision !== this.#conversationClearRevision
      ) return
      const deferred = this.#continuations.takeConfirmationDeferredCalls(batch.source_epoch)
      if (deferred.length === 0) break
      for (const call of deferred) {
        try {
          const completed = await this.#runProjectExpiryStep(
            this.#closeProjectConfirmationTool(call.event),
          )
          closeFailed = closeFailed || !completed
          if (
            this.#clearingConversation
            || clearRevision !== this.#conversationClearRevision
          ) return
        } catch {
          closeFailed = true
        }
      }
    }
    if (
      signal.aborted
      || this.#clearingConversation
      || clearRevision !== this.#conversationClearRevision
    ) return
    if (batch.reconnect || closeFailed) {
      try {
        await this.#runProjectExpiryStep(
          this.#reconnectProviderSession({
            reason: 'project_confirmation_expiry_cleanup',
            expectedEpoch: batch.source_epoch,
          }),
        )
      } catch (failure) {
        this.#onDiagnostic(
          `[realtime-diagnostic] project_expiry_reconnect_failure type=${diagnosticName(failure)}`,
        )
      }
    }
    // The items are released even at shutdown: leaving one closing would block a service that is
    // restarted. Only the provider-facing half below is skipped.
    for (const key of batch.item_keys) {
      const {sessionEpoch, id} = parseCallKey(key)
      this.#endProjectConfirmationClose(sessionEpoch, id)
    }
    if (
      signal.aborted
      || this.#clearingConversation
      || clearRevision !== this.#conversationClearRevision
    ) return
    this.#queueProjectConfirmationFact(
      '确认已过期，本次操作已取消。',
      batch.lifecycle_id,
      'expired',
    )
    try {
      await this.#runProjectExpiryStep(this.#deliveryPass())
    } catch (failure) {
      this.#onDiagnostic(
        `[realtime-diagnostic] project_expiry_delivery_failure type=${diagnosticName(failure)}`,
      )
    }
    this.#publishProjectView()
  }

  /**
   * Run one cleanup step, or give up on it.
   *
   * Returns whether it finished. A step that did not is abandoned rather than awaited: the work may
   * still complete in the background, and the alternative is an expiry that never ends.
   */
  async #runProjectExpiryStep(work: Promise<unknown>): Promise<boolean> {
    // Attached now so a rejection after the deadline is not an unhandled one.
    const settled = work.then(() => true, () => false)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), this.#projectExpiryStepTimeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #publishProjectView(): void {
    const controller = this.#projectConfirmation
    if (controller === undefined) return
    try {
      this.#onProjectView?.(
        this.#projectViewProvider?.(controller.pending || controller.committing) ?? controller.view,
      )
    } catch {
      // A renderer that cannot accept the view must not prevent the state change that produced it.
    }
    // Spec 08: an executor approval that waited behind this confirmation gets a fresh TTL and is
    // voice-armed once it is over. `release` publishes, and the observer runs the host sync
    // with the re-armed view; a head that was never held is synced directly.
    if (!controller.pending && !controller.committing) this.#approvalHost.release()
  }

  /**
   * Drop the proposal and every trace of its isolation.
   *
   * Called when the world the proposal described has changed underneath it -- a reconnect, a new
   * provider session -- so confirming it would commit against a context the user never saw.
   */
  #invalidateProjectConfirmation(reason: string): void {
    if (reason !== 'intake_amended') this.#intake?.cancel()
    this.#projectConfirmation?.invalidate(reason)
    this.#projectConfirmationIsolation.invalidate()
    this.#projectConfirmationShadowItems.clear()
    this.#projectConfirmationClosingItems.clear()
    this.#projectConfirmationCarrierReconnectAfterUser.clear()
    this.#projectConfirmationPendingQuarantineEpoch = null
    this.#projectConfirmationDecisionRetry = null
    this.#publishProjectView()
  }

  // ---------------------------------------------------------------------------------------------
  // Family E: playback acknowledgement.
  //
  // The renderer is the only thing that knows whether audio actually reached a person. Everything here
  // turns its reports into facts the rest of the system can rely on -- and refuses to turn them into
  // more than that. "The renderer said it played 0 ms" is not evidence the user heard anything.
  // ---------------------------------------------------------------------------------------------

  playbackStarted(utteranceId: string, generationEpoch: number): boolean {
    // Read before the call, because starting playback is what makes it current.
    const generation = this.session.currentGeneration
    const started = this.session.playbackStarted(utteranceId, generationEpoch)
    if (
      started
      && generation !== null
      && generation.utterance_id === utteranceId
      && generation.generation_epoch === generationEpoch
      && this.#telemetry !== undefined
    ) {
      const attribution = this.#playbackAttribution(generation.response_id)
      if (attribution !== null) this.#telemetry.record('playback.attribution', attribution)
    }
    return started
  }

  /**
   * What this turn was speaking *about*, when that is unambiguous.
   *
   * Only a single suggestion counts: a turn carrying two is answering neither one in particular, and
   * attributing it to either would be a guess recorded as a fact.
   */
  #playbackAttribution(responseId: string): Readonly<Record<string, JsonValue>> | null {
    const suggestionEvents = this.session.responseEventIds(responseId)
      .filter(eventId => eventId.startsWith('suggestion:'))
    if (suggestionEvents.length === 1) {
      const suggestionId = suggestionEvents[0]!.slice('suggestion:'.length)
      const suggestion = this.#runtime.suggestionFor?.(suggestionId) ?? null
      if (suggestion !== null && suggestion.kind === 'selected_progress') {
        const memoryRef = suggestion.evidence_refs[0]
        if (memoryRef !== undefined) {
          return {target: 'selected_progress', memory_ref: memoryRef}
        }
      }
    }
    if (this.#continuations.responseCarriesPersonalRecall(responseId)) return {target: 'memory_recall'}
    return null
  }

  // ---------------------------------------------------------------------------------------------
  // Family L: preemptive-alert delivery.
  //
  // A preemptive alert is the one thing allowed to interrupt the agent mid-sentence, and interrupting is
  // the hard part. The provider has to be told to stop, the renderer has to be told to drop the audio
  // already in flight, and the replacement has to start speaking -- with no guarantee any of the three
  // acknowledges. So every step is deadlined: if the provider does not confirm the cancel, the host
  // stops waiting and speaks anyway; if the renderer does not confirm the clear, the generation is
  // retired as unknown rather than left pending forever.
  //
  // The token is what makes that safe. Each preemption carries one, and every deferred callback checks
  // it before acting -- so a deadline belonging to a preemption that has already resolved does
  // nothing, instead of tearing down the one that replaced it.
  // ---------------------------------------------------------------------------------------------

  /**
   * The provider refused to cancel, so take the session away from it.
   *
   * The last resort. The provider was asked to stop, said it would not, and the alert is still waiting
   * -- so the whole provider session is replaced under the preemption rather than letting the old turn
   * run to completion. Gated behind the composition-owned reconnect option because it is a heavy remedy for a case
   * that should not happen.
   *
   * `#reconnectLock` before `#deliveryLock`, never the reverse: that order is fixed across this layer,
   * and this is the one method that holds both.
   *
   * Seven conditions have to hold before the permit is spent. Together they say: this rejection is
   * about *this* preemption, in the current session, for a turn that is still trying to cancel and has
   * not produced anything yet. Anything else and a reconnect would be discarding a session that is
   * working.
   */
  async #handlePreemptiveAlertCancelRejected(event: {
    readonly session_epoch: number
    readonly response_id: string
  }): Promise<void> {
    if (!this.#controlledPreemptiveAlertReconnect) return
    await this.#reconnectLock.run(async () => {
      await this.#host.withDeliveryLock(async () => {
        if (this.#preemptiveAlertHistoryRecovery !== 'none') await this.#runtime.flushMemory?.(true)
        const preemption = this.#host.currentPreemption
        if (
          preemption?.session_epoch !== event.session_epoch
          || preemption.session_epoch !== this.session.sessionEpoch
          || preemption.old_response_id !== event.response_id
          || preemption.reconnect_permit_consumed
          || preemption.reconnect_disallowed
          || this.session.providerTurnPhase(event.response_id) !== 'cancel_requested'
          // A turn that has already produced events has said something to the user; replacing the
          // session under it would lose whatever that was.
          || this.session.responseEventIds(event.response_id).length > 0
        ) {
          return
        }
        const queued = this.#host.findQueuedEvent(preemption.event_id)
        const oldGeneration = preemption.old_generation
        if (queued === undefined || oldGeneration === null) return

        const spent = this.#host.spendReconnectPermit(preemption)
        if (spent.deadline_fired) {
          // The alert already fenced the retained renderer generation. Anchor its uncertainty bound
          // now, before a slow reconnect; ordinary deferred alerts never consume this permit.
          this.#host.startPreemptiveAlertClearDeadline(oldGeneration)
        }
        const oldEpoch = this.session.sessionEpoch
        const history = this.#preemptiveAlertRecoveryHistory()
        try {
          const historyOutcome = await this.session.reconnectForPreemptiveAlert({
            tools: structuredClone(this.#providerSchemas),
            oldGeneration,
            confirmationTimeout: 0.5,
            history,
            historyMode: this.#preemptiveAlertHistoryRecovery,
          })
          this.#host.requireActivation()
          if (this.#preemptiveAlertHistoryRecovery !== 'none') {
            this.#telemetry?.record('guard.history_recovery', {
              arm: this.#preemptiveAlertHistoryRecovery,
              outcome: historyOutcome,
              item_count: history.length,
              pair_count: Math.floor(history.length / 2),
              character_count: history.reduce(
                (total, turn) => total + codePointLengthLikePython(turn.text),
                0,
              ),
            })
          }
          this.#awaitingUserOrigin = false
          this.#userOriginPreexistingResponseId = null
          this.#userOrigins.beginEpoch(this.session.sessionEpoch)
          this.#continuations.clearDeferred()
          this.#host.releaseUrgentHostResponseForEpoch(oldEpoch)
          this.#clearCaptions()
          this.#audioStarted.clear()
          this.#continuations.reconcileToolStateAfterReconnect(oldEpoch)
          this.#host.reopenFailedSemanticAcknowledgements()
          this.#host.reconcileSemanticAcknowledgementsAfterReconnect()
          const current = this.#host.currentPreemption
          // The world may have moved while reconnecting: a replacement preemption, or a user who
          // started speaking and revoked the authority this was borrowing.
          if (current?.token !== spent.token) return
          if (current.reconnect_aborted) {
            this.#host.clearPreemptiveAlert(current.token)
            return
          }
          this.#host.adoptReconnectedPreemption(current)
          await this.#host.deliverCapturedPreemptiveAlertLocked(queued)
        } catch (failure) {
          this.#telemetry?.record('guard.history_recovery_failure', {
            arm: this.#preemptiveAlertHistoryRecovery,
            reason: diagnosticName(failure),
          })
          this.#onDiagnostic(
            `[realtime-diagnostic] preemptive_alert_reconnect_failure type=${diagnosticName(failure)}`,
          )
          // A failed reconnect leaves no working provider and no way to speak the alert. Stopping is
          // the only honest outcome.
          this.#providerFailed = true
          this.#stop.abort()
          this.#deliveryReady.set()
        }
      })
    })
  }

  /** Recent conversation to hand a replacement provider, so it does not start blank. */
  #preemptiveAlertRecoveryHistory(): readonly RecoveryTurn[] {
    if (this.#preemptiveAlertHistoryRecovery === 'none') return []
    const channel = this.#runtime.memory?.channels.get('conversation')
    if (channel === undefined) return []
    const history = projectRecoveryTurns(channel.items, {maxPairs: this.#preemptiveAlertHistoryPairs})
    if (this.#preemptiveAlertHistoryRecovery === 'packed') return packRecoveryTurns(history).turns
    return history
  }

  deliveryState(): DeliverySnapshot {
    return {...this.#host.snapshot(), continuationOrder: this.#continuations.continuationOrder()}
  }

  /**
   * Drive the uncertain-delivery recovery directly.
   *
   * The path that normally reaches it runs inside the provider loop, which needs the unported event
   * pipeline. Exposed so the recovery policy -- one retry per item, never for a recovery item -- can be
   * tested on its own rather than waiting for the pipeline that would reach it.
   */
  reportUncertainDeliveryForTest(failure: ItemDeliveryUncertainError): Promise<void> {
    return this.#recoverUncertainDelivery(failure)
  }

  /**
   * How many user items are waiting for a response to claim them.
   *
   * The evidence boundary is invisible from outside otherwise: a spent item wrongly re-queued only
   * shows up later, as a tool call admitted against a turn the user has moved past.
   */
  get unboundUserOriginCountForTest(): number {
    return this.#userOrigins.unboundCount
  }

  /**
   * Drive a reconnect directly.
   *
   * The paths that normally reach it -- a recoverable provider error, an uncertain delivery, a full
   * refusal ledger -- each need their own setup, and the reconciliation this performs is worth testing
   * on its own rather than only through one of them.
   */
  reconnectForTest(expectedEpoch?: number): Promise<boolean> {
    return this.#reconnectProviderSession({
      reason: 'test',
      ...(expectedEpoch === undefined ? {} : {expectedEpoch}),
    })
  }

  /** Which responses a confirmation has blocked. The block outliving its turn is the failure mode. */
  get confirmationResponsesForTest(): readonly string[] {
    return this.#projectConfirmationIsolation.blockedResponses
      .map(response => callKey(response.sessionEpoch, response.responseId))
  }

  /** Items reserved as the answer to a proposal. One left here blocks every later turn. */
  get confirmationItemsForTest(): readonly string[] {
    const reserved = this.#projectConfirmationIsolation.reservation
    return reserved === null ? [] : [callKey(reserved.sessionEpoch, reserved.itemId)]
  }

  /** Items mid-close. One left here after an expiry would block every later turn. */
  get confirmationClosingItemsForTest(): readonly string[] {
    return [...this.#projectConfirmationClosingItems]
  }

  /** Drive invalidation directly, for the observer-failure case. */
  invalidateProjectConfirmationForTest(reason: string): void {
    this.#invalidateProjectConfirmation(reason)
  }

  /** Whether a confirmation is currently refusing tool calls. Invisible from outside otherwise. */
  get projectConfirmationBlockingForTest(): boolean {
    return this.#projectConfirmationIsBlocking()
  }

  /** Which response holds which user turn, in binding order. */
  get boundOriginsForTest(): readonly (readonly [string, string])[] {
    return this.#userOrigins.boundResponses
  }

  /** The runtime's delegate lookups, for a projection test that needs one to be in flight. */
  get sessionForTest(): RealtimeSession {
    return this.session
  }

  /** How many responses hold a user turn as their evidence. */
  get boundOriginCountForTest(): number {
    return this.#userOrigins.boundResponseCount
  }

  /** What the provider was handed at connect. Exposed so the copy can be checked, not assumed. */
  get providerSchemasForTest(): readonly Readonly<Record<string, JsonValue>>[] {
    return this.#providerSchemas
  }

  /** Wiring the unported families will need; exposed now so their absence is visible, not implied. */
  get preemptiveAlertConfiguration(): {
    readonly controlledReconnect: boolean
    readonly historyRecovery: PreemptiveAlertHistoryRecovery
    readonly historyPairs: number
  } {
    return {
      controlledReconnect: this.#controlledPreemptiveAlertReconnect,
      historyRecovery: this.#preemptiveAlertHistoryRecovery,
      historyPairs: this.#preemptiveAlertHistoryPairs,
    }
  }

  /** @deprecated Compatibility view for legacy configuration assertions. */
  get guardConfiguration(): {
    readonly controlledReconnect: boolean
    readonly historyRecovery: PreemptiveAlertHistoryRecovery
    readonly historyPairs: number
  } {
    return this.preemptiveAlertConfiguration
  }

  /**
   * State the unported families own, reachable without re-threading the constructor.
   *
   * Exposed deliberately rather than left private-and-unused: these are the seams families L, I, and
   * the event pipeline attach to, and naming them here is what makes the shape of what is missing
   * legible instead of implied.
   */
  get internals(): {
    readonly reconnectLock: Mutex
    readonly requeueHostItem: (queued: QueuedHostResponse) => void
    readonly nextUrgentDeliveryToken: () => number
    readonly nextPreemptiveAlertToken: () => number
    readonly bridge: RealtimeRuntimeBridge
    readonly tools: CompiledTools
    readonly runtime: ServiceRuntime
    readonly idFactory: () => string
    readonly toolCalls: ReadonlyMap<string, ToolCallState>
    readonly overflowToolCalls: ReadonlyMap<string, ToolCallState>
    readonly continuationBatches: ReadonlyMap<string, ContinuationBatch>
    readonly continuationFifo: readonly string[]
    readonly semanticAcknowledgements: ReadonlyMap<string, SemanticAcknowledgement>
    readonly audioStarted: ReadonlySet<string>
    readonly onProviderTerminal: (generation: PlaybackGeneration) => void
    readonly onExecutorState: (state: ExecutorState) => void
    readonly clearCaptions: () => void
    readonly setExecutorState: (state: ExecutorState) => void
  } {
    return {
      reconnectLock: this.#reconnectLock,
      requeueHostItem: (queued: QueuedHostResponse) => {
        this.#host.requeueHostItem(queued)
      },
      nextUrgentDeliveryToken: () => {
        return this.#host.nextUrgentDeliveryToken()
      },
      nextPreemptiveAlertToken: () => {
        return this.#host.nextPreemptiveAlertToken()
      },
      bridge: this.#bridge,
      tools: this.#tools,
      runtime: this.#runtime,
      idFactory: this.#idFactory,
      toolCalls: this.#continuations.callsForTest(),
      overflowToolCalls: this.#continuations.overflowCallsForTest(),
      continuationBatches: this.#continuations.batchesForTest(),
      continuationFifo: this.#continuations.continuationOrderForTest(),
      semanticAcknowledgements: this.#host.acknowledgementsForTest(),
      audioStarted: this.#audioStarted,
      onProviderTerminal: this.#onProviderTerminal,
      onExecutorState: this.#onExecutorState,
      clearCaptions: () => {
        this.#clearCaptions()
      },
      setExecutorState: (state: ExecutorState) => {
        this.#executorState = state
        this.#onExecutorState(state)
      },
    }
  }
}

/**
 * Whether a promise settled inside the grace period.
 *
 * Rejections propagate -- a provider that refused to close reported something the caller has to see --
 * while a promise that never settles at all resolves to `false` so the caller can say so and move on.
 */
async function resolvedWithin(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), graceMs)
  })
  try {
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Wait for every task, but not forever.
 *
 * Returns how many were still running when the grace period ran out. A JavaScript promise cannot be
 * cancelled the way an asyncio task can, so a loop that ignored its abort signal would make `close`
 * hang -- and a service that never finishes closing is worse than one that names a task it could not
 * stop. Every loop here observes the signal, so reaching the timeout means one is genuinely stuck.
 */
async function settleWithin(tasks: readonly Promise<void>[], graceMs: number): Promise<number> {
  if (tasks.length === 0) return 0
  let outstanding = tasks.length
  const settled = tasks.map(task => task.then(
    () => {
      outstanding -= 1
    },
    () => {
      outstanding -= 1
    },
  ))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, graceMs)
  })
  await Promise.race([Promise.all(settled), deadline])
  if (timer !== undefined) clearTimeout(timer)
  return outstanding
}

/** A callback that was not supplied. Named so two of them are not two anonymous empty functions. */
function noop(): void {
  // Intentionally empty: an absent observer is not an error.
}

function projectCommitSuccessText(
  operation: ConfirmedProjectOperation,
  code: string,
): string {
  if (code !== 'committed') return '已确认，已提交并正在启动。'
  if (operation.action === 'create') {
    return `已确认，已创建并切换到工作区 ${operation.workspace_display_name}。`
  }
  if (operation.action === 'select') {
    return `已确认，已切换到工作区 ${operation.workspace_display_name}。`
  }
  return '已确认，项目操作已完成。'
}

/** Wrap whatever was thrown so it can be re-thrown as an Error without losing the original. */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  const wrapped = new Error(`provider close failed: ${String(cause)}`)
  wrapped.cause = cause
  return wrapped
}

/**
 * Seconds as the oracle's `f"{value:.0f}"` renders them.
 *
 * Python rounds half to even and JavaScript's `toFixed` rounds half away from zero, so 0.5 renders as
 * "0" there and "1" here. Reproduced explicitly because this string is spoken to the user.
 */
export function formatSeconds(value: number): string {
  const floor = Math.floor(value)
  const remainder = value - floor
  if (remainder > 0.5) return `${floor + 1}`
  if (remainder < 0.5) return `${floor}`
  return `${floor % 2 === 0 ? floor : floor + 1}`
}

function randomHex(): string {
  // 32 hex characters, matching the oracle's `uuid4().hex`.
  return randomUUID().replaceAll('-', '')
}

/** Stable within one proposal transition, distinct across proposal lifecycles. */
function projectConfirmationEventId(
  namespace: 'project-confirmation' | 'project-confirmation-retry',
  lifecycleId: string,
  transition: string,
): string {
  const digest = createHash('sha256')
    .update(lifecycleId)
    .update('\0')
    .update(transition)
    .digest('hex')
  return `${namespace}:${digest}`
}

export type { HostContextItem,PlaybackCompletion }
