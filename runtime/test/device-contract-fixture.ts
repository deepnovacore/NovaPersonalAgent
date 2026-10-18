import {readFileSync} from 'node:fs'
import {z} from 'zod'
import {taskInputSchema} from '../src/personal-agent/tasks.js'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const id = z.string().min(1)
const phase = z.enum(['queued', 'running', 'verifying', 'waiting', 'completed', 'cancelled', 'failed'])
const approval = z.enum(['pending', 'approved', 'consumed', 'expired', 'revoked'])
const attempt = z.enum(['none', 'prepared', 'dispatching', 'accepted', 'failed', 'unknown-effect'])
const fence = z.object({todo_version: integer, goal_revision: integer, control_revision: integer,
  lifecycle_generation: integer, capability_revision: integer}).strict()
const identity = z.object({principal: id, device_id: id, request_id: id}).strict()
export const fixture = z.object({
  contract_version: z.literal(1),
  operations: z.record(id, z.array(id)),
  cases: z.array(z.object({
    id, semantics: z.array(z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])).min(1),
    given: z.object({
      identity, request_key: id, input: taskInputSchema,
      todo: z.object({id, version: integer, content: id, conflicts: z.array(z.unknown())}).strict(),
      goal: z.object({id, revision: integer}).strict(),
      task: z.object({id, phase, owner: id}).strict(),
      session: z.object({id, owner: id, generation: integer, context_version: integer}).strict(),
      fence,
      approval: z.object({grant_ref: id, status: approval, bindings: fence.extend({
        task_id: id, owner: id, conversation_generation: integer, data_version: integer,
        observation_version: integer, permission_scope: z.array(id), effect_class: id,
        proposal_digest: id, executable_digest: id, expires_at: integer,
      }).strict()}).strict(),
      attempt: z.object({id, status: attempt, dispatch_started: z.boolean()}).strict(),
      tombstones: z.array(z.object({entity_id: id, version: integer, permanent: z.literal(true)}).strict()),
      permissions: z.array(id), dedup: z.object({capacity: integer, receipts: z.array(z.object({
        id, request_key: id, payload_digest: id, status: id,
      }).strict())}).strict(), effects: integer,
    }).strict(),
    when: z.array(z.object({op: id, params: z.record(id, z.unknown())}).strict()).min(1),
    then: z.object({task_phase: phase, attempt_status: attempt, approval_status: approval,
      effects: integer}).catchall(z.unknown()),
    coverage: z.object({adapter: z.enum(['local', 'pending']), scope: id, reason: id.optional()}).strict(),
  }).strict()).min(1),
}).strict().parse(JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/device-contract/v1/cases.json', import.meta.url), 'utf8',
)))

export type ContractCase = (typeof fixture)['cases'][number]
export type ContractAdapter = (c: ContractCase) => Promise<void>
