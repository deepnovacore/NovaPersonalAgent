import {z} from 'zod'
const expectation = z.object({
  calls:z.array(z.object({name:z.string().min(1), args:z.record(z.string(),z.json()).optional(),
    contains:z.record(z.string(),z.array(z.string()).min(1)).optional(),
    containsAny:z.record(z.string(),z.array(z.array(z.string()).min(1)).min(1)).optional(),
    notMatch:z.record(z.string(),z.string().min(1)).optional()}).strict()).max(1),
  textAll:z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
  text:z.enum(['required','forbidden']), textAny:z.array(z.string()).min(1).optional(), textNot:z.array(z.string()).optional(),
}).strict()
const fixtureSchema = z.object({version:z.literal(1), cases:z.array(z.object({
  id:z.string().regex(/^[a-z0-9-]+$/u), text:z.string().min(1), context:z.string().min(1),
  disabled:z.array(z.enum(['search','camera','coding','knowledge'])).optional(),
  steps:z.array(z.object({expect:expectation, otherwise:expectation.optional(), result:z.json().optional()}).strict()).min(1).max(3),
}).strict()).min(1)}).strict()
export function validateFixtures(value) {
  const parsed = fixtureSchema.parse(value)
  if (new Set(parsed.cases.map(entry => entry.id)).size !== parsed.cases.length) throw new Error('duplicate case id')
  for (const entry of parsed.cases) for (const [index, step] of entry.steps.entries()) {
    for (const call of step.expect.calls) for (const pattern of Object.values(call.notMatch ?? {})) new RegExp(pattern, 'u')
    if ((index < entry.steps.length - 1) !== (step.result !== undefined)) throw new Error('continuation result/step mismatch')
    if (step.otherwise && (step.result === undefined || step.otherwise.calls.length !== 0)) throw new Error('otherwise requires a continuation and no calls')
    if (step.result !== undefined && step.expect.calls.length !== 1) throw new Error('continuation requires one expected call')
  }
  return parsed
}
export function summary(results) {
  const counts = {passed:0, failed:0, error:0, blocked:0}
  for (const result of results) {
    if (!(result.status in counts)) throw new Error('unknown result status')
    counts[result.status]++
  }
  return {...counts, total:results.length, accepted:results.length > 0 && counts.passed === results.length}
}
