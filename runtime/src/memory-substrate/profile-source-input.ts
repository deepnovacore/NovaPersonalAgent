import {createHash} from 'node:crypto'
import type {ProfileInput} from '../personal-agent/profile-warmup.js'
import type {EvidenceRecord} from './store.js'
/** A connector's recipient_id identifies the IM user; account_id may be a local account hash. */
export function profileSourceInput(record:Pick<EvidenceRecord,'id'|'hash'|'raw_text'|'observed_at'|'source_kind'|'source_metadata'|'source_id'>,maxChars=1500):ProfileInput{
 const metadata:Partial<NonNullable<EvidenceRecord['source_metadata']>>=record.source_metadata??{},self=record.source_kind==='im'?metadata.recipient_id:metadata.account_id
 const own=typeof self==='string'&&metadata.sender_id===self,direct=metadata.mention==='direct'
 const alias=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,12)
 return {id:record.id,version:record.hash,content:(record.raw_text??'').slice(0,maxChars),observed_at:record.observed_at,origin:'inferred',source:{kind:record.source_kind as 'im'|'mail',project:record.source_kind==='im'?'飞书':'邮件',document:own?'本人发出的内容':direct||record.source_kind==='mail'?'直接@本人的内容':'会话中他人的发言',relation:own?'self':direct||record.source_kind==='mail'?'addressed':'participant',sender_id:own?'self':alias(metadata.sender_id??'unknown'),...(metadata.sender_name?{sender_name:metadata.sender_name}:{}),thread_id:alias(metadata.thread_id??metadata.chat_id??record.source_id),...Object.fromEntries(['message_id','parent_id','root_id','upper_message_id'].flatMap(key=>{const value=metadata[key as keyof typeof metadata];return typeof value==='string'?[[key,alias(value)]]:[]})),recipient_ids:(metadata.recipient_ids??[]).map(id=>id===self?'self':alias(id)),mention_ids:(metadata.mention_ids??(metadata.mention==='direct'&&self?[self]:[])).map(id=>id===self?'self':alias(id))}}
}
