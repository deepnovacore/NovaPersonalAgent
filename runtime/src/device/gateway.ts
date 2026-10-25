import {Authority, type Bindings, type Clock, type DispatchRequest, type Fence} from './authority.js'
import {advanceAttempt} from './attempt.js'
import {recordReceipt, type Receipt, type RequestIdentity} from './ownership.js'
import type {DeviceLedger, DeviceState} from './ledger.js'
import type {StopRevoker} from './port.js'

export class DeviceGateway implements StopRevoker {
  private readonly unpersistedStops = new Set<string>()
  constructor(readonly ledger: DeviceLedger, private readonly clock: Clock = {now: () => Date.now()}) {}
  private drainStops(state: DeviceState): void {
    const authority = new Authority(state.authority, this.clock)
    for (const taskId of new Set([...state.pending_stops, ...this.unpersistedStops])) {
      if (state.authority.tasks.some(task => task.bindings.task_id === taskId)) authority.revokeForStop(taskId)
    }
    // Retain stop tombstones, including tasks not yet registered.
    state.pending_stops = [...new Set([...state.pending_stops, ...this.unpersistedStops])]
  }
  private async change<T>(action: (state: DeviceState, authority: Authority) => T): Promise<T> {
    // Commit recovery separately so a rejected request cannot roll back pending revocations.
    await this.ledger.transaction(state => this.drainStops(state))
    return this.ledger.transaction(state => {
      this.drainStops(state)
      return action(state, new Authority(state.authority, this.clock))
    })
  }
  createGrant(grantRef: string, bindings: Bindings): Promise<void> {
    return this.change((state, authority) => {
      if (state.pending_stops.includes(bindings.task_id)) throw Error('approval_revoked')
      authority.createGrant(grantRef, bindings)
    })
  }
  approveGrant(grantRef: string): Promise<void> {
    return this.change((_state, authority) => authority.approveGrant(grantRef))
  }
  authorizeDispatch(request: DispatchRequest): Promise<{intent: 'prepared'; replayed: boolean}> {
    return this.change((state, authority) => {
      const result = authority.authorizeDispatch(request)
      if (!result.replayed) {
        const prepared = advanceAttempt({
          task_phase: 'queued', attempt: {id: request.operation_id, status: 'none', dispatch_started: false},
          effects: 0, evidence: [], action_grant_ref: request.grant_ref,
        }, {op: 'persist_intent'})
        state.attempts.push({operation_id: request.operation_id,
          state: advanceAttempt(prepared, {op: 'mark_dispatch_started'})})
      }
      return result
    })
  }
  recordReceipt(operationId: string, identity: RequestIdentity, payloadDigest: string,
    receipt: Pick<Receipt, 'id' | 'status'>): Promise<{receipt: Receipt; replayed: boolean}> {
    return this.change((state) => {
      const attempt = state.attempts.find(item => item.operation_id === operationId)
      if (!attempt) throw Error('stale_fence')
      const recorded = recordReceipt(state.ownership, identity, payloadDigest, receipt)
      if (recorded.replayed && attempt.receipt_key !== recorded.receipt.request_key) throw Error('request_conflict')
      if (!recorded.replayed) attempt.state = advanceAttempt(attempt.state, {op: 'accept'})
      attempt.receipt_key = recorded.receipt.request_key
      state.ownership = recorded.state
      return {receipt: recorded.receipt, replayed: recorded.replayed}
    })
  }
  classifyReply(fence: Fence & {task_id: string}): Promise<{late: boolean}> {
    return this.change((_state, authority) => authority.classifyReply(fence))
  }
  async revokeForStop(taskId: string): Promise<void> {
    if (!taskId) throw Error('stale_fence')
    // If the disk is unavailable, retain the stop in memory and fail closed on the next call.
    this.unpersistedStops.add(taskId)
    await this.ledger.transaction(state => {
      if (!state.pending_stops.includes(taskId)) state.pending_stops.push(taskId)
    })
    await this.ledger.transaction(state => this.drainStops(state))
    this.unpersistedStops.delete(taskId)
  }
  bumpLifecycleGeneration(): Promise<number> {
    return this.change((_state, authority) => authority.bumpLifecycleGeneration())
  }
}
