import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {advanceAttempt} from './attempt.js'

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1)
const phase = z.enum(['queued', 'running', 'verifying', 'waiting', 'completed', 'cancelled', 'failed'])
const bindings = z.object({
  task_id: text, owner: text, todo_version: integer, goal_revision: integer, control_revision: integer,
  lifecycle_generation: integer, capability_revision: integer, conversation_generation: integer,
  data_version: integer, observation_version: integer, permission_scope: z.array(text).min(1),
  effect_class: text, proposal_digest: text, executable_digest: text, expires_at: integer,
})
const version = z.object({version: integer, base_version: integer, content: text})
export const deviceStateSchema = z.object({
  authority: z.object({
    lifecycle_generation: integer,
    tasks: z.array(z.object({bindings, permissions: z.array(text), stopped: z.boolean()})),
    grants: z.array(z.object({
      grant_ref: text, status: z.enum(['pending', 'approved', 'consumed', 'expired', 'revoked']),
      bindings, consumed: z.boolean(),
    })),
    receipts: z.array(z.object({
      request: z.object({grant_ref: text, operation_id: text, kind: text, bindings}),
      intent: z.literal('prepared'),
    })),
  }),
  ownership: z.object({
    capacity: integer,
    receipts: z.array(z.object({id: text, request_key: text, payload_digest: text, status: text})),
  }),
  attempts: z.array(z.object({
    operation_id: text,
    state: z.object({
      task_phase: phase,
      attempt: z.object({
        id: text, status: z.enum(['none', 'prepared', 'dispatching', 'accepted', 'failed', 'unknown-effect']),
        dispatch_started: z.boolean(),
      }),
      effects: integer, evidence: z.array(text), action_grant_ref: text,
      consumed_verification_grants: z.array(text).optional(),
    }),
  })),
  todos: z.array(version.extend({
    id: text, conflicts: z.array(version),
    tombstones: z.array(z.object({entity_id: text, version: integer, permanent: z.literal(true)})),
    projection_visible: z.boolean(),
  })),
  pending_stops: z.array(text),
})
export type DeviceState = z.infer<typeof deviceStateSchema>
export function emptyDeviceState(): DeviceState {
  return {authority: {lifecycle_generation: 0, tasks: [], grants: [], receipts: []},
    ownership: {capacity: 10000, receipts: []}, attempts: [], todos: [], pending_stops: []}
}

/** One ledger per path; caller holds the host process lock, as with LifeService. */
export class DeviceLedger {
  private readonly store: BoundedJsonStore<DeviceState>
  private state: DeviceState | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly initial: DeviceState
  constructor(path: string, options: {initialState?: DeviceState; limit?: number} = {}) {
    this.store = new BoundedJsonStore(path, deviceStateSchema, options.limit)
    this.initial = deviceStateSchema.parse(options.initialState ?? emptyDeviceState())
  }
  private async load(): Promise<DeviceState> {
    if (this.state) return this.state
    const loaded = await this.store.read(this.initial)
    const recovered = structuredClone(loaded)
    for (const attempt of recovered.attempts) {
      attempt.state = advanceAttempt(attempt.state, {op: 'restart'})
    }
    if (JSON.stringify(recovered) !== JSON.stringify(loaded)) await this.store.write(recovered)
    this.state = recovered
    return recovered
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(action)
    this.tail = run.catch(() => { /* Keep subsequent operations available after a failed write. */ })
    return run
  }
  snapshot(): Promise<DeviceState> {
    return this.serialize(async () => structuredClone(await this.load()))
  }
  transaction<T>(change: (state: DeviceState) => T): Promise<T> {
    return this.serialize(async () => {
      const next = structuredClone(await this.load())
      const result = change(next)
      const validated = deviceStateSchema.parse(next)
      await this.store.write(validated)
      this.state = validated
      return structuredClone(result)
    })
  }
}
