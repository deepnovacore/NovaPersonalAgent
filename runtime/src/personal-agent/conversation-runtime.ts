import {projectExecutorEvent,type ExecutorProgress,type ExecutorResult} from '../desktop-progress.js'
import {captureConversationFrame} from '../camera-session.js'
import {supportsVision} from '../vision-capability.js'
import {requireSelectedCascadedLlmConfig} from '../cascaded-realtime-config.js'
import {prerecallContext} from '../memory/prerecall.js'
import {ProjectConfirmationController} from '../project-confirmation.js'
import {buildConversationVoiceProvider} from '../conversation-voice-provider.js'
import {randomUUID} from 'node:crypto'
import {createHash} from 'node:crypto'
import {buildAssembly,type AssemblyOptions} from '../assembly.js'
import {buildRealtimeAssembly,defaultIntake,type RealtimeAssemblyOptions} from '../realtime-assembly.js'
import {buildCascadedTextProvider} from '../cascaded-text-provider.js'
import type {PersonalAgentHost} from './host.js'
import type {PersonalMemoryResource} from '../memory/personal-memory.js'
import type {ConversationRuntimeFactory} from './conversations.js'
import {scopeApprovalController} from './approval-scope.js'
import {deliveryToEvent,executorApprovalMessage,projectStateMessage} from '../desktop-wire.js'

/** Reuses deployment resources while allocating a separate causal runtime, provider and session. */
export function conversationRuntimeFactory(options:AssemblyOptions & Pick<RealtimeAssemblyOptions,'codexResource'|'onDiagnostic'|'onAudioFrame'|'onAudioClear'|'onAudioAlert'|'onAudioTerminal'|'nextPlaybackGeneration'|'onUsage'> & {
 onExecutorProgress?:(progress:ExecutorProgress,result?:ExecutorResult)=>void;
 createTextProvider?:typeof buildCascadedTextProvider;
 host:PersonalAgentHost; memory:()=>PersonalMemoryResource|undefined
}):ConversationRuntimeFactory {
 return async(conversation,emit,mode='text',lifetime=new AbortController().signal)=>{
  const history:{user:string;assistant:string}[]=[]
  let user:string|undefined
  for(const message of conversation.messages){if(message.role==='user')user=message.text;else {if(message.delivery!==undefined&&message.delivery!=='completed'){user=undefined;continue;}const paired=message.reply_to?conversation.messages.find(item=>item.id===message.reply_to&&item.role==='user')?.text:user;if(paired!==undefined)history.push({user:paired,assistant:message.text});user=undefined}}
  const recentHistory=history.filter(pair=>pair.user.length<=4000&&pair.assistant.length<=4000).slice(-32)
  if(mode==='voice'&&options.settings.pipeline_mode==='integrated'){while(recentHistory.length&&JSON.stringify(recentHistory).length>3000)recentHistory.shift()}
  const selectedLlm=requireSelectedCascadedLlmConfig(options.settings)
  const captureFrame=options.settings.conversation_vision_enabled&&options.frameSource&&supportsVision(selectedLlm.provider,selectedLlm.config.model)?(signal:AbortSignal)=>captureConversationFrame(options.frameSource!,signal,core.mediaStore):undefined
  const suffix=createHash('sha256').update(conversation.id+':'+conversation.generation).digest('hex').slice(0,24)
  const core=buildAssembly({...options,sharedResources:true,cameraModuleEnabled:false,conversationId:conversation.id+':'+conversation.generation,
   ...(options.blackboard?{blackboard:{...options.blackboard,path:options.blackboard.path+'.conversation-'+suffix}}:{}),
   ids:{next:namespace=>namespace+'-'+randomUUID()},
   ...(options.codexResource?{executors:[options.codexResource.adapter],agentDescriptors:options.codexResource.agentDescriptor?[options.codexResource.agentDescriptor]:[]}:{}),
  })
  const broker=options.codexResource?.approvalController
  const approval=broker?scopeApprovalController(broker,view=>!!view.work&&core.runtime.inFlightDelegate(view.work.work_id)!==undefined):undefined
  const unsubscribeApproval=approval?.observe(view=>{if(view.work)void options.host.rememberWorkOwner(view.work.work_id,conversation.id,view.pending_approval_id).catch(()=>{ /* durable projection retried on work event */ });const manifest=options.codexResource!.adapter.manifest;emit(JSON.parse(executorApprovalMessage(view,core.runtime.clock.now(),{executor:manifest.name,display_name:manifest.display_name})) as Record<string,unknown>)})
  const provider=(mode==='voice'?buildConversationVoiceProvider:(options.createTextProvider??buildCascadedTextProvider))({settings:options.settings,clock:core.runtime.clock,idFactory:()=>randomUUID(),history:recentHistory,...(captureFrame?{captureFrame}:{}),executorApproval:approval!==undefined,...(options.onUsage?{onUsage:options.onUsage}:{}),...(options.telemetry?{telemetry:options.telemetry}:{}),...(options.settings.memory_prerecall_enabled?{prerecall:async(query:string,signal:AbortSignal)=>{const result=await graph.retrieval.recall(query,{scope:'any',limit:3,signal});signal.throwIfAborted();return async(consumeSignal:AbortSignal)=>{const current=await graph.retrieval.revalidate(result,consumeSignal);consumeSignal.throwIfAborted();return prerecallContext(query,current)}}}:{})})
  let pending:{resolve:(result:{assistant:string;turn_id?:string})=>void;reject:(error:unknown)=>void}|undefined
  let voiceEnabled=mode==='voice'
  let assistant=''
  let assistantTurnId:string|undefined
  const captionIds=new Map<string,string>()
  const projectConfirmation=options.codexResource?.mode==='project'?new ProjectConfirmationController({clock:core.runtime.clock,idFactory:()=>randomUUID(),onChange:view=>emit(JSON.parse(projectStateMessage(view)) as Record<string,unknown>)}):undefined
  const graph=buildRealtimeAssembly({core,provider,
   ...(options.nextPlaybackGeneration?{nextPlaybackGeneration:options.nextPlaybackGeneration}:{}),
   ...(options.onAudioFrame?{onAudioFrame:frame=>{if(!lifetime.aborted&&voiceEnabled)options.onAudioFrame?.(frame)}}:{}),...(options.onAudioClear?{onAudioClear:options.onAudioClear}:{}),...(options.onAudioAlert?{onAudioAlert:options.onAudioAlert}:{}),...(options.onAudioTerminal?{onAudioTerminal:options.onAudioTerminal}:{}),sharedPersonal:{host:options.host,memory:options.memory()},
   ...(projectConfirmation?{projectConfirmation}:{}),
   ...(options.codexResource?{codexResource:options.codexResource,codingAgentControllerFactory:options.codexResource.agentControllerFactory}:{}),
   ...(approval?{executorApproval:approval}:{}),
   ...(defaultIntake(core,core.gateway,options.settings)?{intake:defaultIntake(core,core.gateway,options.settings)!}:{}),
   ...(options.onDiagnostic?{onDiagnostic:options.onDiagnostic}:{}),
   onDelivery:completion=>{const payload=deliveryToEvent(completion);if(payload)core.runtime.post({kind:'assistant_spoken',payload});if(completion.disposition!=='suppressed'&&completion.text)emit({type:'conversation.delivered',role:'assistant',text:completion.text,turn_id:captionIds.get(completion.response_id)??completion.utterance_id,delivery:completion.disposition==='spoken'?'completed':'interrupted',final:true})},
   onCaption:frame=>{if(frame.role==='assistant'){assistant=frame.text;assistantTurnId=frame.turn_id;if(frame.turn_id){const marker=frame.turn_id.indexOf(':assistant:');if(marker>=0)captionIds.set(frame.turn_id.slice(marker+11),frame.turn_id);if(captionIds.size>128)captionIds.delete(captionIds.keys().next().value!)}}emit({type:'caption',...frame})},
   onProviderEvent:event=>{if(event.kind==='response_started'){assistant='';assistantTurnId=undefined}if(event.kind==='response_terminal'&&event.status==='completed'&&assistant.trim()&&(mode==='voice'||!pending))emit({type:mode==='voice'?'conversation.generated':'conversation.completed',role:'assistant',text:assistant,turn_id:assistantTurnId??event.response_id,delivery:mode==='voice'?'generated':'completed',final:true});if(event.kind==='response_terminal'&&pending&&(event.status!=='completed'||assistant.trim()!=='')){const current=pending;pending=undefined;if(event.status==='completed')current.resolve({assistant,...(assistantTurnId?{turn_id:assistantTurnId}:{})});else current.reject(Error('response_'+event.status))}},
  })
  const unsubscribeProgress=core.runtime.observe((event,current)=>{if(current===false)return;const projected=projectExecutorEvent(event,core.runtime,channel=>graph.service.agentNameForChannel(channel));if(!projected)return;void options.host.rememberWorkOwner(projected.progress.delegate_id,conversation.id).catch(()=>{ /* host projection failure */ });options.onExecutorProgress?.(projected.progress,projected.result);if(mode==='voice'&&!voiceEnabled&&projected.result)emit({type:'conversation.completed',role:'assistant',text:projected.result.summary,turn_id:'task:'+projected.result.delegate_id,delivery:'completed',final:true})})
  try{await graph.start();if(conversation.prepared)await provider.injectHostItem({kind:'dialogue_context',host_item_id:randomUUID(),event_id:randomUUID(),call_id:null,content:JSON.stringify({trust:'untrusted_external',purpose:'read_only_topic_background',text:conversation.prepared.text.slice(0,2000),evidence_refs:conversation.prepared.evidence_refs.slice(0,2)})},{confirmationTimeout:null,asUserActivation:false,signal:AbortSignal.timeout(10000)})}catch(error){unsubscribeProgress();unsubscribeApproval?.();await graph.stop();await core.stop();throw error}
  return {
   parkVoice:async()=>{voiceEnabled=false;await graph.service.playbackDisconnected({resumeDelivery:false})},
   canSwitch:()=>!pending&&!approval?.pending&&!projectConfirmation?.pending&&core.runtime.core.activeDelegates().length===0&&(voiceEnabled?graph.service.pendingHostItemCount===0:true)&&graph.playback.current===null,
   deliverSuggestion:(suggestion,reason)=>graph.service.onSuggestionSelected(suggestion,reason),
   ownsWork:id=>core.runtime.inFlightDelegate(id)!==undefined,bridgeService:graph.service,sendAudio:(pcm)=>graph.service.sendAudio(pcm),
   runTurn:async(text,callerSignal)=>{const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(120000)]);signal.throwIfAborted();assistant='';assistantTurnId=undefined;const done=new Promise<{assistant:string;turn_id?:string}>((resolve,reject)=>{pending={resolve,reject}});const abort=()=>{pending?.reject(Error('conversation_cleared'));pending=undefined;void graph.service.clearConversation()};signal.addEventListener('abort',abort,{once:true});try{await graph.service.submitText(text);return await done}finally{signal.removeEventListener('abort',abort)}},
   close:async()=>{approval?.invalidate('conversation_closed');unsubscribeProgress();unsubscribeApproval?.();pending?.reject(Error('conversation_closed'));pending=undefined;await graph.stop();await core.stop()},
   approvalDecision:(id,approved)=>approval?.acceptDecision({approvalId:id,decision:approved?'accept':'decline'})?Promise.resolve():Promise.reject(Error('approval_not_owned')),
  }
 }
}
