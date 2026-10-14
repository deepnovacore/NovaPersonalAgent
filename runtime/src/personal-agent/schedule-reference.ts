import {z} from 'zod'
export const scheduleReferenceSchema=z.object({schedule_id:z.string().min(1).max(512),revision:z.number().int().positive(),run_id:z.string().min(1).max(512).optional(),task_id:z.string().min(1).max(512).optional()}).strict()
export type ScheduleReference=z.infer<typeof scheduleReferenceSchema>
