import {computerApplicationSchema} from './computer-use/contract.js'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {Conversation,ConversationRuntime,ConversationTurnContext} from './conversations.js'
import type {PersonalAgentHost} from './host.js'
import type {CascadedLlmFactory,CascadedLlmSession,CascadedLlmTool} from '../realtime/cascaded/llm.js'
import {LOCAL_TOOLS,executeLocalTool,isLocalTool,localPathEscapesProject,localToolArguments,projectResourceKey} from './local-tools.js'
import {acquireTaskResources,taskResourcesBusy,quarantineTaskResources} from '../executors/task-resources.js'
import {localShellProcessGone,type LocalShellOptions} from './local-shell.js'
import type {JsonValue} from '../core/events.js'
import type {WorkbenchCall} from './workbench-store.js'
import type {ComputerSession,ComputerSessionOptions} from './computer-use/session.js'
import {computerTools} from './computer-use/tools.js'
import {computerUseSkill} from './computer-use/skill.js'
import {isComputerTool,computerToolArguments,COMPUTER_WRITE_TOOLS,type ToolImage} from './computer-use/contract.js'

const publishArguments=z.object({title:z.string().min(1).max(120),content:z.string().min(1).max(131072)}).strict()
const publishTool:CascadedLlmTool={name:'publish_plan',description:'Publish the complete detailed plan for the user to review and choose local Build or executor Build. This does not authorize or start execution. Call again to publish an amended version.',parameters:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:120},content:{type:'string',minLength:1,maxLength:131072}},required:['title','content'],additionalProperties:false}}
const finishArguments=z.object({summary:z.string().min(1).max(12000)}).strict()
const finishTool:CascadedLlmTool={name:'finish_build',description:'End this Build conversation after the confirmed work and verification are complete. Provide the final user-facing summary. This permanently locks the conversation; use only when no further Build interaction is needed.',parameters:{type:'object',properties:{summary:{type:'string',minLength:1,maxLength:12000}},required:['summary'],additionalProperties:false}}
const RESUME_CHECK='Resume the confirmed plan. Inspect actual state before continuing any cancelled, timed-out or unknown operation. Never replay a completed call.'
export async function createWorkbenchRuntime(options:{conversation:Readonly<Conversation>;host:PersonalAgentHost;factory:CascadedLlmFactory;createBridge:()=>Promise<ConversationRuntime>;emit:(frame:Record<string,unknown>)=>void;lifetime:AbortSignal;language:'zh-CN'|'en';approval:'ask'|'never';shell?:LocalShellOptions;computerSession?:(options:ComputerSessionOptions)=>Pick<ComputerSession,'screenshot'|'action'|'close'>;onDiagnostic?:(message:string)=>void}):Promise<ConversationRuntime>{
 const {conversation,host}=options,build=conversation.kind==='build',store=host.workbench
 const turnToolLimit=build?128:24
 const roundLimitReply=()=>options.language==='en'?(build?'Build paused at the 128-call limit. Click Resume to continue.':'Plan paused at the 24-call limit. Send a message to continue planning.'):(build?'已达到本次 128 次工具调用上限，Build 已暂停。点击 Resume 继续。':'已达到本次 24 次工具调用上限，Plan 已暂停。发送消息继续完善计划。')
 if(build&&(!conversation.build||!['darwin','win32'].includes(process.platform)))throw Error('local_build_unavailable')
 const state=await store.checkpoint(conversation.id,conversation.generation)
 const confirmedPlan=build?await store.plan(conversation.build!.plan_id,conversation.build!.plan_version):undefined
 const workspaceContext=confirmedPlan?JSON.stringify({confirmed_plan:{id:confirmedPlan.id,version:confirmedPlan.version,title:confirmedPlan.title,content:confirmedPlan.content},project:conversation.build!.project}):null
 let session:CascadedLlmSession|undefined,bridgeRuntime:ConversationRuntime|undefined
 let closed=false,controller:AbortController|undefined,active:Promise<{assistant:string;turn_id?:string}>|undefined,version=state.run_version
 let computer:Pick<ComputerSession,'screenshot'|'action'|'close'>|undefined
 let currentComputerCall:WorkbenchCall|undefined
 let computerInputStarted=false
 let observeRequired=true
 let coordinateObservationRequired=true
 let verificationRequired=false
 for(const call of state.calls){
  if(isComputerTool(call.name)&&call.started_at&&(COMPUTER_WRITE_TOOLS.includes(call.name)||call.name==='computer_run'))verificationRequired=true
  if((call.name==='computer_screenshot'||call.name==='computer_run')&&(call.result as {image_ref?:string}|undefined)?.image_ref)verificationRequired=false
 }
 if(state.reason==='cleanup_unknown')verificationRequired=true
 const computerState=()=>build?host.computerUseState(conversation.id):{enabled:false,direct:false}
 let computerVisible=false
 const computerFrame=(state:'active'|'acting'|'delegated'|'idle',action?:string,point?:{x:number;y:number})=>{
  if(state==='idle'&&!computerVisible)return
  computerVisible=state!=='idle'
  options.emit({type:'computer_use',conversation_id:conversation.id,state,...(action?{action}:{}),...(point?{point}:{})})
 }
 const closeComputer=async()=>{const previous=computer;computer=undefined;observeRequired=true;try{await previous?.close()}finally{computerFrame('idle')}}
 let approval:{id:string;call:WorkbenchCall;resolve:(approved:boolean)=>void}|undefined
 const model=()=>{if(!session){session=options.factory.open();session.setHistoryLimits?.({items:2048,codepoints:16*1024*1024});if(state.model!==null){if(!session.restoreCheckpoint)throw Error('model_checkpoint_unsupported');session.restoreCheckpoint(state.model)}else session.checkpoint?.()}return session}
 const bridge=async()=>{bridgeRuntime??=await options.createBridge();if(!bridgeRuntime.toolBridge)throw Error('conversation_tools_unavailable');return bridgeRuntime.toolBridge}
 let saving=Promise.resolve()
 const save=()=>{
  state.updated_at=new Date().toISOString();const checkpoint=structuredClone(state),pendingApproval=approval?{id:approval.id,call_id:approval.call.id,name:approval.call.name,preview:JSON.stringify(approval.call.arguments,null,2).slice(0,1800)}:null
  const operation=saving.then(async()=>{await store.saveCheckpoint(checkpoint);if(build)await host.updateLocalBuild(conversation.id,conversation.generation,{status:checkpoint.status,reason:checkpoint.reason,approval:pendingApproval})})
  saving=operation.catch(()=>{ /* each caller observes its own persistence failure */ });return operation
 }
 // In-flight receipts from an earlier process are facts, never permission to retry.
 if(['running','awaiting_approval'].includes(state.status)){
  for(const call of state.pending_calls)if(call.state!=='completed'){
   call.result=call.state==='running'?{status:'outcome_unknown',...(call.name==='shell_execute'?{cleanup_confirmed:!call.process||localShellProcessGone(call.process)}:{}),message:'The previous process stopped during this operation. Inspect actual state before continuing.'}:{status:'cancelled_before_execution'};call.state='completed';delete call.approval_id
  }
  state.status=state.pending_calls.some(call=>(call.result as {status?:string}|undefined)?.status==='outcome_unknown')?'outcome_unknown':'paused';state.reason='restart_requires_resume';await save()
 }
 async function ask(call:WorkbenchCall,signal:AbortSignal,preview?:Pick<WorkbenchCall,'name'|'arguments'>):Promise<boolean>{
  const id=randomUUID();call.approval_id=id;call.state='awaiting_approval';state.status='awaiting_approval'
  let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(done=>{resolve=done});approval={id,call:preview?{...call,...preview}:call,resolve};await save()
  const cancel=()=>resolve(false);signal.addEventListener('abort',cancel,{once:true})
  try{if(signal.aborted)return false;return await promise}finally{signal.removeEventListener('abort',cancel);approval=undefined;delete call.approval_id}
 }
 async function run(text:string,parent:AbortSignal,context?:ConversationTurnContext):Promise<{assistant:string;turn_id?:string}>{
  if(closed||active)throw Error('conversation_busy')
  if(build&&state.status==='finished')throw Error('build_finished')
  if(build&&!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
  const own=new AbortController();controller=own;const signal=AbortSignal.any([parent,own.signal,options.lifetime]),runVersion=++version;state.run_version=runVersion
  const execute=async()=>{
   let release:(()=>void)|undefined
   try{
    if(build){const key=projectResourceKey(conversation.build!.project);if(taskResourcesBusy([key]))throw Error('project_busy');release=await acquireTaskResources([key],signal)}
    if(!state.model&&!state.inputs.length){
     if(build)state.inputs.push({kind:'host_context',content:workspaceContext!})
     else for(const message of conversation.messages.filter(message=>message.generation_status!=='pending').slice(-32))state.inputs.push({kind:'host_context',content:JSON.stringify({previous_message:{role:message.role,text:message.text}})})
    }
    if(!context?.resume){state.last_user=text;state.inputs.push({kind:'user_text',text})}
    else if(!state.inputs.length&&!state.pending_calls.length)state.inputs.push({kind:'user_text',text:RESUME_CHECK})
    if(context?.resume&&state.reason==='approval_denied')return {assistant:'上次操作已拒绝，请补充新的要求后继续。'}
    state.status='running';state.reason=null;state.assistant='';delete state.model_failure;await save()
    const toolBridge=await bridge(),baseTools=build?[...toolBridge.tools.filter(tool=>tool.name!=='dispatch'),...LOCAL_TOOLS,finishTool]:[...toolBridge.tools.filter(tool=>toolBridge.readonlyNames.includes(tool.name)),publishTool]
    const authorizedTools=[...baseTools,...(build?computerTools(true):[])]
    const allowed=new Set(authorizedTools.map(tool=>tool.name));if(allowed.size!==authorizedTools.length||authorizedTools.length>128)throw Error('workbench_tool_configuration')
    let toolRounds=0,finishedReply:string|undefined
    while(true){
     signal.throwIfAborted();if(version!==runVersion)throw Error('build_stale')
     const executeCall=async(call:WorkbenchCall)=>{
      signal.throwIfAborted()
      const wasCompleted=call.state==='completed'
      if(!wasCompleted&&toolRounds>=turnToolLimit)return
      if(call.state!=='completed'){
       toolRounds++
       if(isComputerTool(call.name)&&!computerState().enabled){call.result={code:'computer_use_disabled',message:'在 Build 会话里打开 Computer Use 后才能操作电脑'};call.state='completed'}
       else if(!allowed.has(call.name)){call.result={code:'tool_not_authorized',state:'refused'};call.state='completed'}
       else if(isComputerTool(call.name)){
        const name=call.name,validation=computerToolArguments[name].safeParse(call.arguments)
        if(!validation.success){call.result={code:'invalid_params'};call.state='completed'}
        else if(!computerState().direct&&name!=='computer_run'){call.result={code:'vision_model_required'};call.state='completed'}
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
            if(action!=='Connect'&&(applicationAuthorized||options.approval==='never'))return !signal.aborted&&computerState().enabled&&host.localBuildAuthorized(conversation.id)
            const app=action==='Connect'?computerApplicationSchema.safeParse((params as {application?:unknown})?.application):undefined
            if(app?.success&&await store.computerApplicationAllowed(app.data)){applicationAuthorized=true;return !signal.aborted&&computerState().enabled&&host.localBuildAuthorized(conversation.id)}
            const current=currentComputerCall!
            const approved=await ask(current,signal,{name:action==='Connect'?'computer_connect':current.name,arguments:{action,params:JSON.parse(JSON.stringify(params)) as JsonValue}})
            if(approved&&app?.success)applicationAuthorized=true
            if(!approved&&!signal.aborted)state.reason='approval_denied'
            state.status='running';current.state='running';await save()
            return approved&&computerState().enabled&&host.localBuildAuthorized(conversation.id)
           },acting:(action,point)=>{signal.throwIfAborted();if(!computerState().enabled||!host.localBuildAuthorized(conversation.id))throw Error('computer_use_disabled');computerInputStarted=true;computerFrame('acting',action,point)},
          })
          return computer
         }
         const capture=async(application?:string)=>{
          computerFrame('active',name)
          const image=await (await getComputer()).screenshot(application)
          const ref=await store.saveImage(conversation.id,conversation.generation,image)
          observeRequired=false;coordinateObservationRequired=false
          return {image_ref:ref,...(image.native_ui?{native_ui:image.native_ui}:{}),...(image.native_editor?{native_editor:image.native_editor}:{})}
         }
         try{
          signal.throwIfAborted()
          if(!computerState().enabled)throw Error('computer_use_disabled')
          if(name==='computer_screenshot'){call.result=await capture('application' in validation.data?validation.data.application:undefined);verificationRequired=false}
          else if(name==='computer_run'){
           verificationRequired=true;await closeComputer();computerFrame('delegated',name)
           if(!toolBridge.computerRun)throw Error('computer_executor_unavailable')
           computerInputStarted=true
           const result=await toolBridge.computerRun(state.last_user,call,signal)
           signal.throwIfAborted()
           call.result={result,...await capture()}
           verificationRequired=false
          }else{
           verificationRequired=true
           await (await getComputer()).action(name,call.arguments);coordinateObservationRequired=true
           call.result={status:'completed',verified:false};computerFrame('active',name)
          }
         }catch(error){
          let code=error instanceof Error?error.message:'action_failed'
          try{await closeComputer()}catch{code='cleanup_unknown'}
          let cause:unknown=error,detail:string|undefined;for(let depth=0;depth<4&&cause instanceof Error;depth++){if(/^native_gui:[a-z_]{1,80}$/u.test(cause.message))detail=cause.message;cause=cause.cause}
          call.result={code,...(detail?{detail}:{}),status:code==='cleanup_unknown'||(signal.aborted&&computerInputStarted)?'outcome_unknown':signal.aborted?'cancelled_before_execution':'failed'}
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
         // Reads inside the project stay free; a read that leaves it needs the same consent as a write.
         const needsApproval=options.approval==='ask'&&(call.name!=='file_read'||await localPathEscapesProject(conversation.build!.project,(validation.data as {path:string}).path).catch(()=>true))
         if(needsApproval&&!await ask(call,signal)){
          call.result={status:'denied',message:'This call was not executed. Wait for new user instructions.'};call.state='completed';state.reason=signal.aborted?'stopped':'approval_denied';await save();return
         }
         signal.throwIfAborted();if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
         state.status='running';call.state='running';call.started_at=new Date().toISOString();await save() // intent must reach disk first
         signal.throwIfAborted();if(!host.localBuildAuthorized(conversation.id))throw Error('local_build_not_authorized')
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
         const plan=await host.publishPlan(conversation.id,conversation.generation,q.data.title,q.data.content,call.id)
         call.result={published:true,id:plan.id,version:plan.version,title:plan.title};call.state='completed';call.finished_at=new Date().toISOString()
        }
        await save()
       }else{
        call.state='running';call.started_at=new Date().toISOString();await save()
        try{call.result=await toolBridge.invoke(state.last_user,call,signal)}catch(error){call.result={status:signal.aborted?'outcome_unknown':'failed',code:error instanceof Error?error.message:'tool_failed'}}
        call.state='completed';call.finished_at=new Date().toISOString();await save()
       }
      }
      if(!wasCompleted&&(call.result as {status?:string}|undefined)?.status==='outcome_unknown'){state.reason='outcome_unknown';if(build&&call.name==='shell_execute'&&(call.result as {cleanup_confirmed?:boolean}).cleanup_confirmed===false){quarantineTaskResources([projectResourceKey(conversation.build!.project)]);release=undefined}}
     }
     // The approval slot is single; a read that must ask therefore runs alone like a write.
     const askingReads=new Set<string>()
     if(build&&options.approval==='ask')for(const call of state.pending_calls)if(call.name==='file_read'&&call.state!=='completed'){
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
      if(state.reason)break
      if(finishedReply!==undefined)break
     }
     if(state.reason){
      for(const call of state.pending_calls)if(call.state==='prepared'){call.result={status:'cancelled_before_execution'};call.state='completed'}
      state.status=state.reason==='outcome_unknown'?'outcome_unknown':'paused';await save();return {assistant:state.reason==='approval_denied'?'操作已拒绝，Build 已暂停。':state.reason==='outcome_unknown'?'操作结果不确定，Build 已暂停。Resume 后会先核实实际状态。':'Build 已暂停。'}
     }
     if(finishedReply!==undefined){for(const call of state.pending_calls)if(call.state!=='completed'){call.result={status:'cancelled_after_finish'};call.state='completed'}state.status='finished';await save();return {assistant:finishedReply,turn_id:randomUUID()}}
     if(state.pending_calls.some(call=>call.state!=='completed')){state.status='paused';state.reason='round_limit';await save();return {assistant:roundLimitReply()}}
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
     if(toolRounds>=turnToolLimit){state.status='paused';state.reason='round_limit';await save();return {assistant:roundLimitReply()}}
     const enabled=computerState(),tools=[...baseTools,...(enabled.enabled?computerTools(enabled.direct):[])]
     const llm=model(),before=state.model,inputs=structuredClone(state.inputs),calls:WorkbenchCall[]=[],turn=randomUUID();let assistant='',completed=false
     try{
      for await(const event of llm.stream({language:options.language,inputs,tools,workspaceContext:enabled.enabled?[workspaceContext,computerUseSkill(enabled.direct)].filter(Boolean).join('\n'):workspaceContext,signal})){
       signal.throwIfAborted();if(version!==runVersion)throw Error('build_stale')
       if(event.kind==='text_delta'){
        assistant+=event.text
        // Keep progress frames compact; the complete final reply is durably paged to the UI.
        const visible=assistant.slice(-4000)+(assistant.length>4000?'…':'')
        options.emit({type:'caption',role:'assistant',text:visible,full_text:visible,turn_id:turn,final:false})
       }
       else if(event.kind==='tool_call'){if(calls.some(call=>call.id===event.call_id))throw Error('duplicate_tool_call');calls.push({id:event.call_id,name:event.name,arguments:structuredClone(event.arguments),state:'prepared',created_at:new Date().toISOString(),...(context?.user_message_id?{message_id:context.user_message_id}:{})})}
       else if(event.kind==='response_completed')completed=true
       else if(event.kind==='response_failed'){
        const code=/^[a-z_]{1,64}$/u.test(event.code)?event.code:'unknown',detail=event.detail&&/^[a-z_]{1,64}$/u.test(event.detail)?event.detail:undefined,count=event.tool_call_count
        state.model_failure={code,...(detail?{detail}:{}),...(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=128?{tool_call_count:count}:{})}
        throw Error('model_'+code+(detail?'_'+detail:''))
       }
      }
      if(!completed)throw Error('model_response_incomplete')
      if(!llm.checkpoint)throw Error('model_checkpoint_unsupported')
      state.model=llm.checkpoint();state.inputs=[]
      if(!calls.length&&assistant.length>16000)await store.saveReply(conversation.id,conversation.generation,turn,assistant)
      state.assistant=assistant.slice(0,16000)
      for(const call of calls){const prior=state.calls.find(item=>item.id===call.id);if(prior){if(prior.name!==call.name||JSON.stringify(prior.arguments)!==JSON.stringify(call.arguments))throw Error('tool_call_id_conflict');state.pending_calls.push(prior)}else {state.calls.push(call);state.pending_calls.push(call)}}
      await save()
     }catch(error){state.model=before;await session?.close();session=undefined;if(error instanceof Error&&'code' in error&&typeof error.code==='string'){const detail='detail' in error&&typeof error.detail==='string'&&/^[a-z_]{1,64}$/u.test(error.detail)?'_'+error.detail:'';throw Error('model_'+error.code+detail,{cause:error})}throw error}
     if(!calls.length){state.status='completed';state.reason=null;await save();return {assistant,turn_id:turn}}
    }
   }catch(error){
    for(const call of state.pending_calls)if(call.state!=='completed'){
     call.result={status:call.state==='running'?'outcome_unknown':'cancelled_before_execution'};call.state='completed';delete call.approval_id
    }
    approval=undefined
    const reason=error instanceof Error?error.message:'build_failed',modelInterrupted=build&&reason.startsWith('model_')
    if(/^model_[a-z_]{1,96}$/u.test(reason))options.onDiagnostic?.('[workbench-diagnostic] '+JSON.stringify({mode:build?'build':'plan',conversation_id:conversation.id,generation:conversation.generation,reason,...(state.model_failure?{model_failure:state.model_failure}:{})}))
    if(reason==='cleanup_unknown')verificationRequired=true
    state.status=reason==='cleanup_unknown'?'outcome_unknown':signal.aborted||modelInterrupted?'paused':'failed';state.reason=signal.aborted?'stopped':reason;await save();if(signal.aborted)return {assistant:'Build 已暂停。'}
    if(modelInterrupted){
     const label=options.language==='en'?({model_timeout:'The model stopped returning data',model_overflow:'The model response exceeded the stream capacity',model_http:'The model service returned an error',model_network:'The model connection was interrupted'} as Record<string,string>)[reason]??'The model response was interrupted':({model_timeout:'模型等待数据超时',model_overflow:'模型回复超出流容量限制',model_http:'模型服务返回错误',model_network:'模型连接中断'} as Record<string,string>)[reason]??'模型回复中断'
     return {assistant:options.language==='en'?`Build paused: ${label} (${reason}). Click Resume to continue. Completed operations will not be replayed.`:`Build 已暂停：${label}（${reason}）。点击 Resume 继续，已完成的操作不会重放。`}
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
  try{return await operation}finally{if(active===operation)active=undefined}
 }
 return {
  runTurn:run,canSwitch:()=>!active,
  stopBuild:async()=>{controller?.abort();approval?.resolve(false);await active},
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
