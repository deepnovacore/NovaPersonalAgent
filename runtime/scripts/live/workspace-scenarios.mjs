/** Synthetic roster/history, real frontend tools, coordinator, confirmation and executor. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

export async function runWorkspaceScenarios({assembly,telemetry,send,wait,report,save,getView}) {
  const state=async()=>JSON.parse(await readFile(join(report.runRoot,'codex-projects-v1.json'),'utf8'))
  const active=s=>s.workspaces[s.active_workspace_id]
  const terminals=()=>assembly.runtime.memory.channels.get('codex')?.items.filter(i=>i.outcome!=null)??[]
  const records=()=>telemetry.diagnostics().records
  report.scenarios=[]
  report.context={seededWorkspaces:['贪吃蛇','笔记工具'],active:'贪吃蛇',history:'Only turns submitted by this test; isolated Codex catalog.'}
  async function say(text){
    await wait('frontend_idle',()=>assembly.service.session.providerIdle)
    const before=records().at(-1)?.seq??0
    await send(text)
    await wait('frontend_replied',()=>records().some(i=>i.seq>before&&i.kind==='provider.response_terminal'))
  }
  async function scenario(id,input,check){
    const row={id,input,status:'running',before:await state(),spokenStart:report.spoken.length}
    report.scenarios.push(row);await save()
    try{await check(row);row.after=await state();row.status='passed'}
    catch(error){row.status='failed';row.failure=error.message;row.after=await state();throw error}
    finally{row.spoken=report.spoken.slice(row.spokenStart);await save()}
  }
  async function execute(row,{create=false,name,file,expected,thread}){
    const before=terminals().length,offset=records().at(-1)?.seq??0
    await say(row.input)
    await wait('dispatch',()=>records().filter(i=>i.seq>offset).some(i=>i.kind==='tool.call'&&i.payload.name==='host.dispatch'),10000)
    if(create||active(row.before).display_name!==name){
      await wait('workspace_proposed',()=>getView()?.pending_confirmation,90000)
      const proposal=getView();row.proposalId=proposal.pending_confirmation_id;row.proposalName=proposal.pending_workspace_display_name
      if(name)assert.equal(row.proposalName,name,'proposal must name requested workspace')
      if(create)assert.ok(!Object.values(row.before.workspaces).some(w=>w.display_name===row.proposalName),'independent topic must propose a new workspace')
      await say('确认按这个方案执行。')
      await wait('confirmation_accepted',()=>records().filter(i=>i.seq>offset).some(i=>i.kind==='project_confirmation.commit_admission'&&i.payload.accepted&&i.payload.proposal_id===row.proposalId))
    }
    await wait('execution_completed',()=>terminals().length>before,180000)
    const terminal=terminals().at(-1);row.terminal=terminal
    assert.equal(terminal.outcome,'ok','real Codex execution must succeed')
    const after=await state(),workspace=active(after)
    assert.equal(workspace.display_name,create?row.proposalName:name,'active workspace must be the requested target')
    row.workspace=workspace.canonical_path;row.thread=after.sessions[workspace.active_session_id]?.codex_thread_id
    assert.ok(row.thread,'execution must persist an actual Codex thread')
    if(thread)assert.equal(row.thread,thread,'continuation must resume the same thread')
    row.file=await readFile(join(workspace.canonical_path,file),'utf8')
    assert.equal(row.file.trim(),expected,'independent file readback')
    for(const other of Object.values(after.workspaces))if(other.workspace_id!==workspace.workspace_id){
      await assert.rejects(readFile(join(other.canonical_path,file)),{code:'ENOENT'},'artifact must not leak into another workspace')
    }
  }
  if(process.env.NOVA_LIVE_PROJECT_SCENARIO==='clarification'){
    await scenario('clarify_then_create','网页版就行。这轮先验证启动：只创建 acceptance.html，内容为 <h1>WEEKLY_OK</h1>，然后读回验证。不安装依赖、不启动服务、不做其它文件。',async row=>{
      const before=records().at(-1)?.seq??0
      await say('我要记录我们公司所有人的周报。')
      assert.ok(!records().some(i=>i.seq>before&&i.kind==='tool.call'&&i.payload.name==='host.dispatch'),'ambiguous request must clarify before dispatch')
      row.clarification=report.spoken.slice(row.spokenStart)
      assert.ok(row.clarification.length,'clarification must reach speech')
      await execute(row,{create:true,file:'acceptance.html',expected:'<h1>WEEKLY_OK</h1>'})
    })
    return
  }
  await scenario('switch_without_execution','切换到“笔记工具”工作区。只切换，不执行任何任务。',async row=>{
    const count=terminals().length
    await say(row.input)
    await wait('switch_proposed',()=>getView()?.pending_confirmation,90000)
    assert.equal(getView().pending_workspace_display_name,'笔记工具')
    await say('确认切换，不执行任务。')
    await wait('workspace_switched',()=>getView()?.workspace_display_name==='笔记工具',90000)
    assert.equal(active(await state()).display_name,'笔记工具')
    assert.equal(terminals().length,count)
    assert.equal(Object.keys((await state()).sessions).length,0,'pure switch must not start a session')
  })
  await scenario('current_workspace','在当前“笔记工具”工作区执行：只创建 note.txt，内容为 NOTE_OK，然后读取验证。不联网、不装依赖、不启动服务。现在开始。',row=>execute(row,{name:'笔记工具',file:'note.txt',expected:'NOTE_OK'}))
  const noteThread=report.scenarios.at(-1).thread
  await scenario('new_topic','另外做一个独立的番茄计时器项目。此轮只创建 timer.txt，内容为 TIMER_OK，然后读取验证；不联网、不装依赖、不启动服务。',row=>execute(row,{create:true,file:'timer.txt',expected:'TIMER_OK'}))
  await scenario('switch_back_continue','切回“笔记工具”工作区，继续刚才的会话，只创建 followup.txt，内容为 FOLLOWUP_OK，然后读取验证。不联网、不装依赖、不启动服务。现在执行。',row=>execute(row,{name:'笔记工具',file:'followup.txt',expected:'FOLLOWUP_OK',thread:noteThread}))
}
