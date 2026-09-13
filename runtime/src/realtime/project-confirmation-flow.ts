import {createHash} from 'node:crypto'
import type {ApprovalHost} from '../core/approval.js'
import type {Clock} from '../core/clock.js'
import {
  type IntakeEventPort,
  type IntakeOptions,
} from '../executors/coding/intake.js'
import {
  USER_PRIORITY
} from '../core/memory.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
  ProjectConfirmationView,
} from '../projects/project-confirmation.js'
import {CONFIRM_TOOL, confirmArguments} from '../core/work-tools.js'
import type {ToolCallReady} from './bridge.js'
import {ConfirmationTurnIsolation} from './confirmation-turn-isolation.js'
import {type CodingChannel} from './evidence.js'
import type {
  HostContextItem,
  HostResponseIntent,
  RealtimeProviderEvent,
} from './protocol.js'
import type {BoundToolOrigin, HostItemOptions, ProviderReconnectReason} from './service-ports.js'
import {
  MAX_HOST_FACT_CHARS,
  MAX_TRACKED_TOOL_CALLS, USER_HOLD_MAX_S,
  callKey, diagnosticName, hostFactIntent, isAbort, parseCallKey,
  projectCommitFailureText, type ProjectExpiryBatch
} from './service-state.js'
import {RealtimeDeliveryError, type RealtimeSession} from './session.js'
import type {RealtimeTelemetry} from './telemetry.js'
import type {ToolContinuations} from './tool-continuations.js'
import type {UserOriginBindingLedger} from './user-origin-binding.js'

interface ProjectConfirmationDecisionRetry {
  readonly item_key: string
  readonly source_response_id: string
  requested: boolean
  retry_response_id: string | null
}

const PROJECT_CONFIRMATION_CARRIER_RELEASE_TIMEOUT_S = 3

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

interface ProjectConfirmationPorts {
  readonly session: RealtimeSession
  readonly clock: Clock
  readonly projectConfirmation: ProjectConfirmationController | undefined
  readonly approvalHost: ApprovalHost
  readonly coding: CodingChannel | null
  readonly telemetry: RealtimeTelemetry | undefined
  readonly idFactory: () => string
  readonly onDiagnostic: (line: string) => void
  readonly intake: () => IntakeEventPort | undefined
  readonly commitProjectOperation: ((operation: ConfirmedProjectOperation) => Promise<{readonly accepted: boolean; readonly code: string; readonly delegate_id?: string}>) | undefined
  readonly onProjectView: ((view: ProjectConfirmationView) => void) | undefined
  readonly projectViewProvider: ((pending: boolean) => ProjectConfirmationView) | undefined
  readonly projectExpiryStepTimeoutMs: number
  readonly userOrigins: Pick<UserOriginBindingLedger, 'itemForResponse' | 'revisionForItem' | 'hasOriginRef' | 'bindRetryResponse'>
  readonly bindResponseUserOrigin: (epoch: number, response: string) => void
  readonly failOriginTranscriptAndRefresh: (epoch: number, item: string) => void
  readonly continuations: Pick<ToolContinuations, 'takeDeferredForItem' | 'takeConfirmationDeferredCalls' | 'abandonProjectConfirmationContinuation' | 'releaseDeferredOriginCalls'>
  readonly reconnectProviderSession: (options: {readonly reason: ProviderReconnectReason; readonly expectedEpoch?: number}) => Promise<boolean>
  readonly deliveryPass: () => Promise<void>
  readonly queueHostItem: (intent: HostResponseIntent, options?: HostItemOptions) => void
  readonly wakeDelivery: () => void
  readonly reportDeliveryFailure: (failure: RealtimeDeliveryError) => void
  readonly stopSignal: () => AbortSignal
  readonly conversationClearRevision: () => number
  readonly clearingConversation: () => boolean
}
export class ProjectConfirmationFlow {
  reset(): void {
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
  }
  unsubscribeExpiry(): void {
    if (this.#unsubscribeProjectExpiry !== null) {
      this.#unsubscribeProjectExpiry()
      this.#unsubscribeProjectExpiry = null
    }
  }
  subscribeExpiry(): void {
    this.#unsubscribeProjectExpiry = this.#ports.projectConfirmation?.observeExpiry(() => {
      const proposalId = this.#ports.projectConfirmation?.lifecycleId
      this.#projectConfirmationExpired()
      if (proposalId !== undefined && proposalId !== null) this.#ports.intake()?.decline(proposalId)
    }) ?? null
  }
  prepareIntake(intake: Parameters<NonNullable<IntakeOptions['prepare']>>[0]): ReturnType<NonNullable<IntakeOptions['prepare']>> {
    if (intake.target === null || this.#ports.projectConfirmation === undefined) throw new TypeError('intake_confirmation_unavailable')
    const target = intake.target
    const proposal = this.#ports.projectConfirmation.prepare({
      action: target.action, workspace_display_name: target.workspace_display_name,
      workspace_id: target.workspace_id,
      session_title: target.action === 'create' || target.action === 'reuse' ? intake.title : target.session_title,
      session_id: target.session_id,
      work_order: intake.work_order, origin_ref: intake.origin_ref,
      intake_id: intake.intake_id, plan_revision: intake.plan_revision!,
    })
    this.syncProjectConfirmationIsolation()
    this.#publishProjectView()
    return proposal
  }
  beforeEvent(event: RealtimeProviderEvent): {readonly confirmationFencePendingAtStart: boolean; readonly confirmationResponseStartsDuringSpeech: boolean} {
    const confirmationFencePendingAtStart = this.#projectConfirmationIsolation.responseFencePending
    const confirmationResponseStartsDuringSpeech = event.kind === 'response_started'
      && event.session_epoch === this.session.sessionEpoch
      && this.session.floor.state === 'user_speaking'
      && !this.#projectConfirmationIsolation.responseFencePending
      && this.#projectConfirmationIsolation.reservation?.sessionEpoch === event.session_epoch
    return {confirmationFencePendingAtStart, confirmationResponseStartsDuringSpeech}
  }
  afterEventAccepted(event: RealtimeProviderEvent, accepted: boolean, confirmationFencePendingAtStart: boolean, confirmationResponseStartsDuringSpeech: boolean): void {
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
        if (this.#ports.userOrigins.itemForResponse(event.session_epoch, event.response_id) === undefined) {
          if (!this.#bindProjectConfirmationRetryResponse(event.session_epoch, event.response_id)) {
            this.#ports.bindResponseUserOrigin(event.session_epoch, event.response_id)
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
      this.#ports.telemetry?.record('project_confirmation.response_started', {
        session_epoch: event.session_epoch,
        response_id: event.response_id,
        accepted,
        started_during_user_speech: confirmationResponseStartsDuringSpeech,
        fence_pending: confirmationFencePendingAtStart,
        origin_bound: accepted
          && this.#ports.userOrigins.itemForResponse(event.session_epoch, event.response_id) !== undefined,
        confirmation_item_count: this.#projectConfirmationIsolation.reservation === null ? 0 : 1,
        proposal_id: this.#ports.projectConfirmation?.lifecycleId ?? 'none',
        proposal_origin_ref: this.#ports.projectConfirmation?.proposalOriginRef ?? 'none',
        delegate_origin_ref: this.#ports.projectConfirmation?.proposalOriginRef ?? 'none',
        user_input_revision: this.session.providerTurnUserInputRevision(event.response_id) ?? -1,
        item_id: this.#ports.userOrigins.itemForResponse(
          event.session_epoch,
          event.response_id,
        ) ?? 'none',
      })
    }
  }
  async settleTerminal(event: Extract<RealtimeProviderEvent, {kind: 'response_terminal'}>, itemId: string | undefined): Promise<void> {
    if (
      itemId !== undefined
      && this.#isProjectConfirmationItem(event.session_epoch, itemId)
    ) {
      const controller = this.#ports.projectConfirmation
      const itemKey = callKey(event.session_epoch, itemId)
      const retry = this.#projectConfirmationDecisionRetry
      const isRetryTerminal = retry?.item_key === itemKey
        && retry.retry_response_id === event.response_id
      // A transport-level cancelled/failed terminal can be just as empty as completed. What
      // matters at this boundary is whether the response supplied any audible decision, not the
      // provider's terminal label.
      const silentTerminal = !this.session.responseHasSpoken(event.response_id)
      this.#ports.telemetry?.record('project_confirmation.response_terminal', {
        session_epoch: event.session_epoch,
        response_id: event.response_id,
        item_id: itemId,
        status: event.status,
        transcript_ready: this.#ports.userOrigins.hasOriginRef(event.session_epoch, itemId),
        decision_seen: false,
        retry_attempt: isRetryTerminal ? 1 : 0,
        user_input_revision: this.#ports.userOrigins.revisionForItem(
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
          this.#ports.telemetry?.record('project_confirmation.decision_retry_exhausted', {
            session_epoch: event.session_epoch,
            item_id: itemId,
            response_id: event.response_id,
            proposal_id: controller?.lifecycleId ?? 'none',
            proposal_origin_ref: controller?.proposalOriginRef ?? 'none',
            delegate_origin_ref: controller?.proposalOriginRef ?? 'none',
            user_input_revision: this.#ports.userOrigins.revisionForItem(
              event.session_epoch,
              itemId,
            ) ?? -1,
            reason: 'no_confirmation_function',
          })
        }
      }
    }
  }
  clearTerminalShadow(epoch: number, itemId: string | undefined): void {
    if (itemId !== undefined) {
      this.#projectConfirmationShadowItems.delete(callKey(epoch, itemId))
    }
  }
  async afterTranscriptFinal(event: Extract<RealtimeProviderEvent, {kind: 'user_transcript_final'}>, originRef: string): Promise<void> {
    if (
      this.#isProjectConfirmationItem(event.session_epoch, event.item_id)
      && this.#ports.projectConfirmation?.pending !== true
    ) {
      await this.#closeConfirmationDeferredCalls(event.item_id)
    } else if (this.isProjectConfirmationShadowItem(event.session_epoch, event.item_id)) {
      await this.#closeConfirmationDeferredCalls(event.item_id)
    } else {
      await this.#ports.continuations.releaseDeferredOriginCalls(event.item_id, originRef)
    }
    if (this.#isProjectConfirmationItem(event.session_epoch, event.item_id)) {
      await this.#maybeRequestProjectConfirmationDecisionRetry(event.session_epoch, event.item_id)
    }
  }
  async afterTranscriptFailed(event: Extract<RealtimeProviderEvent, {kind: 'user_transcript_failed'}>): Promise<void> {
    if (this.#isProjectConfirmationItem(event.session_epoch, event.item_id)) {
      await this.#failProjectConfirmation(event.session_epoch, event.item_id)
    } else if (this.isProjectConfirmationShadowItem(event.session_epoch, event.item_id)) {
      await this.#closeConfirmationDeferredCalls(event.item_id)
    } else {
      await this.#ports.continuations.releaseDeferredOriginCalls(event.item_id, null)
    }
  }
  clearTerminal(event: Extract<RealtimeProviderEvent, {kind: 'response_terminal'}>): void {
    this.#projectConfirmationIsolation.clearResponse({
      sessionEpoch: event.session_epoch,
      responseId: event.response_id,
    })
    if (this.#projectConfirmationPendingQuarantineEpoch === event.session_epoch) {
      this.#projectConfirmationPendingQuarantineEpoch = null
    }
  }

  responseIsQuarantined(sessionEpoch: number, responseId: string): boolean {
    return this.#projectConfirmationIsolation.responseState({sessionEpoch, responseId})?.quarantined === true
  }
  discardPendingExpiries(): void {this.#projectExpiryBatches.length = 0}
  expiryDrain(): Promise<void> | null {return this.#projectExpiryDraining}
  carrierReleaseTasks(): readonly Promise<void>[] {return [...this.#projectConfirmationCarrierReleaseTasks]}
  get proposalId(): string | null | undefined {return this.#ports.projectConfirmation?.lifecycleId}
  get proposalOriginRef(): string | null | undefined {return this.#ports.projectConfirmation?.proposalOriginRef}

  readonly #ports: ProjectConfirmationPorts
  constructor(ports: ProjectConfirmationPorts) {this.#ports = ports}
  get session(): RealtimeSession {return this.#ports.session}

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

  async projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void> {
    const controller = this.#ports.projectConfirmation
    const lifecycleId = controller?.lifecycleId ?? 'none'
    this.#ports.telemetry?.record('project_confirmation.ui_decision_requested', {
      proposal_id: proposalId,
      confirmed,
      lifecycle_id: lifecycleId,
    })
    if (controller === undefined) return
    const outcome = controller.acceptDirectDecision({proposalId, confirmed})
    if (outcome.kind === 'cancelled') this.#ports.intake()?.decline(proposalId)
    if (outcome.kind === 'ignored') {
      this.#ports.telemetry?.record('project_confirmation.ui_decision_refused', {
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
          await this.#ports.reconnectProviderSession({
            reason: 'project_confirmation_ui_retry',
            expectedEpoch: this.session.sessionEpoch,
          })
        } catch (failure) {
          this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
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
    this.#ports.telemetry?.record('project_confirmation.ui_decision_completed', {
      proposal_id: proposalId,
      outcome: outcome.kind,
      state,
    })
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
  confirmTarget(event: ToolCallReady): 'approval' | 'project' | 'none' | null {
    if (event.name !== CONFIRM_TOOL) return null
    const id = confirmArguments(event.arguments)?.id ?? null
    const project = this.#ports.projectConfirmation
    if (id !== null && this.#ports.approvalHost.ownsId(id)) return 'approval'
    if (id !== null && project?.lifecycleId === id) return 'project'
    if (id !== null) return 'none'
    if (project?.pending === true) return 'project'
    if (this.#ports.approvalHost.pending) return 'approval'
    if (
      event.response_id !== null
      && this.#ports.approvalHost.isExecutorApprovalResponseQuarantined(event.session_epoch, event.response_id)
    ) return 'approval'
    return 'none'
  }

  // ---------------------------------------------------------------------------------------------
  // Family N: the acknowledgement a delegated call owes the user.
  // ---------------------------------------------------------------------------------------------

  /** Mirror a newly visible controller lifecycle without importing its expiry policy. */
  syncProjectConfirmationIsolation(): void {
    const controller = this.#ports.projectConfirmation
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
    this.#ports.approvalHost.hold()
    const current = this.#projectConfirmationIsolation.authority
    if (current?.authorityId === lifecycleId && current.sessionEpoch === sessionEpoch) return
    const remaining = controller.view.pending_expires_in_seconds
    if (remaining === undefined || remaining === null || !Number.isFinite(remaining)) return
    this.#projectConfirmationIsolation.beginAuthority({
      authorityId: lifecycleId,
      sessionEpoch,
      createdUserRevision: this.session.userInputRevision,
      expiresAt: this.#ports.clock.now() + Math.max(0, remaining),
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
  reserveProjectConfirmation(event: {
    readonly session_epoch: number
    readonly provider_item_id: string | null
  }): void {
    if (this.#ports.projectConfirmation?.pending !== true) return
    const itemId = event.provider_item_id
    if (itemId === null) {
      const lifecycleId = this.#projectConfirmationLifecycleId()
      this.invalidateProjectConfirmation('missing_item_correlation')
      this.#queueProjectConfirmationFact(
        '缺少语音确认关联，本次操作已取消。',
        lifecycleId,
        'missing-item-correlation',
      )
      return
    }
    if (!this.#ports.projectConfirmation.reserveUserItem({epoch: event.session_epoch, itemId})) {
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
      this.invalidateProjectConfirmation('missing_item_correlation')
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
    const itemId = this.#ports.userOrigins.itemForResponse(epoch, responseId)
    const revision = itemId === undefined
      ? undefined
      : this.#ports.userOrigins.revisionForItem(epoch, itemId)
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
    const revision = this.#ports.userOrigins.revisionForItem(epoch, item.id)
    if (revision === undefined || !this.session.responseMatchesUserItem(responseId, item.id, revision)) return false
    if (!this.#ports.userOrigins.bindRetryResponse({epoch, responseId, itemId: item.id})) return false
    const isolated = this.#projectConfirmationIsolation.bindRetryResponse({
      sessionEpoch: epoch,
      itemId: item.id,
      userRevision: revision,
      responseId,
    })
    if (isolated !== 'bound' && isolated !== 'idempotent') return false
    retry.retry_response_id = responseId
    this.#ports.telemetry?.record('project_confirmation.decision_retry_started', {
      session_epoch: epoch,
      item_id: item.id,
      response_id: responseId,
      source_response_id: retry.source_response_id,
      proposal_id: this.#ports.projectConfirmation?.lifecycleId ?? 'none',
      proposal_origin_ref: this.#ports.projectConfirmation?.proposalOriginRef ?? 'none',
      delegate_origin_ref: this.#ports.projectConfirmation?.proposalOriginRef ?? 'none',
      user_input_revision: this.#ports.userOrigins.revisionForItem(epoch, item.id) ?? -1,
    })
    return true
  }

  /** Once the same turn's transcript exists, ask the provider once more for the structured decision. */
  async #maybeRequestProjectConfirmationDecisionRetry(epoch: number, itemId: string): Promise<void> {
    const retry = this.#projectConfirmationDecisionRetry
    const controller = this.#ports.projectConfirmation
    if (
      retry?.item_key !== callKey(epoch, itemId)
      || retry.requested
      || !this.#ports.userOrigins.hasOriginRef(epoch, itemId)
      || controller?.pending !== true
    ) return
    retry.requested = true
    this.#ports.telemetry?.record('project_confirmation.decision_retry_requested', {
      session_epoch: epoch,
      item_id: itemId,
      source_response_id: retry.source_response_id,
      proposal_id: controller.lifecycleId ?? 'none',
      transcript_ready: true,
      retry_attempt: 1,
      proposal_origin_ref: controller.proposalOriginRef ?? 'none',
      delegate_origin_ref: controller.proposalOriginRef ?? 'none',
      user_input_revision: this.#ports.userOrigins.revisionForItem(epoch, itemId) ?? -1,
    })
    let requested = false
    try {
      requested = await this.session.requestUserResponse()
    } catch (failure) {
      this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
        ? failure
        : new RealtimeDeliveryError(String(failure)))
    }
    if (requested) return

    controller.releaseUndecided({epoch, itemId})
    this.#endProjectConfirmationItem(epoch, itemId)
    this.#ports.telemetry?.record('project_confirmation.decision_retry_exhausted', {
      session_epoch: epoch,
      item_id: itemId,
      response_id: retry.source_response_id,
      proposal_id: controller.lifecycleId ?? 'none',
      reason: 'provider_retry_unavailable',
      proposal_origin_ref: controller.proposalOriginRef ?? 'none',
      delegate_origin_ref: controller.proposalOriginRef ?? 'none',
      user_input_revision: this.#ports.userOrigins.revisionForItem(epoch, itemId) ?? -1,
    })
  }

  /**
   * Whether this tool call arrives in a turn that is supposed to be waiting for a confirmation.
   *
   * Blocked by *epoch* as well as by response, because a reconnect renumbers responses and a
   * confirmation spanning one would otherwise stop blocking. Recording the response id on the way
   * through is what makes the block stick for the rest of that turn.
   */
  blocksProjectConfirmationTool(event: {
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

  isProjectConfirmationShadowItem(epoch: number, itemId: string): boolean {
    return this.#projectConfirmationShadowItems.has(callKey(epoch, itemId))
  }

  /** A shadow turn is still transcribed into Memory, but it cannot speak or execute tools. */
  suppressShadowConfirmationResponse(epoch: number, responseId: string): void {
    const itemId = this.#ports.userOrigins.itemForResponse(epoch, responseId)
    if (itemId === undefined || !this.isProjectConfirmationShadowItem(epoch, itemId)) return
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

  async handleProjectConfirmationDecision(
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
    const decisionGate = new Promise<void>(resolve => {releaseDecisionGate = resolve})
    this.#projectConfirmationDecisionGates.set(call, decisionGate)

    let code = 'confirmation_not_pending'
    let state = 'refused'
    let confirmationText: string | null = null
    let confirmationResponseId: string | null = null
    try {
      const itemId = origin.originItemId
      const controller = this.#ports.projectConfirmation
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
        this.#ports.onDiagnostic(
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
        this.#ports.telemetry?.record('project_confirmation.binding_missing', {
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
          userRevision: this.#ports.userOrigins.revisionForItem(event.session_epoch, itemId) ?? -1,
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
          if (outcome.kind === 'cancelled') this.#ports.intake()?.decline(decision.id)
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
        host_item_id: this.#ports.idFactory(),
        event_id: this.#ports.idFactory(),
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
    if (intakeOperation && this.#ports.intake()?.beginConfirmed(operation) !== true) {
      this.#ports.projectConfirmation?.rejectConfirmed(operation)
      return {state: 'failed', text: '计划已失效，尚未执行。请重新提出任务。', expiryOwnsFact: false}
    }
    const callback = this.#ports.commitProjectOperation
    const lifecycleId = operation.proposal_id
    this.#projectConfirmationCommittingLifecycles.add(lifecycleId)
    this.#ports.telemetry?.record('project_confirmation.commit_started', {
      session_epoch: this.session.sessionEpoch,
      proposal_id: operation.proposal_id,
      proposal_origin_ref: operation.origin_ref,
      delegate_origin_ref: operation.origin_ref,
      expires_at: operation.expires_at,
    })
    if (callback === undefined) {
      if (intakeOperation) this.#ports.intake()?.settleConfirmed({accepted: false, code: 'callback_missing'})
      this.#ports.projectConfirmation?.rollbackConfirmed(operation)
      this.#ports.telemetry?.record(this.#ports.projectConfirmation?.pending === true
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
      const controller = this.#ports.projectConfirmation
      this.#ports.telemetry?.record('project_confirmation.commit_admission', {
        session_epoch: this.session.sessionEpoch,
        proposal_id: operation.proposal_id,
        proposal_origin_ref: operation.origin_ref,
        delegate_origin_ref: operation.origin_ref,
        accepted: result.accepted,
        code: result.code,
        delegate_id: result.delegate_id ?? 'none',
      })
      if (result.accepted && controller?.committing === true) {
        if (intakeOperation) this.#ports.intake()?.settleConfirmed({accepted: false, code: 'confirmation_invalid'})
        controller.rejectConfirmed(operation)
        this.#ports.telemetry?.record('project_confirmation.commit_settled', {
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
      if (intakeOperation) this.#ports.intake()?.settleConfirmed(result)
      const transitionKind = result.code === 'confirmation_in_progress'
        ? 'project_confirmation.commit_duplicate_suppressed'
        : controller?.pending === true
          ? 'project_confirmation.commit_rollback'
          : 'project_confirmation.commit_settled'
      this.#ports.telemetry?.record(transitionKind, {
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
            : projectCommitFailureText(result.code, this.#ports.coding?.display_name),
      })
    } catch (failure) {
      if (intakeOperation) this.#ports.intake()?.settleConfirmed({accepted: false, code: 'callback_failed'})
      if (isAbort(failure)) {
        this.#projectConfirmationCommittingLifecycles.delete(lifecycleId)
        this.#projectConfirmationExpiryFactOwners.delete(lifecycleId)
        throw failure
      }
      this.#ports.projectConfirmation?.rollbackConfirmed(operation)
      this.#ports.telemetry?.record(this.#ports.projectConfirmation?.pending === true
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
    const controller = this.#ports.projectConfirmation
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
    this.#ports.failOriginTranscriptAndRefresh(event.session_epoch, itemId)
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
    const controller = this.#ports.projectConfirmation
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
  async closeProjectConfirmationTool(event: ToolCallReady): Promise<void> {
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
      host_item_id: this.#ports.idFactory(),
      event_id: this.#ports.idFactory(),
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
    const matching = this.#ports.continuations.takeDeferredForItem(itemId)
    for (const call of matching) {
      await this.closeProjectConfirmationTool(call.event)
    }
  }

  /** Say something to the user about the confirmation. Just below user priority: urgent, not louder. */
  #queueProjectConfirmationFact(text: string, lifecycleId: string, transition: string): void {
    this.#ports.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#ports.idFactory(),
      event_id: projectConfirmationEventId('project-confirmation', lifecycleId, transition),
      content: [...text].slice(0, MAX_HOST_FACT_CHARS).join(''),
    }), {priority: USER_PRIORITY - 1, preemptive: false})
    this.#ports.wakeDelivery()
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
    this.#ports.continuations.abandonProjectConfirmationContinuation(sessionEpoch, responseId)
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
        this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
        await this.recoverProjectConfirmationCarrier(
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
        this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
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
    await this.#ports.clock.sleep(PROJECT_CONFIRMATION_CARRIER_RELEASE_TIMEOUT_S, this.#ports.stopSignal())
    await this.recoverProjectConfirmationCarrier(sessionEpoch, responseId, 'terminal_timeout')
  }

  async recoverProjectConfirmationCarrier(
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
    this.#ports.telemetry?.record('project_confirmation.carrier_recovery', {
      session_epoch: sessionEpoch,
      response_id: responseId,
      reason,
    })
    await this.#ports.reconnectProviderSession({
      reason: 'project_confirmation_carrier_recovery',
      expectedEpoch: sessionEpoch,
    })
  }

  async #recoverProjectConfirmationCarrierAfterStaleUserHold(key: string): Promise<void> {
    if (!await this.session.waitForStaleHold(USER_HOLD_MAX_S)) return
    const pending = this.#projectConfirmationCarrierReconnectAfterUser.get(key)
    if (pending === undefined) return
    if (this.session.releaseStaleUserHold(USER_HOLD_MAX_S)) {
      this.#ports.onDiagnostic('[realtime-diagnostic] project_confirmation_stale_user_hold_released')
    }
    await this.recoverProjectConfirmationCarrier(
      pending.sessionEpoch,
      pending.responseId,
      pending.reason,
    )
  }

  async resumeProjectConfirmationCarrierRecoveryAfterUser(): Promise<void> {
    if (this.session.floor.state === 'user_speaking') return
    const pending = [...this.#projectConfirmationCarrierReconnectAfterUser.values()]
    this.#projectConfirmationCarrierReconnectAfterUser.clear()
    for (const carrier of pending) {
      await this.recoverProjectConfirmationCarrier(
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
        this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
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
    const lifecycleId = this.#ports.projectConfirmation?.lifecycleId
    if (lifecycleId !== null && lifecycleId !== undefined) return lifecycleId
    this.#ports.onDiagnostic('[realtime-diagnostic] project_confirmation_lifecycle_missing')
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
    const signal = this.#ports.stopSignal()
    this.#projectExpiryDraining = this.#drainProjectConfirmationExpiries(signal)
      .catch((failure: unknown) => {
        this.#ports.onDiagnostic(
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
    const clearRevision = this.#ports.conversationClearRevision()
    if (this.#ports.clearingConversation()) return
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
        || this.#ports.clearingConversation()
        || clearRevision !== this.#ports.conversationClearRevision()
      ) return
      const deferred = this.#ports.continuations.takeConfirmationDeferredCalls(batch.source_epoch)
      if (deferred.length === 0) break
      for (const call of deferred) {
        try {
          const completed = await this.#runProjectExpiryStep(
            this.closeProjectConfirmationTool(call.event),
          )
          closeFailed = closeFailed || !completed
          if (
            this.#ports.clearingConversation()
            || clearRevision !== this.#ports.conversationClearRevision()
          ) return
        } catch {
          closeFailed = true
        }
      }
    }
    if (
      signal.aborted
      || this.#ports.clearingConversation()
      || clearRevision !== this.#ports.conversationClearRevision()
    ) return
    if (batch.reconnect || closeFailed) {
      try {
        await this.#runProjectExpiryStep(
          this.#ports.reconnectProviderSession({
            reason: 'project_confirmation_expiry_cleanup',
            expectedEpoch: batch.source_epoch,
          }),
        )
      } catch (failure) {
        this.#ports.onDiagnostic(
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
      || this.#ports.clearingConversation()
      || clearRevision !== this.#ports.conversationClearRevision()
    ) return
    this.#queueProjectConfirmationFact(
      '确认已过期，本次操作已取消。',
      batch.lifecycle_id,
      'expired',
    )
    try {
      await this.#runProjectExpiryStep(this.#ports.deliveryPass())
    } catch (failure) {
      this.#ports.onDiagnostic(
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
      timer = setTimeout(() => resolve(false), this.#ports.projectExpiryStepTimeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #publishProjectView(): void {
    const controller = this.#ports.projectConfirmation
    if (controller === undefined) return
    try {
      this.#ports.onProjectView?.(
        this.#ports.projectViewProvider?.(controller.pending || controller.committing) ?? controller.view,
      )
    } catch {
      // A renderer that cannot accept the view must not prevent the state change that produced it.
    }
    // Spec 08: an executor approval that waited behind this confirmation gets a fresh TTL and is
    // voice-armed once it is over. `release` publishes, and the observer runs the host sync
    // with the re-armed view; a head that was never held is synced directly.
    if (!controller.pending && !controller.committing) this.#ports.approvalHost.release()
  }

  /**
   * Drop the proposal and every trace of its isolation.
   *
   * Called when the world the proposal described has changed underneath it -- a reconnect, a new
   * provider session -- so confirming it would commit against a context the user never saw.
   */
  invalidateProjectConfirmation(reason: string): void {
    if (reason !== 'intake_amended') this.#ports.intake()?.cancel()
    this.#ports.projectConfirmation?.invalidate(reason)
    this.#projectConfirmationIsolation.invalidate()
    this.#projectConfirmationShadowItems.clear()
    this.#projectConfirmationClosingItems.clear()
    this.#projectConfirmationCarrierReconnectAfterUser.clear()
    this.#projectConfirmationPendingQuarantineEpoch = null
    this.#projectConfirmationDecisionRetry = null
    this.#publishProjectView()
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

  /** Whether a confirmation is currently refusing tool calls. Invisible from outside otherwise. */
  get projectConfirmationBlockingForTest(): boolean {
    return this.#projectConfirmationIsBlocking()
  }
}
