// Rejections throw AuthorityError with contract codes. The trusted host owns state,
// serializes calls and durably saves mutations before ACK or any external effect.
export interface Clock { now(): number }
export interface Fence {
  todo_version: number
  goal_revision: number
  control_revision: number
  lifecycle_generation: number
  capability_revision: number
}
export interface Bindings extends Fence {
  task_id: string
  owner: string
  conversation_generation: number
  data_version: number
  observation_version: number
  permission_scope: string[]
  effect_class: string
  proposal_digest: string
  executable_digest: string
  expires_at: number
}
export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'expired' | 'revoked'
export interface Grant {
  grant_ref: string
  status: ApprovalStatus
  bindings: Bindings
  consumed: boolean
}
export interface DispatchRequest {
  grant_ref: string
  operation_id: string
  kind: string
  bindings: Bindings
}
export interface AuthorityState {
  lifecycle_generation: number
  tasks: {bindings: Bindings; permissions: string[]; stopped: boolean}[]
  grants: Grant[]
  receipts: {request: DispatchRequest; intent: 'prepared'}[]
}
type Code = 'approval_required' | 'approval_consumed' | 'approval_revoked' |
  'approval_expired' | 'permission_denied' | 'stale_fence' | 'request_conflict'
export class AuthorityError extends Error {
  constructor(readonly code: Code) { super(code) }
}
function fail(code: Code): never {throw new AuthorityError(code)}
const integer = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) fail('stale_fence')
}
const nonempty = (s: string) => {
  if (typeof s !== 'string' || s.length === 0) fail('stale_fence')
}
const numbers = ['todo_version', 'goal_revision', 'control_revision', 'lifecycle_generation',
  'capability_revision', 'conversation_generation', 'data_version', 'observation_version', 'expires_at'] as const
const strings = ['task_id', 'owner', 'effect_class', 'proposal_digest', 'executable_digest'] as const
const fenceKeys = ['todo_version', 'goal_revision', 'control_revision', 'lifecycle_generation', 'capability_revision'] as const
function validate(b: Bindings) {
  for (const key of numbers) integer(b[key])
  for (const key of strings) nonempty(b[key])
  if (!Array.isArray(b.permission_scope) || b.permission_scope.length === 0) fail('permission_denied')
  for (const scope of b.permission_scope) nonempty(scope)
}
function same(a: Bindings, b: Bindings) {
  return numbers.every(k => a[k] === b[k]) && strings.every(k => a[k] === b[k])
    && a.permission_scope.length === b.permission_scope.length
    && a.permission_scope.every((scope, i) => scope === b.permission_scope[i])
}
function copy(b: Bindings): Bindings { return {...b, permission_scope: [...b.permission_scope]} }

export class Authority {
  constructor(private readonly state: AuthorityState, private readonly clock: Clock) {}

  createGrant(grantRef: string, bindings: Bindings): void {
    nonempty(grantRef)
    validate(bindings)
    if (this.state.grants.some(g => g.grant_ref === grantRef)) fail('request_conflict')
    const task = this.state.tasks.find(t => t.bindings.task_id === bindings.task_id)
    if (!task || !same(task.bindings, bindings)
      || bindings.lifecycle_generation !== this.state.lifecycle_generation) fail('stale_fence')
    if (task.stopped) fail('approval_revoked')
    this.state.grants.push({grant_ref: grantRef, status: 'pending', bindings: copy(bindings), consumed: false})
  }

  private grant(ref: string): Grant {
    return this.state.grants.find(g => g.grant_ref === ref) ?? fail('approval_required')
  }

  private recheck(grant: Grant): void {
    const task = this.state.tasks.find(t => t.bindings.task_id === grant.bindings.task_id)
    if (!task) {
      grant.status = 'expired'
      fail('stale_fence')
    }
    if (task.stopped) {
      grant.status = 'revoked'
      fail('approval_revoked')
    }
    if (!grant.bindings.permission_scope.every(scope => task.permissions.includes(scope))) {
      grant.status = 'revoked'
      fail('permission_denied')
    }
    validate(task.bindings)
    integer(this.state.lifecycle_generation)
    const now = this.clock.now()
    integer(now)
    if (grant.status !== 'revoked' && (now >= grant.bindings.expires_at
      || !same(grant.bindings, task.bindings)
      || grant.bindings.lifecycle_generation !== this.state.lifecycle_generation)) {
      grant.status = 'expired'
      fail(now >= grant.bindings.expires_at ? 'approval_expired' : 'stale_fence')
    }
    if (grant.status === 'revoked') fail('approval_revoked')
    if (grant.status === 'expired') fail('approval_expired')
  }

  approveGrant(grantRef: string): void {
    const grant = this.grant(grantRef)
    this.recheck(grant)
    if (grant.consumed || grant.status === 'consumed') fail('approval_consumed')
    if (grant.status !== 'pending') fail('approval_required')
    grant.status = 'approved'
  }

  authorizeDispatch(request: DispatchRequest): {intent: 'prepared'; replayed: boolean} {
    nonempty(request.operation_id)
    nonempty(request.grant_ref)
    nonempty(request.kind)
    validate(request.bindings)
    const previous = this.state.receipts.find(r => r.request.operation_id === request.operation_id)
    if (previous) {
      if (previous.request.grant_ref !== request.grant_ref || previous.request.kind !== request.kind
        || !same(previous.request.bindings, request.bindings)) fail('request_conflict')
      // Replay is evidence only, never permission to call the external service again.
      return {intent: previous.intent, replayed: true}
    }
    const grant = this.grant(request.grant_ref)
    this.recheck(grant)
    if (!same(grant.bindings, request.bindings)) fail('stale_fence')
    if (!grant.bindings.permission_scope.includes(request.kind)) fail('permission_denied')
    if (grant.consumed || grant.status === 'consumed') fail('approval_consumed')
    if (grant.status !== 'approved') fail('approval_required')
    const receipt = {request: {...request, bindings: copy(request.bindings)}, intent: 'prepared' as const}
    this.state.receipts.push(receipt)
    grant.consumed = true
    grant.status = 'consumed'
    return {intent: receipt.intent, replayed: false}
  }

  revokeForStop(taskId: string): void {
    const task = this.state.tasks.find(t => t.bindings.task_id === taskId)
    if (!task) fail('stale_fence')
    if (!task.stopped) {
      integer(task.bindings.control_revision + 1)
      task.bindings.control_revision++
      task.stopped = true
    }
    for (const grant of this.state.grants) {
      if (grant.bindings.task_id === taskId) grant.status = 'revoked'
    }
  }

  bumpLifecycleGeneration(): number {
    integer(this.state.lifecycle_generation + 1)
    this.state.lifecycle_generation++
    for (const task of this.state.tasks) task.bindings.lifecycle_generation = this.state.lifecycle_generation
    for (const grant of this.state.grants) {
      if (grant.status !== 'revoked') grant.status = 'expired'
    }
    return this.state.lifecycle_generation
  }

  classifyReply(fence: Fence & {task_id: string}): {late: boolean} {
    const task = this.state.tasks.find(t => t.bindings.task_id === fence.task_id)
    const late = !task || task.stopped || fence.lifecycle_generation !== this.state.lifecycle_generation
      || fenceKeys.some(k => !Number.isSafeInteger(fence[k]) || fence[k] < 0 || fence[k] !== task.bindings[k])
    return {late}
  }
}
