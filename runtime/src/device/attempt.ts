// Rejections throw AttemptError with glossary codes. The host persists returned data before external calls.
export class AttemptError extends Error {
  constructor(readonly code: 'stale_fence' | 'unknown_effect' | 'approval_required') { super(code) }
}
export type TaskPhase = 'queued' | 'running' | 'verifying' | 'waiting' | 'completed' | 'cancelled' | 'failed'
export type AttemptStatus = 'none' | 'prepared' | 'dispatching' | 'accepted' | 'failed' | 'unknown-effect'
export interface AttemptState {
  task_phase: TaskPhase
  attempt: {id: string; status: AttemptStatus; dispatch_started: boolean}
  effects: number
  evidence: string[]
  action_grant_ref: string
  consumed_verification_grants?: string[]
}
export interface VerificationGrant {
  grant_ref: string
  status: 'pending' | 'approved' | 'consumed' | 'expired' | 'revoked'
  scope: string
  attempt_id: string
}
export type AttemptEvent =
  | {op: 'persist_intent' | 'mark_dispatch_started' | 'restart' | 'retry_dispatch' | 'accept'}
  | {op: 'prove_not_dispatched'; evidence_ref: string}
  | {op: 'verify_outcome'; outcome: 'completed' | 'failed'; evidence_ref: string; grant?: VerificationGrant}

export function advanceAttempt(state: AttemptState, event: AttemptEvent): AttemptState {
  const {attempt} = state
  const terminal = ['completed', 'cancelled', 'failed'].includes(state.task_phase)
  const evidence = (ref: string) => {
    if (typeof ref !== 'string' || ref.length === 0) throw new AttemptError('stale_fence')
    return [...state.evidence, ref]
  }
  if (!Number.isSafeInteger(state.effects) || state.effects < 0 || !attempt.id)
    throw new AttemptError('stale_fence')
  switch (event.op) {
    case 'persist_intent':
      if (attempt.status === 'unknown-effect') throw new AttemptError('unknown_effect')
      if (terminal || attempt.status !== 'none' || attempt.dispatch_started) throw new AttemptError('stale_fence')
      return {...state, attempt: {...attempt, status: 'prepared'}}
    case 'retry_dispatch':
    case 'mark_dispatch_started':
      if (attempt.status === 'unknown-effect' || attempt.dispatch_started) throw new AttemptError('unknown_effect')
      if (terminal || attempt.status !== 'prepared') throw new AttemptError('stale_fence')
      return {...state, task_phase: 'running', attempt: {...attempt, status: 'dispatching', dispatch_started: true}}
    case 'restart':
      if (attempt.status !== 'dispatching' && attempt.status !== 'unknown-effect') return state
      return {...state, task_phase: terminal ? state.task_phase : 'waiting', attempt: {...attempt, status: 'unknown-effect'}}
    case 'accept':
      if (terminal || attempt.status !== 'dispatching') throw new AttemptError('stale_fence')
      return {...state, task_phase: 'verifying', attempt: {...attempt, status: 'accepted'}}
    case 'prove_not_dispatched':
      if (attempt.dispatch_started) throw new AttemptError('unknown_effect')
      if (terminal || attempt.status !== 'prepared') throw new AttemptError('stale_fence')
      return {...state, task_phase: 'failed', attempt: {...attempt, status: 'failed'}, evidence: evidence(event.evidence_ref)}
    case 'verify_outcome': {
      if (attempt.status !== 'unknown-effect' || (terminal && state.task_phase !== 'cancelled'))
        throw new AttemptError('stale_fence')
      const grant = event.grant
      if (!grant || grant.status !== 'approved' || !grant.grant_ref || grant.grant_ref === state.action_grant_ref
        || grant.scope !== 'sandbox.fs.read' || grant.attempt_id !== attempt.id
        || state.consumed_verification_grants?.includes(grant.grant_ref)) throw new AttemptError('approval_required')
      if (event.outcome !== 'completed' && event.outcome !== 'failed') throw new AttemptError('stale_fence')
      return {...state, task_phase: state.task_phase === 'cancelled' ? 'cancelled' : event.outcome,
        attempt: {...attempt, status: event.outcome === 'completed' ? 'accepted' : 'failed'},
        evidence: evidence(event.evidence_ref),
        consumed_verification_grants: [...state.consumed_verification_grants ?? [], grant.grant_ref]}
    }
  }
}
