/** Explicit live acceptance: genuine production conversation factory, synthetic E2E clients. */
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,realpath,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'

const arg=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)
const build=resolve(arg('build-dir')??join(import.meta.dirname,'../../dist'))
const output=resolve(arg('output')??join(tmpdir(),`nova-space-live-${Date.now()}`))
await mkdir(output,{recursive:true,mode:0o700})
const load=path=>import(pathToFileURL(join(build,path)).href)
const report={v:1,run_id:randomUUID(),synthetic:true,status:'running',started_at:new Date().toISOString(),model_owner:'Host',limits:{source_timeout_ms:600000,source_model_requests:20},checks:[],model_requests:[],usage:[]}
const directory=await realpath(await mkdtemp(join(tmpdir(),'nova-space-live-')))
let host,memory,relay,phoneClient,hostClient,stopPhone,activeKey,cursor=0,stopOnPreview=true,firstPreview=false
const nativeFetch=globalThis.fetch
// Managed execution environments expose an outbound proxy; preserve normal TLS verification.
let dispatcher
if(process.env.HTTPS_PROXY||process.env.https_proxy){const {EnvHttpProxyAgent}=await import('undici');dispatcher=new EnvHttpProxyAgent()}
const secretValues=Object.entries(process.env).filter(([name,value])=>/KEY|TOKEN|SECRET/u.test(name)&&value).map(([,value])=>value)
const redact=value=>secretValues.reduce((result,secret)=>result.replaceAll(secret,'[redacted]'),String(value)).slice(0,1000)
const checkpoint=()=>writeFile(join(output,'progress.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
const wait=async(predicate,label,timeout=180000)=>{await checkpoint();const deadline=Date.now()+timeout;while(!await predicate()){if(report.model_requests.some(row=>row.http_status>=400||row.error))throw Error('provider_request_failed');if(Date.now()>deadline)throw Error(`timeout_${label}`);await new Promise(resolve=>setTimeout(resolve,50))}}
try{
 const {loadRelayFixture}=await load('test/helpers/relay-fixture.js')
 const {RelayServer,RelayClient,crypto}=await loadRelayFixture()
 const {loadSettings}=await load('src/config/config.js')
 const {requireSelectedCascadedLlmConfig}=await load('src/config/cascaded-realtime-config.js')
 const {parseCapabilityRegistry}=await load('src/config/capability-registry.js')
 const {PersonalAgentHost}=await load('src/personal-agent/host.js')
 const {conversationRuntimeFactory}=await load('src/personal-agent/conversation-runtime.js')
 const {SuggestionPool}=await load('src/core/suggestions.js')
 const {SpaceHostController}=await load('src/space-host/config.js')
 const {MemoryLedgerClient}=await load('src/memory-ledger/store-client.js')
 const {SubstrateMemoryResource}=await load('src/memory-substrate/resource.js')
 const {OpenAIModelGateway}=await load('src/model/model-gateway.js')
 const {RealClock}=await load('src/core/clock.js')
 const baseUrl=process.env.NOVA_AUDIO_AGENT_MODEL_BASE_URL??process.env.MODEL_BASE_URL??'https://dashscope.aliyuncs.com/compatible-mode/v1'
 const apiKey=process.env.MODEL_API_KEY??process.env.DASHSCOPE_API_KEY
 assert.ok(apiKey,'configured_model_credential_required')
 const model=process.env.NOVA_AUDIO_AGENT_FAST_MODEL??process.env.CASCADE_LLM_MODEL??process.env.FAST_MODEL??'qwen-plus'
 const settings=loadSettings({PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'self-hosted',CASCADE_LLM_MODEL:model,SELF_HOSTED_LLM_BASE_URL:baseUrl,SELF_HOSTED_LLM_API_KEY:apiKey,MODEL_BASE_URL:baseUrl,MODEL_API_KEY:apiKey,FAST_MODEL:model,SUPPORT_MODEL:model,COMPRESSOR_MODEL:model,MEMORY_CONNECTION:'disabled',BLACKBOARD_PATH:join(directory,'blackboard.sqlite'),EXECUTORS:'',CAMERA_MODULE_ENABLED:'false',MEMORY_PRERECALL_ENABLED:'false'},true)
 const selected=requireSelectedCascadedLlmConfig(settings)
 report.provider=selected.provider;report.model=selected.config.model
 report.endpoint=new URL(selected.config.baseUrl).origin
 globalThis.fetch=async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url
  if(url.startsWith(selected.config.baseUrl)){
   const source=report.phase==='source_processing',remaining=source?Date.parse(report.source.started_at)+report.limits.source_timeout_ms-Date.now():180000
   if(remaining<=0||source&&report.model_requests.filter(row=>row.phase==='source_processing').length>=report.limits.source_model_requests)throw Error('live_source_budget_exhausted')
   const row={id:randomUUID(),owner:'Host',phase:report.phase??'chat',started_at:new Date().toISOString()};report.model_requests.push(row)
   try{const response=await nativeFetch(input,{...init,signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(remaining)]),...(dispatcher?{dispatcher}:{})});row.http_status=response.status;row.headers_received_at=new Date().toISOString();if(!response.ok){const body=await response.clone().json().catch(()=>({}));row.provider_error=redact(body.error?.message??body.message??'unknown')}await checkpoint();return response}catch(error){row.error=error.name;row.reason=error.cause?.code??error.code;await checkpoint();throw error}
  }
  return nativeFetch(input,init)
 }
 const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{})
 const bootstrap=randomUUID();relay=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:bootstrap,bootstrapPerMinute:200,requestsPerMinute:5000});const relayUrl=await relay.listen()
 const identity=await crypto.generateDeviceIdentity(),phone=await crypto.generateDeviceIdentity(),space=crypto.spaceId(identity.signingPublicKey)
 activeKey=crypto.generateContentKey()
 const make=identity=>new RelayClient({url:relayUrl,space,device:identity.device,pollIntervalMs:60,reconnectMinMs:30,signChallenge:c=>crypto.signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},identity.signingPrivateKey)})
 hostClient=make(identity);phoneClient=make(phone)
 const record={device:identity.device,signingPublicKey:identity.signingPublicKey,encryptionPublicKey:identity.encryptionPublicKey}
 await hostClient.createSpace({space,host:record,proof:await crypto.signControl({v:1,purpose:'space-create',space,host:record},identity.signingPrivateKey)},bootstrap)
 const usageReporter=usage=>report.usage.push({id:usage.id,service:usage.service,provider:usage.provider,model:usage.model,provider_request_id:usage.providerRequestId,input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,outcome:usage.outcome,feature:usage.feature,conversation_id:usage.conversationId})
 const gateway=new OpenAIModelGateway({baseUrl,apiKey,clock:new RealClock(),onUsage:usageReporter,metrics:{record:row=>{report.source_model_metrics??=[];report.source_model_metrics.push(row)}}})
 memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(directory,'memory.sqlite')),userId:space,gateway,model,sourceProcessingLlm:{baseUrl,apiKey},extractionFingerprint:createHash('sha256').update(baseUrl+'|'+model).digest('hex'),personalMemoryEnabled:false,inputConsent:false,closeClient:true})
 await memory.open({deferBackground:true})
 host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:space,memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 const config={v:1,mode:'host',space,personal_path:host.path,relay_url:relayUrl,epoch:1,identity,content_key:Buffer.from(activeKey).toString('base64url'),members:[]}
 const controller=new SpaceHostController(join(directory,'space.json'),config,host,{crypto,RelayClient});host.setSpaceHost(controller)
 host.setConversationRuntime(conversationRuntimeFactory({settings,capabilities,gateway,blackboard:{path:join(directory,'blackboard.sqlite'),ownerId:space},host,memory:()=>memory,onUsage:usageReporter}),()=>{})
 await host.open({deferBackground:true})
 const invitation=await controller.invitation(),pair={v:1,purpose:'pair-request',invitationId:invitation.id,secret:invitation.secret,device:phone.device,signingPublicKey:phone.signingPublicKey,encryptionPublicKey:phone.encryptionPublicKey,business_versions:[1]}
 const request=await phoneClient.requestPairing({...pair,proof:await crypto.signControl(pair,phone.signingPrivateKey)})
 await controller.confirmPairing(request.id,crypto.deviceFingerprint(phone.signingPublicKey,phone.encryptionPublicKey))
 let installed=false
 const messages=[],previews=[]
 const connect=()=>phoneClient.start({loadCursor:async()=>cursor,saveCursor:async value=>{cursor=value},onMailbox:async envelope=>{
  crypto.verifyEnvelope(envelope,identity.signingPublicKey)
  try{messages.push(await crypto.decryptBody(envelope.body,activeKey))}catch(error){if(installed)throw error;const delivered=await crypto.unwrapContentKey(Buffer.from(envelope.body,'base64').toString(),phone.encryptionPrivateKey);assert.equal(delivered.space,space);assert.equal(delivered.recipient,phone.device);activeKey=Buffer.from(delivered.key,'base64url');installed=true}
 },onStream:envelope=>{crypto.verifyEnvelope(envelope,identity.signingPublicKey);void crypto.decryptBody(envelope.body,activeKey).then(value=>{previews.push(value);if(value.type==='chat.delta'&&!firstPreview){firstPreview=true;report.first_preview_at=new Date().toISOString();if(stopOnPreview){stopPhone?.();stopPhone=undefined;report.client_disconnected_at=new Date().toISOString()}}})},onConnection:()=>{},onError:error=>{report.transport_error_names??=[];report.transport_error_names.push(error.name)}})
 stopPhone=connect();await wait(()=>installed,'key_installation');await wait(()=>relay.live.presence({space,device:phone.device,epoch:1},identity.device),'presence')
 if(!process.argv.includes('--source-only')){
 const opId=`live_${report.run_id}`,intent={v:1,type:'intent',op_id:opId,kind:'chat.send',created_at:Date.now(),expires_at:Date.now()+30000,input:{conversation_id:'chat:main',text:`This is synthetic transport acceptance ${report.run_id}. Do not use any tools or external sources. Write six short numbered sentences about a fictional blue paper boat. Include the word boat. No personal information.`}}
 report.operation_id=opId;report.submitted_at=new Date().toISOString()
 const send=async()=>phoneClient.stream(await crypto.signEnvelope({v:1,space,id:randomUUID(),from:phone.device,to:identity.device,chan:'stream',epoch:1,expiresAt:Date.now()+30000,body:await crypto.encryptBody(intent,activeKey)},phone.signingPrivateKey))
 await send();await send()
 await wait(()=>firstPreview,'real_provider_stream_preview')
 await wait(()=>host.spaceChatMessages().some(message=>message.role==='assistant'&&message.status==='completed'&&message.text.length>40),'host_durable_result')
 report.host_completed_at=new Date().toISOString();assert.equal(stopPhone,undefined)
 stopOnPreview=false;stopPhone=connect()
 await wait(()=>messages.some(message=>message.type==='chat.final'&&message.op_id===opId),'offline_durable_final')
 const final=messages.find(message=>message.type==='chat.final'&&message.op_id===opId)
 assert.match(final.text,/boat|纸船/iu);assert.ok(final.text.length>40)
 const requestsBefore=report.model_requests.length;assert.ok(requestsBefore>0,'genuine_model_http_request_observed')
 await wait(()=>relay.live.presence({space,device:phone.device,epoch:1},identity.device),'reconnected_presence');await send();await new Promise(resolve=>setTimeout(resolve,1500))
 assert.equal(report.model_requests.length,requestsBefore,'duplicate_operation_must_not_call_provider')
 assert.equal(host.conversationSnapshot().messages.filter(message=>message.role==='user'&&message.text===intent.input.text).length,1)
 report.preview_frames=previews.filter(message=>message.type==='chat.delta').length;report.final_characters=final.text.length;report.final_status=final.status;report.model_call_count=report.model_requests.length;report.duplicate_model_calls=0
 report.checks=['actual production conversationRuntimeFactory and provider','signed pairing and encrypted HTTP/WS relay','real provider preview before final','client disconnect during token stream','durable final recovered on client reconnect','in-flight and completed same-operation retries execute model once','one durable user turn','Host owns model HTTP requests; client only crypto and relay']
 assert.equal(report.model_call_count,1,'single_model_execution_expected');assert.ok(report.usage.some(value=>value.service==='llm'&&value.output_tokens>0))
 }
 if(process.argv.includes('--source-input')||process.argv.includes('--source-only')){
  report.phase='source_processing';report.source={checks:[],started_at:new Date().toISOString()};const evidenceSource='synthetic_blue_boat',provider=baseUrl+'|'+model
  const baselineCalls=report.model_requests.length
  const sourceIntent=async(input,label)=>{const op_id=`source_${label}_${report.run_id}`,body={v:1,type:'intent',op_id,kind:'source.input',created_at:Date.now(),input};await phoneClient.send(await crypto.signEnvelope({v:1,space,id:randomUUID(),from:phone.device,to:identity.device,chan:'mailbox',epoch:1,expiresAt:null,body:await crypto.encryptBody(body,activeKey)},phone.signingPrivateKey));await wait(()=>messages.some(message=>message.type==='receipt'&&message.op_id===op_id),'source_receipt_'+label);return messages.find(message=>message.type==='receipt'&&message.op_id===op_id)}
  const fact={kind:'source_fact',source_id:evidenceSource,grant_revision:1,resource_id:'synthetic-message',source_version:'1',text:'I develop software for the fictional Blue Boat 7319 project. I own the test plan and need to finish the synthetic validation checklist tomorrow. I am comparing two paper-folding methods for its origami demonstration. This is synthetic acceptance data, not a real person or project.',relation:'self',occurred_at:new Date().toISOString()}
  let receipt=await sourceIntent(fact,'without_grant');assert.equal(receipt.status,'rejected');assert.equal(report.model_requests.length,baselineCalls);report.source.checks.push('upload without explicit grant rejected before model')
  receipt=await sourceIntent({kind:'grant',source_id:evidenceSource,revision:1,provider,allow_upload:true,allow_processing:false},'upload_only');assert.equal(receipt.status,'accepted')
  receipt=await sourceIntent(fact,'raw');assert.equal(receipt.status,'accepted');const evidenceId=receipt.result.evidence_id;assert.equal((await memory.readEvidence(evidenceId))?.text,fact.text);assert.equal(await memory.canProcessEvidence(evidenceId,'extraction'),false)
  assert.equal(await memory.sourceProcessing({action:'claim'}),null);assert.equal(report.model_requests.length,baselineCalls);report.source.evidence_id=evidenceId;report.source.checks.push('upload-only consent stores canonical raw evidence without model processing')
  receipt=await sourceIntent({kind:'grant',source_id:evidenceSource,revision:2,provider,allow_upload:true,allow_processing:true},'processing_grant');assert.equal(receipt.status,'accepted');assert.equal(await memory.canProcessEvidence(evidenceId,'extraction'),true)
  host.startBackgroundWork();await host.scheduledTaskTick();let lastTick=0
  await wait(async()=>{if(Date.now()-lastTick>1000){lastTick=Date.now();await host.scheduledTaskTick();report.source.runs=[...host.schedules.activeRuns(),...host.schedules.terminalRuns()].filter(run=>run.processing).map(run=>({run_id:run.run_id,task_id:run.task_id,stage:run.stage,outcome:run.terminal_summary?.outcome,model_calls:run.processing.model_calls,tool_calls:run.processing.calls.length}));report.source.host_profile_status=host.snapshot().profile_preparation.status;await checkpoint();if(report.source.runs.some(run=>run.outcome==='failed'))throw Error('source_processing_failed')}return host.schedules.terminalRuns().some(run=>run.processing&&run.terminal_summary?.outcome==='completed')},'real_source_agent_completion',600000)
  await host.sourceProcessingAgent.reload();const products=await memory.sourceProcessing({action:'products',presentation:true}),profile=host.snapshot().profile_preparation
  report.source.runs=host.schedules.terminalRuns().filter(run=>run.processing).map(run=>({run_id:run.run_id,task_id:run.task_id,stage:run.stage,outcome:run.terminal_summary?.outcome,model_calls:run.processing.model_calls,tool_calls:run.processing.calls.length}))
  report.source.host_profile_status=profile.status;report.source.profile={status:profile.status,has_about:!!profile.draft?.about,work_count:profile.draft?.work?.length??0,interest_count:profile.draft?.interests?.length??0,sources:profile.sources?.length??0};report.source.projects=products.projects.length;report.source.suggestions=products.suggestions.length;report.source.ledger_draft=!!products.draft
  assert.ok(products.draft||products.projects.length||products.suggestions.length,'real_source_model_must_publish_derived_output');assert.ok(report.model_requests.some(request=>request.phase==='source_processing'&&request.http_status===200));report.source.checks.push('genuine Host source Agent calls real model and publishes canonical ledger products','Host presentation exposes source-derived output')
  const projection=controller.service.snapshot();assert.equal(Object.hasOwn(projection,'derived_understanding'),false);assert.equal(Object.hasOwn(projection,'profile_preparation'),false);assert.equal(JSON.stringify(projection).includes(fact.text),false);assert.equal(projection.source_processing.status,profile.status);assert.deepEqual(Object.keys(projection.source_processing).sort(),['needs_update','status']);report.source.client_status=projection.source_processing;report.source.client_private_inferences_omitted=true;report.source.client_allowed_summary_cards={timeline:projection.timeline.length,feed:projection.feed.length};report.source.checks.push('Client receives bounded processing status while raw evidence and inferred profile partitions stay private')
  await wait(()=>messages.some(message=>message.type==='snapshot'&&message.snapshot?.source_processing?.status===profile.status),'client_processing_status_over_relay');report.source.checks.push('Client receives actual processing result status through encrypted durable relay snapshot')
  const beforeRevoke=report.model_requests.length;receipt=await sourceIntent({kind:'grant',source_id:evidenceSource,revision:3,provider,allow_upload:true,allow_processing:false},'revoke_processing');assert.equal(receipt.status,'accepted');assert.equal(await memory.canProcessEvidence(evidenceId,'extraction'),false);await host.scheduledTaskTick();assert.equal(report.model_requests.length,beforeRevoke);report.source.checks.push('processing revocation removes model authorization without another model call')
  receipt=await sourceIntent({kind:'grant',source_id:evidenceSource,revision:4,provider,allow_upload:false,allow_processing:false},'revoke_upload');assert.equal(receipt.status,'accepted');assert.equal(await memory.readEvidence(evidenceId),null);receipt=await sourceIntent({...fact,grant_revision:4,source_version:'after-revoke'},'after_revoke');assert.equal(receipt.status,'rejected');report.source.checks.push('upload revocation deletes canonical original and rejects later facts')
  report.source.model_calls=report.model_requests.filter(request=>request.phase==='source_processing').length;report.source.finished_at=new Date().toISOString();report.total_model_requests=report.model_requests.length;report.checks.push(...report.source.checks)
 }
 report.status='passed'
}catch(error){report.status='failed';report.failure={name:error.name,message:redact(error.message)}}finally{
 stopPhone?.();await host?.close().catch(()=>{});await memory?.close().catch(()=>{});phoneClient?.stop();hostClient?.stop();await relay?.close().catch(()=>{});globalThis.fetch=nativeFetch;await dispatcher?.close();await rm(directory,{recursive:true,force:true});report.finished_at=new Date().toISOString();report.duration_ms=Date.parse(report.finished_at)-Date.parse(report.started_at);await checkpoint();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:1
}
