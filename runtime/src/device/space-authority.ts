import {z} from 'zod'

export const spaceId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/)
export const deviceKind = z.enum(['unknown','mobile','desktop','worker'])
export type DeviceKind = z.infer<typeof deviceKind>
export const authorityRecordSchema = z.object({
 protocol_version:z.literal(1), space_id:spaceId, authority_epoch:z.number().int().positive(),
 membership_revision:z.number().int().positive(), primary_device_id:spaceId,
 mode:z.enum(['mobile_primary','pc_primary']),
 pending:z.object({transition_id:spaceId,from_device_id:spaceId,target_device_id:spaceId,
  expected_epoch:z.number().int().positive(),acknowledged:z.array(spaceId)}).strict().nullable(),
}).strict()
export type AuthorityRecord = z.infer<typeof authorityRecordSchema>
export const transitionSchema=z.object({transition_id:spaceId,target_device_id:spaceId,expected_epoch:z.number().int().positive()}).strict()

/** Publication authority is unrelated to presence and native action permissions. */
export function validatePublication(record:AuthorityRecord,deviceId:string,epoch:number):void {
 if(record.authority_epoch!==epoch)throw Error('stale_authority')
 if(record.pending)throw Error('authority_transition')
 if(record.primary_device_id!==deviceId)throw Error('publisher_required')
}
