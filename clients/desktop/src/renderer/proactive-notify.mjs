import {homeTranscript} from './chat-transcript.mjs'
/**
 * Spots proactive messages that newly land in the main conversation, for the OS notification.
 *
 * A snapshot carries only part of the history (the home transcript is byte-limited, and which conversation is
 * selected decides what sits in `messages`), so "not seen before" cannot tell an arrival from history that was
 * merely left out of the first snapshot. The moment a connection is seeded is the line instead: only a message
 * created at or after it can be an arrival, so opening, reconnecting or switching to the main conversation never
 * replays what was already waiting.
 */
export function createProactiveNotifyDetector({now=Date.now}={}){
 let seededAt=null;const seen=new Set()
 const reset=()=>{seededAt=null;seen.clear()}
 function observe(snapshot,{connected}){
  if(!connected||!snapshot){reset();return null}
  const unread=homeTranscript(snapshot.conversations).filter(message=>message.role==='assistant'&&message.origin==='proactive'&&message.read!==true)
  const fresh=unread.filter(message=>!seen.has(message.id))
  for(const message of fresh)seen.add(message.id)
  if(seededAt===null){seededAt=now();return null}
  const arrivals=fresh.filter(message=>Date.parse(message.created_at)>=seededAt)
  if(!arrivals.length)return null
  return {items:arrivals.map(message=>{
   const [title='',...rest]=String(message.text??'').split('\n')
   return {id:message.id,title:title.trim()||'Nova',body:rest.join(' ').trim()}
  })}
 }
 return {observe,reset}
}
