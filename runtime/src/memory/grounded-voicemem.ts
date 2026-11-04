import type * as VoiceMemSdk from 'voicemem'

/** Changes extraction semantics and therefore retires/backfills prior engine stores. */
export const VOICEMEM_SEMANTIC_PROTOCOL = 'voicemem-0.0.1/grounded-reply-preferences-v1'

/** The build stages an integrity-checked, private SDK copy. Never fall back to unpatched extraction. */
export async function loadGroundedVoiceMem():Promise<typeof VoiceMemSdk> {
  const sdk = await import(new URL('./voicemem-sdk/index.js', import.meta.url).href) as typeof VoiceMemSdk & {REPLY_PREFERENCE_PROTOCOL?:unknown}
  if(sdk.REPLY_PREFERENCE_PROTOCOL !== VOICEMEM_SEMANTIC_PROTOCOL)throw Error('memory_engine_sdk_protocol_mismatch')
  return sdk
}
