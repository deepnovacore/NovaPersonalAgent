import {emptyContextDependencies,mergeContextDependencies,type ContextDependencies} from './context-dependencies.js'
import {memoryHostToolNames} from './conversation-tool-bridge.js'
import {abortable} from '../core/camera-session.js'
import type {RealtimeTelemetry} from '../realtime/telemetry.js'
import {computerApplicationSchema} from './computer-use/contract.js'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {Conversation,ConversationRuntime,ConversationTurnContext} from './conversations.js'
import type {PersonalAgentHost} from './host.js'
import {mergeTurnText,type CascadedLlmFactory,type CascadedLlmSession,type CascadedLlmTool,type CascadedLlmInput} from '../realtime/cascaded/llm.js'
import {LOCAL_TOOLS,executeLocalTool,isLocalTool,localPathEscapesProject,localToolArguments,projectResourceKey} from './local-tools.js'
import {acquireTaskResources,taskResourcesBusy,taskResourcesUncertain,quarantineTaskResources,releaseQuarantinedTaskResources} from '../executors/task-resources.js'
import {localShellTreeState,type LocalShellOptions} from './local-shell.js'
import {approvalClasses,classDenied,commandLine,stepPhrase,workbenchCopy,DENIED_MESSAGE,DENIED_BEFORE_MESSAGE,SKIPPED_MESSAGE,DENIED_RESUME_INSTRUCTION} from './workbench-copy.js'
import type {JsonValue} from '../core/events.js'
import type {WorkbenchCall} from './workbench-store.js'
import {MAX_WORKBENCH_THOUGHTS,MAX_WORKBENCH_THOUGHT_CODEPOINTS} from './workbench-store.js'
import type {ComputerSession,ComputerSessionOptions} from './computer-use/session.js'
import {computerTools} from './computer-use/tools.js'
import {computerUseSkill} from './computer-use/skill.js'
import {isComputerTool,computerToolArguments,COMPUTER_VISION_REQUIRED_MESSAGE,COMPUTER_WRITE_TOOLS,type ToolImage} from './computer-use/contract.js'

const publishArguments=z.object({title:z.string().min(1).max(120),content:z.string().min(1).max(131072)}).strict()
const publishTool:CascadedLlmTool={name:'publish_plan',description:'Publish the complete detailed plan for the user to review and choose local Build or executor Build. This does not authorize or start execution. Call again to publish an amended version.',parameters:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:120},content:{type:'string',minLength:1,maxLength:131072}},required:['title','content'],additionalProperties:false}}
const finishArguments=z.object({summary:z.string().min(1).max(12000)}).strict()
const finishTool:CascadedLlmTool={name:'finish_build',description:'End this Build conversation after the confirmed work and verification are complete. Provide the final user-facing summary. This permanently locks the conversation; use only when no further Build interaction is needed.',parameters:{type:'object',properties:{summary:{type:'string',minLength:1,maxLength:12000}},required:['summary'],additionalProperties:false}}
function withoutPendingMemory(inputs:readonly CascadedLlmInput[]):CascadedLlmInput[]{
 return inputs.filter(input=>{
  if(input.kind!=='host_context')return true
  try{return (JSON.parse(input.content) as {purpose?:unknown}|null)?.purpose!=='possible_memory'}catch{return true}
 })
}
const RESUME_CHECK='Resume the Build goal. Inspect actual state before continuing any cancelled, timed-out or unknown operation. Never replay a completed call.'
export async function createWorkbenchRuntime(options:{contextConsumer?:string|null;conversation:Readonly<Conversation>;host:PersonalAgentHost;factory:CascadedLlmFactory;createBridge:()=>Promise<ConversationRuntime>;emit:(frame:Record<string,unknown>)=>void;lifetime:AbortSignal;language:'zh-CN'|'en';telemetry?:RealtimeTelemetry;approval:'ask'|'never'|(()=>'ask'|'never');shell?:LocalShellOptions;computerSession?:(options:ComputerSessionOptions)=>Pick<ComputerSession,'observe'|'action'|'close'>;onDiagnostic?:(message:string)=>void;reasoning?:boolean}):Promise<ConversationRuntime>{
 const {conversation,host}=options,build=conversation.kind==='build',store=host.workbench
 const reasoningMode:'enabled'|'disabled'=options.reasoning===true?'enabled':'disabled'
 const approvalMode=():'ask'|'never'=>typeof options.approval==='function'?options.approval():options.approval
 const turnToolLimit=build?128:24
 const copy=workbenchCopy(options.language)
  const roundLimitReply=()=>copy.roundLimit(build,state.calls.filter(call=>call.state==='completed').length,turnToolLimit)
 if(build&&(!conversation.build||!['darwin','win32'].includes(process.platform)))throw Error('local_build_unavailable')
 const state=await store.checkpoint(conversation.id,conversation.generation)
 const confirmedPlan=build&&!state.confirmed_plan_omitted&&conversation.build?.plan_id&&conversation.build.plan_version?await store.plan(conversation.build.plan_id,conversation.build.plan_version):undefined
 const suppliedDependencies=mergeContextDependencies(host.conversationContextDependencies(conversation),confirmedPlan?await host.planContextDependencies(confirmedPlan):undefined)
 let previousDependencies=state.context_dependencies
 if(previousDependencies===undefined&&(state.model!==null||state.inputs.length)){
  previousDependencies=host.retainedConversationDependencies(conversation.id,conversation.generation)
  const matchedUser=conversation.messages.some(message=>message.role==='user'&&message.text===state.last_user)
  const containsText=(value:JsonValue):boolean=>typeof value==='string'||Array.isArray(value)&&value.some(containsText)||value!==null&&typeof value==='object'&&Object.values(value).some(containsText)
  const model=state.model
  const knownModel=model===null||!containsText(model)||!Array.isArray(model)&&typeof model==='object'&&model.protocol==='chat-completions'&&Array.isArray(model.history)&&model.history.every(unit=>Array.isArray(unit)&&unit.every(message=>message!==null&&typeof message==='object'&&!Array.isArray(message)&&typeof message.content==='string'&&conversation.messages.some(prior=>prior.role===message.role&&prior.text===message.content)))
  if(state.model!==null&&(!matchedUser||!knownModel))previousDependencies={state:'unavailable'}
 }
 state.context_dependencies=mergeContextDependencies(previousDependencies??emptyContextDependencies(),suppliedDependencies)
 const emit=(frame:Record<string,unknown>)=>options.emit({...frame,...(frame.role==='assistant'?{context_dependencies:state.context_dependencies}:{})})
 const authorizeContext=async(parent:AbortSignal)=>{
  parent.throwIfAborted()
  if(state.context_dependencies?.state==='tracked'&&!state.context_dependencies.items.length)return
  const signal=AbortSignal.any([parent,AbortSignal.timeout(5000)])
  for(let attempt=0;attempt<2;attempt++){
   signal.throwIfAborted()
   const before=await abortable(host.contextAuthorizationRevision(signal),signal)
   if(!await abortable(host.contextDependenciesAuthorized(state.context_dependencies!,options.contextConsumer??null),signal))throw Error('context_authorization_changed')
   const after=await abortable(host.contextAuthorizationRevision(signal),signal)
   signal.throwIfAborted()
   if(before===after)return
  }
  throw Error('context_authorization_changed')
 }
 state.inputs=withoutPendingMemory(state.inputs)
 const workspaceContext=()=>build?JSON.stringify({...(confirmedPlan&&!state.confirmed_plan_omitted?{confirmed_plan:{id:confirmedPlan.id,version:confirmedPlan.version,title:confirmedPlan.title,content:confirmedPlan.content}}:{}),project:conversation.build!.project}):null
 let session:CascadedLlmSession|undefined,bridgeRuntime:ConversationRuntime|undefined
 let closed=false,controller:AbortController|undefined,active:Promise<{assistant:string;turn_id?:string}>|undefined,version=state.run_version
 let computer:Pick<ComputerSession,'observe'|'action'|'close'>|undefined
 let currentComputerCall:WorkbenchCall|undefined,connectedApp:string|undefined
  const deniedByUser=new Map<WorkbenchCall,Record<string,JsonValue>>()
 let computerInputStarted=false
 let observeRequired=true
 let coordinateObservationRequired=true
 let verificationRequired=false
 for(const call of state.calls){
  if(call.name.startsWith('computer_')&&call.started_at&&call.name!=='computer_screenshot')verificationRequired=true
  if(call.name==='computer_screenshot'&&(call.result as {image_ref?:string}|undefined)?.image_ref)verificationRequired=false
 }
 if(state.reason==='cleanup_unknown')verificationRequired=true
 const computerState=()=>build?host.computerUseState(conversation.id):{enabled:false,direct:false}
 let computerVisible=false
 const computerFrame=(state:'active'|'acting'|'idle',action?:string,point?:{x:number;y:number})=>{
  if(state==='idle'&&!computerVisible)return
  computerVisible=state!=='idle'
  emit({type:'computer_use',conversation_id:conversation.id,state,...(action?{action}:{}),...(point?{point}:{})})
 }
 const closeComputer=async()=>{const previous=computer;computer=undefined;observeRequired=true;try{await previous?.close()}finally{computerFrame('idle')}}
 let approval:{id:string;call:WorkbenchCall;resolve:(approved:boolean)=>void}|undefined
 const model=()=>{if(!session){session=options.factory.open();session.setHistoryLimits?.({items:2048,codepoints:16*1024*1024});if(state.model!==null){if(!session.restoreCheckpoint)throw Error('model_checkpoint_unsupported');session.restoreCheckpoint(state.model)}else session.checkpoint?.()}return session}
 const bridge=async()=>{bridgeRuntime??=await options.createBridge();if(!bridgeRuntime.toolBridge)throw Error('conversation_tools_unavailable');return bridgeRuntime.toolBridge}
 let saving=Promise.resolve(),reasonDetail:string|null=null
 const save=()=>{
  state.updated_at=new Date().toISOString();const checkpoint=structuredClone(state),pendingApproval=approval?{id:approval.id,call_id:approval.call.id,name:approval.call.name,preview:JSON.stringify(approval.call.arguments,null,2).slice(0,1800)}:null
  // Retrieved context is one-shot: never persist it for retries or process recovery.
  checkpoint.inputs=withoutPendingMemory(checkpoint.inputs)
  const operation=saving.then(async()=>{await store.saveCheckpoint(checkpoint);if(build)await host.updateLocalBuild(conversation.id,conversation.generation,{status:checkpoint.status,reason:checkpoint.reason,reason_detail:checkpoint.reason?reasonDetail:null,approval:pendingApproval})})
  saving=operation.catch(()=>{ /* each caller observes its own persistence failure */ });return operation
 }
 const treeState=(owner:NonNullable<WorkbenchCall['process']>)=>options.shell?.processState?.(owner)??localShellTreeState(owner)
 // In-flight receipts from an earlier process are facts, never permission to retry.
 if(['running','awaiting_approval'].includes(state.status)){
  for(const call of state.pending_calls)if(call.state!=='completed'){
   call.result=call.state==='running'?{status:'outcome_unknown',...(call.name==='shell_execute'?{cleanup_confirmed:!call.process||treeState(call.process)==='gone'}:{}),message:'The previous process stopped during this operation. Inspect actual state before continuing.'}:{status:'cancelled_before_execution'};call.state='completed';delete call.approval_id
  }
  state.status=state.pending_calls.some(call=>(call.result as {status?:string}|undefined)?.status==='outcome_unknown')?'outcome_unknown':'paused';state.reason='restart_requires_resume';await save()
 }
 async function ask(call:WorkbenchCall,signal:AbortSignal,preview?:Pick<WorkbenchCall,'name'|'arguments'>):Promise<boolean>{
  const id=randomUUID();call.approval_id=id;call.state='awaiting_approval';state.status='awaiting_approval'
  let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(done=>{resolve=done});approval={id,call:preview?{...call,...preview}:call,resolve};await save()
  const cancel=()=>resolve(false);signal.addEventListener('abort',cancel,{once:true})
  try{if(signal.aborted)return false;return await promise}finally{signal.removeEventListener('abort',cancel);approval=undefined;delete call.approval_id}
 }
 async function run(text:string,parent:AbortSignal,context?:ConversationTurnContext):Promise<{assistant:string;turn_id?:string;context_dependencies?:ContextDependencies}>{
  if(closed||active)throw Error('conversation_busy')
  if(build&&state.status==='finished')throw Error('build_finished')
  if(build&&!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
  const own=new AbortController();controller=own;const signal=AbortSignal.any([parent,own.signal,options.lifetime]),runVersion=++version;state.run_version=runVersion
  const execute=async()=>{
   let release:(()=>void)|undefined
    // A shell command can exit while a child it started lives on; that holds the project, not the whole Build.
    const leftovers=()=>state.calls.filter(call=>call.name==='shell_execute'&&(call.result as {cleanup_confirmed?:boolean}|undefined)?.cleanup_confirmed===false)
    // No process identity or no tree evidence (Windows) is 'unknown': never proof of cleanup, only the user's acknowledgement releases it.
    const leftoverState=(call:WorkbenchCall)=>call.process?treeState(call.process):'unknown' as const
    const blockingLeftover=()=>leftovers().find(call=>leftoverState(call)!=='gone')
    const releaseProject=()=>{const key=projectResourceKey(conversation.build!.project);if(taskResourcesUncertain([key]))releaseQuarantinedTaskResources([key])}
    const settleLeftovers=()=>{
     const all=leftovers();if(!all.length||blockingLeftover())return
     for(const call of all)call.result={...(call.result as Record<string,JsonValue>),cleanup_confirmed:true}
     releaseProject()
    }
    // Resume on a "cannot verify" pause is the user's acknowledgement. Leftovers that are provably alive stay blocking.
    const acknowledgeLeftovers=()=>{
     const unknown=leftovers().filter(call=>leftoverState(call)==='unknown');if(!unknown.length)return
     for(const call of unknown)call.result={...(call.result as Record<string,JsonValue>),cleanup_confirmed:true,cleanup_acknowledged:true,cleanup_acknowledged_at:new Date().toISOString()}
     if(!blockingLeftover())releaseProject()
    }
    let holding:Promise<void>|undefined
    const holdProject=async()=>{
     if(release)return
     holding??=(async()=>{const key=projectResourceKey(conversation.build!.project);if(taskResourcesBusy([key]))throw Error('project_busy');release=await acquireTaskResources([key],signal)})().finally(()=>{holding=undefined})
     await holding
    }
    const leftoverCopy=(call:WorkbenchCall)=>{
     const command=commandLine(call),exit=(call.result as {exit_code?:number}|undefined)?.exit_code??0
     if(leftoverState(call)==='unknown')return {text:copy.unverifiable(command),detail:copy.unverifiableShort(command)}
     return {text:copy.leftover(command,exit),detail:copy.leftoverShort(command)}
    }
   try{
    reasonDetail=null
     state.context_dependencies=mergeContextDependencies(state.context_dependencies,host.referenceContextDependencies(context?.references??[]))
    await authorizeContext(signal)
    if(build){if(context?.resume&&state.reason==='cleanup_unconfirmed')acknowledgeLeftovers();settleLeftovers();if(!blockingLeftover())await holdProject()}
    state.inputs=withoutPendingMemory(state.inputs)
    const toolBridge=await bridge()
    if(!state.model&&!state.inputs.length){
     if(build)state.inputs.push({kind:'host_context',content:workspaceContext()!})
     else for(const message of conversation.messages.filter(message=>message.generation_status!=='pending'&&message.input_mode!=='voice').slice(-32))state.inputs.push({kind:'host_context',content:JSON.stringify({previous_message:{role:message.role,text:message.text}})})
    }
    const voiceMessages=conversation.messages.filter(message=>message.input_mode==='voice')
    for(const message of voiceMessages)if(!state.voice_message_ids?.includes(message.id))state.inputs.push({kind:'host_context',content:JSON.stringify({previous_message:{role:message.role,text:message.text},source:'voice',trust:'untrusted_external'})})
    state.voice_message_ids=voiceMessages.map(message=>message.id)
    if(!context?.resume){
     // Only typed user input can authorize explicit writes, never any host/tool/voice context.
     state.last_user=text;state.denied_classes=[]
     let injected=false
     if(toolBridge.prerecall){
      const budget=AbortSignal.any([signal,AbortSignal.timeout(400)])
      try{
       const prepared=await abortable(toolBridge.prerecall(text,budget),budget)
       const memory=prepared?await abortable(prepared(budget),budget):null
       budget.throwIfAborted()
       if(memory){state.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'possible_memory',trust:'untrusted_external',text:memory})});injected=true}
      }catch{ /* Retrieval is optional; failure or timeout must not block the turn. */ }
     }
     options.telemetry?.record('workbench.memory.injected',{injected})
     signal.throwIfAborted()
     state.inputs.push({kind:'user_text',text})
    }
    // Resume is a control action: it never invents a user turn in the provider conversation.
    else if(!state.inputs.length&&!state.pending_calls.length)state.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'resume_control',instruction:RESUME_CHECK})})
    if(context?.resume&&state.reason==='approval_denied'){
      const declined=state.pending_calls.filter(call=>['denied','denied_previously'].includes((call.result as {status?:string}|undefined)?.status??'')).map(call=>stepPhrase(call,'en'))
      state.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'denial_resume',declined,instruction:DENIED_RESUME_INSTRUCTION})})
     }
    state.status='running';state.reason=null;state.assistant='';delete state.model_failure;await save()
    const baseTools=build?[...toolBridge.tools.filter(tool=>tool.name!=='dispatch'),...LOCAL_TOOLS,finishTool]:[...toolBridge.tools.filter(tool=>toolBridge.readonlyNames.includes(tool.name)||memoryHostToolNames.has(tool.name)),publishTool]
    const authorizedTools=[...baseTools,...(build?computerTools(true):[])]
    const allowed=new Set(authorizedTools.map(tool=>tool.name));if(allowed.size!==authorizedTools.length||authorizedTools.length>128)throw Error('workbench_tool_configuration')
    let toolRounds=0,finishedReply:string|undefined,denials=0,batchDenied=false,unknownCall:WorkbenchCall|undefined,leftoverCall:WorkbenchCall|undefined
     const deniedSteps:string[]=[]
     // A denial covers its whole class for this turn and its resumes; a new typed message may ask again.
     const deniedClasses=new Set<string>(context?.resume?state.denied_classes??[]:[])
     const recordDenial=(call:WorkbenchCall,classes:readonly string[],previously:boolean,preview?:Pick<WorkbenchCall,'name'|'arguments'>)=>{
      // `shell:*` only marks "could not analyse"; it is remembered when nothing more specific is known.
      for(const klass of classes.length>1?classes.filter(item=>item!=='shell:*'):classes)deniedClasses.add(klass)
      state.denied_classes=[...deniedClasses].slice(-256).map(item=>item.slice(0,1000))
      denials++;batchDenied=true;deniedSteps.push(stepPhrase(preview?{...call,...preview}:call,options.language))
      return {status:previously?'denied_previously':'denied',message:previously?DENIED_BEFORE_MESSAGE:DENIED_MESSAGE,approval_classes:classes.slice(0,16)}
     }
    // Keep one turn identity across model rounds. Build commits tool-bound text before
    // the tool batch, while Plan keeps the accumulated answer.
    const turn=randomUUID();let turnText='',outputLimitContinues=0,toolTruncationRetried=false
    const compactCaption=(text:string,limit=4000):string=>{const points=[...text];return points.length>limit?points.slice(0,limit).join('')+'…':text}
    const emitTurnCaption=(roundText:string):void=>{
     const visible=compactCaption(mergeTurnText(turnText,roundText))
     emit({type:'caption',role:'assistant',text:visible,full_text:visible,turn_id:turn,final:false})
    }
    while(true){
     signal.throwIfAborted();if(version!==runVersion)throw Error('build_stale')
     const executeCall=async(call:WorkbenchCall)=>{
      signal.throwIfAborted()
      const wasCompleted=call.state==='completed'
      if(!wasCompleted&&toolRounds>=turnToolLimit)return
      if(call.state!=='completed'){
       toolRounds++
       if(isComputerTool(call.name)&&!computerState().enabled){call.result={code:'computer_use_disabled',message:'在 Build 会话里打开 Computer Use 后才能操作电脑'};call.state='completed'}
       else if(isComputerTool(call.name)&&!computerState().direct){call.result={code:'vision_model_required',message:COMPUTER_VISION_REQUIRED_MESSAGE};call.state='completed'}
       else if(!allowed.has(call.name)){call.result={code:'tool_not_authorized',state:'refused'};call.state='completed'}
       else if(isComputerTool(call.name)){
        const name=call.name,validation=computerToolArguments[name].safeParse(call.arguments)
        if(!validation.success){call.result={code:'invalid_params'};call.state='completed'}
        else if((observeRequired&&COMPUTER_WRITE_TOOLS.includes(name))||(coordinateObservationRequired&&(name==='computer_click'||name==='computer_scroll'))){call.result={code:'observe_required'};call.state='completed'}
        else{
         if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
         call.state='running';call.started_at=new Date().toISOString();state.status='running';await save()
         currentComputerCall=call;computerInputStarted=false
         const getComputer=async()=>{
          if(computer)return computer
          const Session=options.computerSession?undefined:(await import('./computer-use/session.js')).ComputerSession
          const create=options.computerSession??((settings:ComputerSessionOptions)=>new Session!(settings))
          let applicationAuthorized=false
          computer=create({
           signal,approve:async(action,params)=>{
            if(action!=='Connect'&&(applicationAuthorized||approvalMode()==='never'))return !signal.aborted&&computerState().enabled&&host.localBuildAuthorized(conversation.id)
            const app=action==='Connect'?computerApplicationSchema.safeParse((params as {application?:unknown})?.application):undefined
            if(app?.success&&await store.computerApplicationAllowed(app.data)){applicationAuthorized=true;connectedApp=app.data.bundleId;return !signal.aborted&&computerState().enabled&&host.localBuildAuthorized(conversation.id)}
            const current=currentComputerCall!
            const preview={name:action==='Connect'?'computer_connect':current.name,arguments:{action,params:JSON.parse(JSON.stringify(params)) as JsonValue}},klass=app?.success?'computer:'+app.data.bundleId:'computer-input:'+(connectedApp??'')
             if(classDenied([klass],deniedClasses)&&!signal.aborted){deniedByUser.set(current,recordDenial(current,[klass],true,preview));return false}
             const approved=await ask(current,signal,preview)
            if(approved&&app?.success){applicationAuthorized=true;connectedApp=app.data.bundleId}
            if(!approved&&!signal.aborted)deniedByUser.set(current,recordDenial(current,[klass],false,preview))
            state.status='running';current.state='running';await save()
            return approved&&computerState().enabled&&host.localBuildAuthorized(conversation.id)
           },acting:(action,point)=>{signal.throwIfAborted();if(!computerState().enabled||!host.localBuildAuthorized(conversation.id))throw Error('computer_use_disabled');computerInputStarted=true;computerFrame('acting',action,point)},
          })
          return computer
         }
         const capture=async(application?:string)=>{
          computerFrame('active',name)
          const {image,...observation}=await (await getComputer()).observe(application)
          const ref=await store.saveImage(conversation.id,conversation.generation,image)
          observeRequired=false;coordinateObservationRequired=false
          return {image_ref:ref,...observation,untrusted_application_data:['ax.summary','ax.editor']}
         }
         try{
          signal.throwIfAborted()
          if(!computerState().enabled)throw Error('computer_use_disabled')
          if(name==='computer_screenshot'){call.result=await capture('application' in validation.data?validation.data.application:undefined);verificationRequired=false}
          else{
           verificationRequired=true
           const receipt=await (await getComputer()).action(name,call.arguments);observeRequired=true;coordinateObservationRequired=true
           call.result={status:'completed',verified:false,...receipt};computerFrame('active',name)
          }
         }catch(error){
          let code=error instanceof Error?error.message:'action_failed'
          try{await closeComputer()}catch{code='cleanup_unknown'}
          let cause:unknown=error,detail:string|undefined;for(let depth=0;depth<4&&cause instanceof Error;depth++){if(/^native_gui:[a-z_]{1,80}$/u.test(cause.message))detail=cause.message;cause=cause.cause}
          call.result=deniedByUser.get(call)??{code,...(detail?{detail}:{}),status:code==='cleanup_unknown'||(signal.aborted&&computerInputStarted)?'outcome_unknown':signal.aborted?'cancelled_before_execution':'failed'}
          observeRequired=true
         }
         call.state='completed';call.finished_at=new Date().toISOString();await save()
        }
       }
       else if(isLocalTool(call.name)){
        if(!build)throw Error('local_tools_not_authorized')
        const validation=localToolArguments[call.name].safeParse(call.arguments)
        if(!validation.success){call.result={code:'invalid_params',issues:validation.error.issues.map(issue=>({path:issue.path.map(String).join('.'),message:issue.message}))};call.state='completed'}
        else{
         if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
         if(build){settleLeftovers();const stuck=blockingLeftover();if(stuck){leftoverCall=stuck;state.reason='cleanup_unconfirmed';toolRounds--;return}await holdProject()}
          // Reads inside the project stay free; a read that leaves it needs the same consent as a write.
         const needsApproval=approvalMode()==='ask'&&(call.name!=='file_read'||await localPathEscapesProject(conversation.build!.project,(validation.data as {path:string}).path).catch(()=>true))
         const klasses=needsApproval?approvalClasses(call,conversation.build!.project):[]
          if(needsApproval&&classDenied(klasses,deniedClasses)){call.result=recordDenial(call,klasses,true);call.state='completed';await save();return}
          if(needsApproval&&!await ask(call,signal)){
           if(signal.aborted){call.result={status:'denied',message:'This call was not executed. Wait for new user instructions.'};call.state='completed';state.reason='stopped';await save();return}
           call.result=recordDenial(call,klasses,false);call.state='completed';await save();return
         }
         signal.throwIfAborted();if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
         state.status='running';call.state='running';call.started_at=new Date().toISOString();await save() // intent must reach disk first
         if(signal.aborted||!host.localBuildAuthorized(conversation.id)){
          call.result={status:'cancelled_before_execution'};call.state='completed';call.finished_at=new Date().toISOString();
          signal.throwIfAborted();throw Error('local_build_not_authorized')
         }
         try{call.result=await executeLocalTool(call.name,call.arguments,conversation.build!.project,signal,{...options.shell,onStarted:async owner=>{call.process=owner;await save();await options.shell?.onStarted?.(owner)}})}
         catch(error){call.result={status:signal.aborted?'outcome_unknown':'failed',code:error instanceof Error?error.message:'tool_failed'}}
         call.state='completed';call.finished_at=new Date().toISOString();await save()
        }
       }else if(call.name==='finish_build'){
        const q=finishArguments.safeParse(call.arguments)
        if(!build||!q.success){call.result={code:'invalid_params',state:'refused'};call.state='completed'}
        else if(verificationRequired){call.result={code:'verification_required'};call.state='completed'}
        else{
         call.state='running';call.started_at=new Date().toISOString();await save();signal.throwIfAborted()
         await closeComputer();signal.throwIfAborted()
         if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
         const finished=await host.finishLocalBuild(conversation.id,conversation.generation,context?.user_message_id)
         call.result={finished,...(!finished?{reason:'new_user_input_received'}:{})};call.state='completed';call.finished_at=new Date().toISOString()
         if(finished){state.status='finished';state.reason=null;finishedReply=q.data.summary}
        }
        await save()
       }else if(call.name==='publish_plan'){
        const q=publishArguments.safeParse(call.arguments)
        if(!q.success){call.result={code:'invalid_params',issues:q.error.issues.map(issue=>({path:issue.path.map(String).join('.'),message:issue.message}))};call.state='completed'}
        else {
         call.state='running';call.started_at=new Date().toISOString();await save();signal.throwIfAborted()
         const plan=await host.publishPlan(conversation.id,conversation.generation,q.data.title,q.data.content,call.id,state.context_dependencies)
         call.result={published:true,id:plan.id,version:plan.version,title:plan.title};call.state='completed';call.finished_at=new Date().toISOString()
        }
        await save()
       }else{
        call.state='running';call.started_at=new Date().toISOString();await save()
        try{call.result=await toolBridge.invoke(state.last_user,call,signal)}catch(error){call.result={status:signal.aborted?'outcome_unknown':'failed',code:error instanceof Error?error.message:'tool_failed'}}
        call.state='completed';call.finished_at=new Date().toISOString();await save()
       }
      }
      if(!wasCompleted){
       const result=call.result as {status?:string;exit_code?:number|null;cleanup_confirmed?:boolean}|undefined
       if(build&&call.name==='shell_execute'&&result?.cleanup_confirmed===false){
        quarantineTaskResources([projectResourceKey(conversation.build!.project)]);release=undefined
        // The command itself finished: report its real result and hold the project instead of stopping the Build.
        if(typeof result.exit_code==='number')call.result={...(call.result as Record<string,JsonValue>),message:'The command exited, but some child processes could not be confirmed stopped. The host holds this project and verifies before the next local operation; continue with work that does not touch the project.'}
       }
       if(result?.status==='outcome_unknown'){state.reason='outcome_unknown';unknownCall=call}
      }
     }
     // The approval slot is single; a read that must ask therefore runs alone like a write.
     const askingReads=new Set<string>()
     if(build&&approvalMode()==='ask')for(const call of state.pending_calls)if(call.name==='file_read'&&call.state!=='completed'){
      const q=localToolArguments.file_read.safeParse(call.arguments)
      if(!q.success||await localPathEscapesProject(conversation.build!.project,q.data.path).catch(()=>true))askingReads.add(call.id)
     }
     const concurrent=(call:WorkbenchCall)=>allowed.has(call.name)&&(call.name==='file_read'&&!askingReads.has(call.id)||toolBridge.readonlyNames.includes(call.name))
     for(let index=0;index<state.pending_calls.length;){
      const call=state.pending_calls[index]!
      if(call.state==='completed'){index++;continue}
      if(toolRounds>=turnToolLimit)break
      if(concurrent(call)){
       const group:WorkbenchCall[]=[],capacity=Math.min(4,turnToolLimit-toolRounds)
       while(index<state.pending_calls.length&&group.length<capacity){
        const next=state.pending_calls[index]!
        if(next.state==='completed'){index++;continue}
        if(!concurrent(next))break
        group.push(next);index++
       }
       // Settle every read before cancellation/recovery can change their durable state.
       const results=await Promise.allSettled(group.map(executeCall)),failure=results.find(result=>result.status==='rejected')
       if(failure?.status==='rejected')throw failure.reason
      }else{await executeCall(call);index++}
       if(batchDenied){
        batchDenied=false
        for(const rest of state.pending_calls)if(rest.state!=='completed'){rest.result={status:'cancelled_before_execution',message:SKIPPED_MESSAGE};rest.state='completed'}
        if(denials>=2&&!state.reason)state.reason='approval_denied'
        await save();break
       }
      if(state.reason)break
      if(finishedReply!==undefined)break
     }
     if(state.reason){
       // A leftover-process pause keeps its call prepared: Resume verifies first, then runs it once.
       if(state.reason!=='cleanup_unconfirmed')for(const call of state.pending_calls)if(call.state==='prepared'){call.result={status:'cancelled_before_execution'};call.state='completed'}
       let assistant=copy.generic
       if(state.reason==='approval_denied'){assistant=copy.denied(deniedSteps);reasonDetail=copy.deniedShort(deniedSteps)}
       else if(state.reason==='stopped'){const user=signal.reason==='user_stop';assistant=user?copy.stopped(build):copy.pausedNeutral(build);reasonDetail=user?copy.stoppedShort:copy.pausedShort}
       else if(state.reason==='cleanup_unconfirmed'&&leftoverCall){const note=leftoverCopy(leftoverCall);assistant=note.text;reasonDetail=note.detail}
       else if(state.reason==='outcome_unknown'){const step=unknownCall?stepPhrase(unknownCall,options.language):options.language==='en'?'the last operation':'上一步操作';assistant=copy.unknown(step);reasonDetail=copy.unknownShort(step)}
       state.status=state.reason==='outcome_unknown'?'outcome_unknown':'paused';await save();return {assistant}
      }
     if(finishedReply!==undefined){for(const call of state.pending_calls)if(call.state!=='completed'){call.result={status:'cancelled_after_finish'};call.state='completed'}state.status='finished';await save();return {assistant:finishedReply,turn_id:randomUUID()}}
     if(state.pending_calls.some(call=>call.state!=='completed')){state.status='paused';state.reason='round_limit';reasonDetail=build?copy.roundLimitShort(state.calls.filter(call=>call.state==='completed').length):null;await save();return {assistant:roundLimitReply()}}
     if(state.pending_calls.length){
      const uncertain=state.pending_calls.some(call=>['outcome_unknown','timed_out','cancelled'].includes((call.result as {status?:string}|undefined)?.status??''))
      state.inputs.unshift(...await Promise.all(state.pending_calls.map(async call=>{
       const ref=isComputerTool(call.name)?(call.result as {image_ref?:string}|undefined)?.image_ref:undefined
       const images:ToolImage[]|undefined=ref&&computerState().direct?[await store.loadImage(conversation.id,conversation.generation,ref)]:undefined
       return {kind:'tool_result' as const,call_id:call.id,output:call.result??{status:'outcome_unknown'},...(images?{images}:{})}
      })))
      if(uncertain)state.inputs.push({kind:'host_context',content:RESUME_CHECK})
      state.pending_calls=[];await save()
     }
     if(toolRounds>=turnToolLimit){state.status='paused';state.reason='round_limit';reasonDetail=build?copy.roundLimitShort(state.calls.filter(call=>call.state==='completed').length):null;await save();return {assistant:roundLimitReply()}}
     const enabled=computerState(),tools=[...baseTools,...(enabled.enabled?computerTools(enabled.direct):[])]
     try{await authorizeContext(signal)}catch(error){
      signal.throwIfAborted()
      if(!build||!(error instanceof Error)||(error.message!=='context_authorization_changed'&&error.name!=='TimeoutError'))throw error
      // Keep local receipts, but start a fresh model session without withdrawn inputs or tool output.
      await session?.close();session=undefined
      state.model=null
      state.context_dependencies=emptyContextDependencies()
      if(confirmedPlan)state.confirmed_plan_omitted=true
      const completed=state.calls.filter(call=>call.state==='completed'&&allowed.has(call.name)).slice(-32).map(call=>call.name)
      state.inputs=[
       {kind:'user_text',text:state.last_user},
       {kind:'host_context',content:JSON.stringify({purpose:'resume_without_previous_context',completed_tools:completed,instruction:'Some prior reference material is unavailable. Continue the authorized work with current inputs. Inspect actual project state before acting and do not repeat completed operations. If the goal depended on unavailable material, complete independent work and explain what is missing.'})},
      ]
      turnText=options.language==='en'?'Some reference material is unavailable. Continuing with the available context.':'部分引用资料已不可用，继续使用现有资料执行。'
      state.assistant=turnText
      await save()
      emitTurnCaption('')
     }
     const workspace=workspaceContext()
     const llm=model(),before=state.model,inputs=structuredClone(state.inputs),calls:WorkbenchCall[]=[];let assistant='',preview='',captionSent=false,completed=false
     // Only this attempt may consume the freshly authorized context, including on output-limit retries.
     state.inputs=withoutPendingMemory(state.inputs)
     // One bounded thought per model round; display-only, never model input or history.
     let thinkingChunks:string[]=[],thinkingCodepoints=0,thinkingStartedAt:string|null=null
     const addThinking=(text:string):void=>{
      const left=MAX_WORKBENCH_THOUGHT_CODEPOINTS-thinkingCodepoints
      if(left<=0||text==='')return
      // The thought belongs before the tool calls it produces, so keep the
      // timestamp of its first delta instead of the round's completion time.
      thinkingStartedAt??=new Date().toISOString()
      const points=[...text]
      thinkingChunks.push(points.length<=left?text:points.slice(0,left).join(''));thinkingCodepoints+=Math.min(points.length,left)
     }
     const recordThinking=():void=>{
      if(!thinkingChunks.length)return
      const text=thinkingChunks.join(''),created_at=thinkingStartedAt??new Date().toISOString()
      thinkingChunks=[];thinkingCodepoints=0;thinkingStartedAt=null
      const thoughts=state.thoughts??[]
      thoughts.push({id:randomUUID(),text,created_at,...(context?.user_message_id?{message_id:context.user_message_id}:{})})
      state.thoughts=thoughts.slice(-MAX_WORKBENCH_THOUGHTS)
     }
     try{
      for await(const event of llm.stream({language:options.language,previewText:true,reasoning:reasoningMode,inputs,tools,workspaceContext:enabled.enabled?[workspace,computerUseSkill(enabled.direct)].filter(Boolean).join('\n'):workspace,signal})){
       if(event.kind==='reasoning_delta'){addThinking(event.text);signal.throwIfAborted();if(version!==runVersion)throw Error('build_stale');continue}
       signal.throwIfAborted();if(version!==runVersion)throw Error('build_stale')
       if(event.kind==='text_preview'||event.kind==='text_delta'){
        if(event.kind==='text_preview'){const points=[...preview+event.text];preview=points.length>16000?points.slice(0,16000).join(''):points.join('')}
        else{assistant+=event.text;preview=''}
        // Keep progress frames compact from the head: the opening paragraph must not scroll out
        // of the live caption before the durable reply replaces it.
        captionSent=true
        emitTurnCaption(assistant+preview)
       }
       else if(event.kind==='tool_call'){
        // Narration before a tool call is the opening of this turn's answer, not display-only
        // speculation: commit it as authoritative and keep it across the tool round.
        if(preview){assistant=mergeTurnText(assistant,preview);preview=''}
        if(calls.some(call=>call.id===event.call_id))throw Error('duplicate_tool_call');calls.push({id:event.call_id,name:event.name,arguments:structuredClone(event.arguments),state:'prepared',created_at:new Date().toISOString(),...(context?.user_message_id?{message_id:context.user_message_id}:{})})}
       else if(event.kind==='response_completed')completed=true
       else if(event.kind==='response_failed'){
        const code=/^[a-z_]{1,64}$/u.test(event.code)?event.code:'unknown',detail=event.detail&&/^[a-z_]{1,64}$/u.test(event.detail)?event.detail:undefined,count=event.tool_call_count
        state.model_failure={code,...(detail?{detail}:{}),...(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=128?{tool_call_count:count}:{})}
        throw Error('model_'+code+(detail?'_'+detail:''))
       }
      }
      if(!completed)throw Error('model_response_incomplete')
      if(preview){assistant=mergeTurnText(assistant,preview);preview=''}
      recordThinking()
      if(!llm.checkpoint)throw Error('model_checkpoint_unsupported')
      state.model=llm.checkpoint();state.inputs=[];delete state.model_failure
      const roundText=mergeTurnText(turnText,assistant)
      const narratedCall=build&&roundText.trim()?calls.find(call=>!state.calls.some(previous=>previous.id===call.id)):undefined
      if(narratedCall)narratedCall.narration=compactCaption(roundText,16000)
      turnText=narratedCall?'':roundText
      if(turnText.length>16000)await store.saveReply(conversation.id,conversation.generation,turn,turnText)
      state.assistant=turnText.slice(0,16000)
      for(const call of calls){const prior=state.calls.find(item=>item.id===call.id);if(prior){if(prior.name!==call.name||JSON.stringify(prior.arguments)!==JSON.stringify(call.arguments))throw Error('tool_call_id_conflict');state.pending_calls.push(prior)}else {state.calls.push(call);state.pending_calls.push(call)}}
      await save()
      if(narratedCall)emit({type:'caption',role:'assistant',text:'',full_text:'',turn_id:turn,final:true})
     }catch(error){
      recordThinking()
      const reason=error instanceof Error?error.message:''
      // An output-limit failure is respendable: the provider stopped at its ceiling without a
      // protocol error. Continue text turns at most twice; retry a truncated tool call once with
      // an instruction to split the payload, and never execute the truncated call itself.
      const outputLimit=reason==='model_output_limit'||reason.startsWith('model_output_limit_')
      if(outputLimit&&version===runVersion&&!signal.aborted){
       state.model=before;await session?.close();session=undefined
       // Keep the text that did arrive before the ceiling: the continuation extends it.
       turnText=mergeTurnText(turnText,assistant);state.assistant=turnText.slice(0,16000)
       const truncatedTool=reason.endsWith('_tool_arguments'),partial=assistant.slice(-4000),en=options.language==='en'
       if(!truncatedTool&&outputLimitContinues<2){
        outputLimitContinues+=1
        state.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'output_limit_continuation',attempt:outputLimitContinues,previous_partial:partial,instruction:en?'The previous reply was cut off by the model output limit before it finished. Continue the same answer from where it stopped without repeating text the user already saw, and finish the requested work in this turn.':'上一轮回复因模型输出长度上限在完成前被截断。请从截断处继续同一段回答，不要重复用户已经看到的内容，并在本轮完成用户要求的全部工作。'})})
        delete state.model_failure;await save();continue
       }
       if(truncatedTool&&!toolTruncationRetried){
        toolTruncationRetried=true
        state.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'output_limit_tool_split',attempt:1,previous_partial:partial,instruction:en?'The previous tool call was cut off by the model output limit and was NOT executed. Do not send one oversized call: split the payload into several smaller sequential calls (for example one file or one section per call) and never repeat a call that already completed.':'上一轮工具调用因输出长度上限被截断，且没有被执行。不要再次发送一个超大的调用：请把内容拆成多个较小的串行调用（例如每次只写一个文件或一个段落），不要重复已经完成的调用。'})})
        delete state.model_failure;await save();continue
       }
       state.status='paused';state.reason='model_output_limit'
       const modeLabel=build?'Build':'Plan',limitLabel=truncatedTool
        ?(en?'the tool call exceeded the model output limit and was not executed':`工具调用超出模型输出长度上限，未执行`)
        :(en?'the model reply exceeded its output limit':'模型回复超出输出长度上限')
       const continuation=copy.outputLimitContinue(build)
       const notice=en?`${modeLabel} paused: ${limitLabel}. ${continuation}`:`${modeLabel} 已暂停：${limitLabel}。${continuation}`
       const fullReply=mergeTurnText(turnText,notice)
       if(fullReply.length>16000)await store.saveReply(conversation.id,conversation.generation,turn,fullReply)
       const visible=fullReply.length>16000?turnText.slice(0,16000-notice.length-2)+'\n\n'+notice:fullReply
       state.assistant=visible;reasonDetail=build?limitLabel.charAt(0).toUpperCase()+limitLabel.slice(1):null;await save()
       return {assistant:visible,...(fullReply.length>16000?{full_text_ref:true}:{}),turn_id:turn}
      }
      if(captionSent&&version===runVersion)emit({type:'caption',role:'assistant',text:'',full_text:'',turn_id:turn,final:true})
      state.model=before;await session?.close();session=undefined
      if(error instanceof Error&&'code' in error&&typeof error.code==='string'){const detail='detail' in error&&typeof error.detail==='string'&&/^[a-z_]{1,64}$/u.test(error.detail)?'_'+error.detail:'';throw Error('model_'+error.code+detail,{cause:error})}
      throw error
     }
     if(!calls.length){state.status='completed';state.reason=null;await save();return {assistant:turnText,turn_id:turn}}
    }
   }catch(error){
    if(error instanceof Error&&error.message==='context_authorization_changed'){if(state.status!=='outcome_unknown')state.status='paused';state.reason='context_authorization_changed';await save();throw error}
    for(const call of state.pending_calls)if(call.state!=='completed'){
     call.result={status:call.state==='running'?'outcome_unknown':'cancelled_before_execution'};call.state='completed';delete call.approval_id
    }
    approval=undefined
    const reason=error instanceof Error?error.message:'build_failed',modelInterrupted=build&&reason.startsWith('model_')
    if(/^model_[a-z_]{1,96}$/u.test(reason))options.onDiagnostic?.('[workbench-diagnostic] '+JSON.stringify({mode:build?'build':'plan',conversation_id:conversation.id,generation:conversation.generation,reason,...(state.model_failure?{model_failure:state.model_failure}:{})}))
    if(reason==='cleanup_unknown')verificationRequired=true
    state.status=reason==='cleanup_unknown'?'outcome_unknown':signal.aborted||modelInterrupted?'paused':'failed';state.reason=signal.aborted?'stopped':reason;const user=signal.reason==='user_stop';if(signal.aborted)reasonDetail=user?copy.stoppedShort:copy.pausedShort;await save();if(signal.aborted)return {assistant:user?copy.stopped(build):copy.pausedNeutral(build)}
    if(modelInterrupted){
     const label=options.language==='en'?({model_timeout:'The model stopped returning data',model_overflow:'The model response exceeded the stream capacity',model_http:'The model service returned an error',model_network:'The model connection was interrupted',model_output_limit:'The model reply exceeded its output limit',model_output_limit_tool_arguments:'The tool call exceeded the model output limit and was not executed',model_protocol_output_limit:'The model reply exceeded its output limit'} as Record<string,string>)[reason]??'The model response was interrupted':({model_timeout:'模型等待数据超时',model_overflow:'模型回复超出流容量限制',model_http:'模型服务返回错误',model_network:'模型连接中断',model_output_limit:'模型回复超出输出长度上限',model_output_limit_tool_arguments:'工具调用超出模型输出长度上限，未执行',model_protocol_output_limit:'模型回复超出输出长度上限'} as Record<string,string>)[reason]??'模型回复中断'
     reasonDetail=label;await save()
      return {assistant:copy.modelPaused(label)}
    }
    throw error
   }
   finally{
    try{await closeComputer()}catch(error){
     verificationRequired=true;state.status='outcome_unknown';state.reason='cleanup_unknown'
     const last=state.calls.findLast(call=>isComputerTool(call.name)&&call.started_at)
     if(last)last.result={...(last.result&&typeof last.result==='object'&&!Array.isArray(last.result)?last.result:{}),status:'outcome_unknown',code:'cleanup_unknown'}
     await save();throw error
    }finally{release?.();controller=undefined}
   }
  }
  const operation=execute();active=operation
  try{return {...await operation,context_dependencies:state.context_dependencies!}}finally{if(active===operation)active=undefined}
 }
 return {
  runTurn:run,canSwitch:()=>!active,
  stopBuild:async()=>{controller?.abort('user_stop');approval?.resolve(false);await active},
  localApproval:async(id,approved,always)=>{
   if(approval?.id!==id||!active||controller?.signal.aborted)throw Error('local_approval_stale')
   const current=approval
   if(always){
    if(!approved||current.call.name!=='computer_connect')throw Error('invalid_application_consent')
    const params=current.call.arguments.params as {application?:unknown}|undefined
    await store.allowComputerApplication(computerApplicationSchema.parse(params?.application))
   }
   if(approval!==current||controller?.signal.aborted)throw Error('local_approval_stale')
   approval=undefined;current.resolve(approved)
  },
  close:async()=>{if(closed)return;closed=true;controller?.abort();approval?.resolve(false);await active;await session?.close();await bridgeRuntime?.close()},
  approvalDecision:async(id,approved)=>{if(!bridgeRuntime?.approvalDecision)throw Error('approval_unavailable');await bridgeRuntime.approvalDecision(id,approved)},
  retainTasks:()=>bridgeRuntime?.retainTasks?.()??false,
  ownsWork:id=>bridgeRuntime?.ownsWork?.(id)??false,
  confirmationDecision:async(id,confirmed)=>{if(!bridgeRuntime?.confirmationDecision)throw Error('confirmation_unavailable');await bridgeRuntime.confirmationDecision(id,confirmed)},
 }
}
