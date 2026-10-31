import {homeTranscript} from './chat-transcript.mjs'
/**
 * Spots proactive messages that newly land in the main conversation, for the OS notification. The first snapshot of a
 * connection only seeds what is already there, so opening or reconnecting never replays history.
 */
export function createProactiveNotifyDetector(){
 let seeded=false;const seen=new Set()
 const reset=()=>{seeded=false;seen.clear()}
 function observe(snapshot,{connected}){
  if(!connected||!snapshot){reset();return null}
  const unread=homeTranscript(snapshot.conversations).filter(message=>message.role==='assistant'&&message.origin==='proactive'&&message.read!==true)
  const fresh=unread.filter(message=>!seen.has(message.id))
  for(const message of fresh)seen.add(message.id)
  if(!seeded){seeded=true;return null}
  if(!fresh.length)return null
  return {items:fresh.map(message=>{
   const [title='',...rest]=String(message.text??'').split('\n')
   return {id:message.id,title:title.trim()||'Nova',body:rest.join(' ').trim()}
  })}
 }
 return {observe,reset}
}
