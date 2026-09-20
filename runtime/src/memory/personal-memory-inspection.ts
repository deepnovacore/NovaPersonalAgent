import {z} from 'zod'

export const memoryInspectionQuerySchema = z.object({
  query: z.string().max(200).default(''),
  before: z.number().int().positive().optional(),
}).strict()
export const memoryInspectionSchema = z.object({
  engine: z.literal('mem0'),
  entries: z.array(z.object({
    sourceId: z.string().max(256),
    state: z.enum(['pending', 'learned']),
    recordedAt: z.string().max(64),
    original: z.string().max(1500),
    memories: z.array(z.string().max(500)).max(4),
    truncated: z.boolean(),
  }).strict()).max(10),
  next: z.number().int().positive().nullable(),
}).strict()
export type MemoryInspectionQuery = z.input<typeof memoryInspectionQuerySchema>
export type MemoryInspection = z.infer<typeof memoryInspectionSchema>
