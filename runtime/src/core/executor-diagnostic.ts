import {z} from 'zod'

/** Untrusted server evidence for local task details, never an execution instruction. */
export const executorDiagnosticSchema = z.object({
  method: z.string().min(1).max(128),
  server_code: z.number().int(),
  message: z.string().max(4000),
}).strict()
export type ExecutorDiagnostic = z.infer<typeof executorDiagnosticSchema>
