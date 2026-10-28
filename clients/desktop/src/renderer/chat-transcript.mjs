import {normalizeToolTrace,TOOL_TRACE_LIMIT} from './chat-tool-trace.mjs'

export function homeTranscript(conversations){
 const rows=[...(conversations?.messages??[]).filter(message=>message.conversation_id==='chat:main'),...(conversations?.home_messages??[])];
 return [...new Map(rows.map(message=>[message.id,message])).values()].sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??''))
}
/**
 * Live captions are not persisted, so they carry the local time they were first seen. They belong right after the
 * last persisted message that existed then; appending them last would pin a stale caption below newer messages.
 * Identity, not text, decides whether a caption is already in the transcript: the runtime may rewrite or merge the
 * persisted text, and comparing strings would either duplicate the reply or swallow the newer caption.
 */
export function orderTranscript(persisted,live){
 const placed=new Map(),tail=[]
 for(const frame of live){
  if(typeof frame.seen_at!=='number'){tail.push(frame);continue}
  if(persistedCoversCaption(persisted,frame))continue
  const index=persisted.findLastIndex(message=>Date.parse(message.created_at)<=frame.seen_at)
  placed.set(index,[...(placed.get(index)??[]),frame])
 }
 return [...(placed.get(-1)??[]),...persisted.flatMap((message,index)=>[message,...(placed.get(index)??[])]),...tail]
}
/** A persisted assistant reply owns the caption of its turn once it carries at least as much text. */
function persistedCoversCaption(persisted,frame){
 if(typeof frame.turn_id!=='string'||typeof frame.text!=='string')return false
 return persisted.some(message=>message.role==='assistant'&&message.turn_id===frame.turn_id
  && typeof message.text==='string'&&message.text.length>=frame.text.length)
}
/**
 * The persisted reply is the durable copy of its turn, but a snapshot can lag the streamed caption, and a merged
 * turn can be persisted shorter than what the preview already showed. The longer text wins for display so the
 * first paragraph a caption already rendered is never swallowed when the message row arrives.
 */
export function mergeLiveCaptionText(persisted,captions){
 const longest=new Map()
 for(const caption of captions)if(typeof caption.turn_id==='string'){
  const current=longest.get(caption.turn_id)
  if(!current||(caption.text??'').length>(current.text??'').length)longest.set(caption.turn_id,caption)
 }
 const owned=new Set()
 const messages=persisted.map(message=>{
  if(message.role!=='assistant'||typeof message.turn_id!=='string')return message
  const caption=longest.get(message.turn_id)
  if(!caption)return message
  owned.add(message.turn_id)
  return (caption.text??'').length>(message.text??'').length?{...message,text:caption.text}:message
 })
 return {messages,live:captions.filter(caption=>typeof caption.turn_id!=='string'||!owned.has(caption.turn_id))}
}

export function createChatStream(){
 const liveCaptions=new Map()
 const liveTools=new Map(),LIVE_TOOL_TURNS=64
 const liveToolKey=(conversationId,turnId)=>`${conversationId}:${turnId}`
 /**
  * The runtime can report a tool before the turn has streamed its first caption, so the frame may not
  * carry a turn id yet. Such rows stay in one per-conversation bucket until a caption or the durable
  * assistant message names the turn, then move onto it so a running row is never shown twice.
  */
 function liveToolEntry(conversationId,turnId,name){
  const direct=liveTools.get(liveToolKey(conversationId,turnId))
  if(direct)return direct
  if(turnId)return null
  let sameName=null
  for(const entry of liveTools.values()){
   const last=entry.items.at(-1)
   if(entry.conversation_id!==conversationId||!entry.turn_id||last?.name!==name)continue
   if(last.state==='running')return entry
   sameName=entry
  }
  return sameName
 }
 function adoptAnonymousToolTrace(conversationId,turnId){
  const anonymous=liveTools.get(liveToolKey(conversationId,''))
  if(!anonymous)return
  liveTools.delete(liveToolKey(conversationId,''))
  const key=liveToolKey(conversationId,turnId),existing=liveTools.get(key),items=existing?[...existing.items]:[]
  for(const item of anonymous.items){
   const last=items.at(-1)
   if(last&&last.name===item.name)items[items.length-1]=item
   else items.push(item)
  }
  while(items.length>TOOL_TRACE_LIMIT)items.shift()
  liveTools.set(key,{conversation_id:conversationId,turn_id:turnId,seen_at:existing?.seen_at??anonymous.seen_at,items})
 }
 /** Repeats of one tool name update its last row; a new call after a finished one appends. */
 function applyToolFrame(frame){
  if(typeof frame.conversation_id!=='string'||!frame.conversation_id)return
  const turnId=typeof frame.turn_id==='string'?frame.turn_id:''
  const item=normalizeToolTrace([frame])[0]
  if(!item)return
  const entry=liveToolEntry(frame.conversation_id,turnId,item.name)
  const conversationId=frame.conversation_id,turn=entry?.turn_id??turnId,key=liveToolKey(conversationId,turn),items=entry?[...entry.items]:[]
  const last=items.at(-1)
  if(last&&last.name===item.name)items[items.length-1]=item
  else if(items.length<TOOL_TRACE_LIMIT)items.push(item)
  else return
  // Reinsert so the least recently updated turn is the one evicted at the bound.
  liveTools.delete(key);liveTools.set(key,{conversation_id:conversationId,turn_id:turn,seen_at:entry?.seen_at??Date.now(),items})
  while(liveTools.size>LIVE_TOOL_TURNS)liveTools.delete(liveTools.keys().next().value)
 }
 function liveToolTrace(message){
  if(message?.live_tool_items?.length)return{items:message.live_tool_items,live:true}
  if(typeof message?.turn_id!=='string'||typeof message?.conversation_id!=='string')return null
  const entry=liveTools.get(liveToolKey(message.conversation_id,message.turn_id))
  return entry?.items.length?{items:entry.items,live:true}:null
 }
 /** The persisted copy is authoritative; the live rows only stand in until it arrives. */
 function traceForMessage(message){
  const persisted=normalizeToolTrace(message.tool_trace)
  if(persisted.length)return{items:persisted,live:false}
  return liveToolTrace(message)
 }

 function receive(frame,voiceId){
  if(frame.type==='conversation.tool')applyToolFrame(frame)
  // A failed turn leaves nothing durable behind; its anonymous tool bucket must not claim to run forever.
  if(['conversation.error','conversation.notice'].includes(frame.type)&&typeof frame.conversation_id==='string')for(const [key,entry] of liveTools)if(entry.conversation_id===frame.conversation_id&&!entry.turn_id)liveTools.delete(key)
  if(frame.type==='caption'&&(typeof frame.text==='string'||typeof frame.full_text==='string')&&frame.conversation_id&&frame.turn_id&&(frame.role!=='user'||frame.conversation_id===voiceId)){
   if(frame.role==='assistant')adoptAnonymousToolTrace(frame.conversation_id,frame.turn_id)
   const key=`${frame.conversation_id}:${frame.turn_id}`
   const existing=liveCaptions.get(key)
   const sequence=Number.isFinite(frame.sequence)?frame.sequence:null
   // Captions are cumulative and carry a monotonic sequence: a late frame must never regress the visible text.
   if(!(existing&&sequence!==null&&existing.sequence!==null&&sequence<existing.sequence)){
    const text=typeof frame.full_text==='string'&&frame.full_text.trim()?frame.full_text:frame.text
    if(typeof text==='string'&&text){
     liveCaptions.set(key,{...frame,text,sequence:sequence??existing?.sequence??null,seen_at:existing?.seen_at??Date.now()})
    }
    // An empty final retracts exactly the segment it ends; a newer segment's text outranks an older retraction.
    else if(frame.final===true&&(sequence===null||existing?.sequence===null||existing===undefined||sequence>=existing.sequence))liveCaptions.delete(key)
   }
   while(liveCaptions.size>128)liveCaptions.delete(liveCaptions.keys().next().value)
  }
  if(frame.type==='personal.state'){
   // The durable assistant message of a turn retires that turn's live rows, including home history.
   for(const message of [...frame.conversations?.messages??[],...frame.conversations?.home_messages??[]]){
    if(message.role!=='assistant')continue
    if(!message.turn_id)continue
    adoptAnonymousToolTrace(message.conversation_id,message.turn_id)
    const key=`${message.conversation_id}:${message.turn_id}`,live=liveCaptions.get(key)
    // A lagging or shortened persisted reply must not delete a longer caption still on screen.
    if(live&&(message.text??'').length>=(live.text??'').length)liveCaptions.delete(key)
    liveTools.delete(key)
   }
   const idleBuilds=new Set((frame.conversations?.items??[]).filter(item=>item.kind==='build'&&!['running','awaiting_approval'].includes(item.build?.status)).map(item=>item.id))
   for(const [key,value] of liveCaptions)if(idleBuilds.has(value.conversation_id))liveCaptions.delete(key)
   for(const [key,value] of liveTools)if(idleBuilds.has(value.conversation_id))liveTools.delete(key)
  }
 }
 return {captions:liveCaptions,tools:liveTools,traceForMessage,liveToolTrace,receive}
}
