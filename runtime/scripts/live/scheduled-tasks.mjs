/** Real production composition; isolated synthetic App records, no personal profile. */
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'

export function classifyScenario(row){
 if(row.blocked)return 'blocked'
 if(['direct_tick','virtual_clock','mock'].includes(row.trigger_mode))return 'deterministic'
 if(row.trigger_mode!=='wall_clock_timer'||row.profile_kind!=='isolated_synthetic'||!row.source||!row.provider||!row.model_calls||!row.completed||!row.schedule_id||!row.run_id||!row.task_id||!Array.isArray(row.evidence)||!row.evidence.length||!/^[a-f0-9]{40}$/u.test(row.build_commit??''))return 'failed'
 const scheduled=Date.parse(row.scheduled_at),started=Date.parse(row.started_at)
 return Number.isFinite(scheduled)&&Number.isFinite(started)&&started>=scheduled?'passed':'failed'
}
export async function runScheduledLive(output){
 const directory=resolve(output);await mkdir(directory,{recursive:true,mode:0o700})
 if(process.env.NOVA_LIVE_ENV_FILE)process.loadEnvFile(process.env.NOVA_LIVE_ENV_FILE)
 const report={version:1,module:'scheduled-tasks',synthetic:true,layer:'end-to-end',status:'running',profile_kind:'isolated_synthetic',source:'Only synthetic App goals and todos',started_at:new Date().toISOString(),build_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',checks:[],coverage:['production host/provider/factory','wall-clock timer','latest App data','Agent creation','two presets','main chat follow-up','result adoption','restart after claim'],scenarios:[]}
 const reportFile=process.env.NOVA_LIVE_MODULE_REPORT??join(directory,'report.json')
 const persist=()=>writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600})
 let composition,stop,cleanup=new Set(),modelCalls=0,observe=async()=>{}
 const pass=name=>{report.checks.push(name);console.log('PASS',name)}
 const wait=async(check,label,timeout=180000)=>{const until=Date.now()+timeout;let nextLog=0;while(Date.now()<until){const value=await check();if(value)return value;if(Date.now()>nextLog){console.log('WAIT',label);await observe();nextLog=Date.now()+20000}await new Promise(r=>setTimeout(r,1000))}throw Error('timeout_'+label)}
 try{
  const {loadSettings,resolveModelApiKey}=await import('../../dist/src/config/config.js')
  const {requireSelectedCascadedLlmConfig}=await import('../../dist/src/config/cascaded-realtime-config.js')
  const environment={...process.env,PIPELINE_MODE:'cascaded',MEMORY_CONNECTION:'disabled',REALTIME_TELEMETRY:join(directory,'telemetry.jsonl'),BLACKBOARD_PATH:join(directory,'blackboard.sqlite'),CAPABILITIES_CONFIG:join(directory,'capabilities.json'),CODEX_WORKSPACE:directory,CODEX_MANAGED_ROOT:directory,CODEX_PROJECT_STATE_ROOT:directory,COMPOSIO_API_KEY:'',PHONE_ENABLED:'false'}
  await writeFile(environment.CAPABILITIES_CONFIG,JSON.stringify({version:1,modules:{search:{enabled:false},coding:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}}))
  let settings,selected
  try{settings=loadSettings(environment,true);selected=requireSelectedCascadedLlmConfig(settings);if(!resolveModelApiKey(settings))throw Error('missing_support_model')}catch(error){report.status='blocked';report.blocker='configured_primary_and_support_models_required';report.configuration_error={name:error.name,message:Object.entries(environment).filter(([key,value])=>/KEY|TOKEN|SECRET/u.test(key)&&value).reduce((message,[,value])=>message.replaceAll(value,'[redacted]'),String(error.message)),fields:error.issues?.map(issue=>issue.path.join('.'))};return report}
  report.provider=selected.provider;report.model=selected.config.model
  const {buildProductionComposition}=await import('../../dist/src/composition/production-composition.js')
  let host
  const start=async()=>{
   stop=new AbortController()
   composition=await buildProductionComposition({token:randomUUID().replaceAll('-',''),stop,ownership:{own:fn=>{cleanup.add(fn);return()=>cleanup.delete(fn)}},onDiagnostic:line=>{void writeFile(join(directory,'diagnostics.log'),line+'\n',{flag:'a',mode:0o600})},environment})
   const gateway=composition.realtime.core.gateway,complete=gateway.complete.bind(gateway)
   gateway.complete=async request=>{modelCalls++;return complete(request)}
   await composition.realtime.start();host=composition.realtime.personalAgent
  }
  const restart=async()=>{
   stop.abort();await composition.realtime.stop();for(const close of [...cleanup].reverse())await Promise.resolve(close());cleanup.clear()
   await start()
  }
  await start()
  observe=async()=>writeFile(join(directory,'progress.json'),JSON.stringify(host.tasks.list().map(task=>({id:task.id,phase:task.phase,pending_delivery:task.pending_delivery,waiting_reason:task.waiting_reason,evidence:host.tasks.evidence(task.id).map(row=>row.kind),delivery:host.conversationService(task.conversation_id)?.deliveryState()})),null,2),{mode:0o600})
  const command=async(method,params,id=randomUUID())=>{const ack=await host.command({type:'personal.command',request_id:id,method,params},{client_id:'isolated-live-client'});if(!ack.ok)throw Error('command_'+method+'_'+JSON.stringify(ack.error));return ack.data}
  const goal=await host.life.mutate({op:'create',kind:'goal',title:'合成测试：青瓷项目',success_criteria:'完成可核实的验收说明'},'live-goal')
  const todo=await host.life.mutate({op:'create',kind:'todo',title:'旧版安排',goal_id:goal.id},'live-todo')
  const {schedulePresets}=await import('../../dist/src/personal-agent/schedule-presets.js')
  const presets=schedulePresets('UTC'),slot=new Date(Math.ceil((Date.now()+65000)/60000)*60000),rule={kind:'once',timezone:'UTC',date:slot.toISOString().slice(0,10),time:slot.toISOString().slice(11,16)}
  const input={...presets[0].input,rule,context:{todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false}}
  const schedule=await command('schedules.create',{input},'live-create')
  const replay=await command('schedules.create',{input},'live-create');if(replay.id!==schedule.id)throw Error('duplicate_schedule')
  await host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,title:'先处理蓝色风铃7319验收风险',note:'这是创建定时规则后才记录的新事实。验收资料尚缺一份，因此等待补齐。',status:'waiting'},'live-update')
  pass('shared_api_idempotency_and_updated_app_data')
  await persist()
  const run=await wait(()=>host.schedules.history(schedule.id,null,20).items.find(row=>row.slot?.scheduled_at===slot.toISOString()),'wall_clock_claim',190000)
  const done=await wait(()=>{const current=host.schedules.getRun(run.run_id);return current.terminal_summary?.published?current:null},'verified_result',240000)
  const task=host.tasks.get(done.task_id),evidence=host.tasks.evidence(task.id)
  if(!evidence.some(row=>row.kind==='context'&&row.content.includes('7319')))throw Error('fresh_context_missing')
  if(!done.terminal_summary.text.includes('7319'))throw Error('fresh_fact_not_in_result')
  const scenario={scenario:'daily_priorities_wall_clock',trigger_mode:'wall_clock_timer',profile_kind:report.profile_kind,source:report.source,provider:report.provider,model_calls:modelCalls,build_commit:report.build_commit,schedule_id:schedule.id,run_id:run.run_id,task_id:task.id,scheduled_at:run.slot.scheduled_at,started_at:run.claimed_at,evidence:evidence.map(row=>row.ref),completed:task.phase==='completed'}
  scenario.status=classifyScenario(scenario);report.scenarios.push(scenario);if(scenario.status!=='passed')throw Error('live_contract_failed')
  await writeFile(join(directory,'daily-result.json'),JSON.stringify({run:done,task,evidence},null,2),{mode:0o600});pass('real_timer_model_task_fresh_evidence_and_delivery')
  await host.publishScheduledResult(run.run_id)
  if(host.snapshot().feed.filter(row=>row.id==='scheduled-result:'+run.run_id).length!==1)throw Error('duplicate_delivery')
  const topic=await command('schedules.open_result',{run_id:run.run_id});if(topic.id!=='chat:main')throw Error('result_not_main_chat')
  const body=host.conversationSnapshot().messages.filter(row=>row.id==='scheduled-result:'+run.run_id);if(body.length!==1||!body[0].text.includes('7319'))throw Error('main_body_missing')
  await host.submitConversationText('chat:main','请解释刚才报告里蓝色风铃7319事项的阻塞，只依据刚才的报告，不要创建或修改任何任务。','main-follow-up');await host.waitConversation('chat:main')
  const reply=host.conversationSnapshot().messages.filter(row=>row.role==='assistant'&&row.reply_to).at(-1);if(!reply?.text.includes('7319')||!reply.text.includes('资料'))throw Error('main_follow_up_missing')
  pass('main_chat_body_and_real_model_follow_up')
  const adoption={run_id:run.run_id,kind:'todo',title:'补齐青瓷验收资料',note:'用户主动保存的建议',goal_id:goal.id,goal_version:goal.version}
  const adopted=await command('schedules.adopt_result',adoption,'live-adopt'),adoptAgain=await command('schedules.adopt_result',adoption,'live-adopt');if(adopted.id!==adoptAgain.id)throw Error('duplicate_adoption')
  pass('single_delivery_main_discussion_and_user_adoption')
  // Management never impersonates a scheduled occurrence. The following cases are identified separately.
  const weekly=await command('schedules.create',{input:{...presets[1].input,context:input.context}},'weekly-create')
  const paused=await command('schedules.pause',{id:weekly.id,expected_revision:weekly.revision})
  const resumed=await command('schedules.resume',{id:weekly.id,expected_revision:paused.revision})
  const updated=await command('schedules.update',{id:weekly.id,expected_revision:resumed.revision,input:{...presets[1].input,context:input.context,title:'青瓷项目周度整理'}})
  // Persist an admitted run, then restart before prepare. This is a real store/restart boundary, not a synthetic clock.
  const weeklyRun=await host.schedules.runNow('weekly-run',weekly.id,updated.revision)
  if(weeklyRun.stage!=='claimed')throw Error('restart_gap_not_observed')
  await restart()
  if(host.tasks.list().filter(row=>row.trigger?.run_id===run.run_id).length!==1||host.snapshot().feed.filter(row=>row.id==='scheduled-result:'+run.run_id).length!==1)throw Error('restart_duplicate_delivery')
  pass('production_restart_after_claim_and_prior_delivery')
  const weeklyDone=await wait(()=>{const row=host.schedules.getRun(weeklyRun.run_id);return row.terminal_summary?.published?row:null},'weekly_result',180000)
  if(host.tasks.get(weeklyDone.task_id).phase!=='completed')throw Error('weekly_not_completed')
  await writeFile(join(directory,'weekly-result.json'),JSON.stringify({run:weeklyDone,evidence:host.tasks.evidence(weeklyDone.task_id)},null,2),{mode:0o600});pass('weekly_preset_real_agent_and_pause_resume_edit')
  await command('conversations.create',{title:'定时任务制定验收'})
  const conversationId=host.conversationSnapshot().selected_id
  await host.submitConversationText(conversationId,'帮我制定一个每日总结事项的定时 Agent 任务，具体几点还没想好，请先问我时间。','agent-clarify')
  await wait(()=>host.conversationSnapshot().messages.some(row=>row.reply_to&&row.role==='assistant'),'agent_clarification')
  if(host.schedules.list().length!==2)throw Error('agent_created_without_time')
  await host.submitConversationText(conversationId,'每天 09:00，时区 Asia/Shanghai。任务叫每日事项检查，只读取 App 事项，输出最多三项优先事项，缺少信息时明确说明。请现在创建这个定时任务。','agent-confirm')
  const agentSchedule=await wait(()=>host.schedules.list().find(row=>row.id!==schedule.id&&row.id!==weekly.id),'agent_creation')
  if(agentSchedule.authority.source!=='user_turn'||agentSchedule.rule.time!=='09:00'||agentSchedule.rule.timezone!=='Asia/Shanghai')throw Error('agent_schedule_contract')
  pass('real_agent_clarifies_then_creates_shared_schedule')
  const {runScheduledCrashRecovery}=await import('./scheduled-recovery.mjs')
  report.crash_recovery=await runScheduledCrashRecovery(join(directory,'crash-recovery'),environment);pass('real_process_kill_in_flight_recovers_without_reexecution')
  report.status='passed'
 }catch(error){report.status='failed';report.failure=error instanceof Error?error.message:'unknown_failure';console.error('FAIL',report.failure)}finally{
  stop?.abort();if(composition)await composition.realtime.stop().catch(()=>{});for(const close of [...cleanup].reverse())await Promise.resolve(close()).catch(()=>{})
  report.model_calls=modelCalls;report.finished_at=new Date().toISOString();await persist();console.log('Report:',reportFile)
 }
 return report
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const index=process.argv.indexOf('--output'),output=index>=0?process.argv[index+1]:process.env.NOVA_LIVE_MODULE_REPORT?process.env.NOVA_LIVE_MODULE_REPORT+'.data':`/tmp/nova-scheduled-live-${Date.now()}`
 const report=await runScheduledLive(output);process.exitCode=report.status==='passed'?0:report.status==='blocked'?2:1
}
