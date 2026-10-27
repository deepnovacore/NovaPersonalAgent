import {mountWorkspaceBar} from './workspace-bar.mjs'
import {t} from './locale.mjs'
import {renderMarkdown} from './markdown.mjs'
import {iconNode,withIcon} from './icons.mjs'

const folderName=path=>String(path??'').split(/[\\/]+/).filter(Boolean).at(-1)??''
/** Why a Build is paused, in words the user can act on. Unknown codes stay hidden rather than leaking a raw identifier. */
const BUILD_REASONS=Object.freeze({
 model_timeout:'模型等待数据超时',model_overflow:'模型回复超出流容量限制',model_network:'模型连接中断',round_limit:'已达到本次工具调用上限',
 restart_requires_resume:'已暂停，点击继续恢复任务',approval_denied:'你拒绝了一次操作，补充新的要求后继续',
 cleanup_unknown:'上一步的清理结果不确定，请核实后继续',outcome_unknown:'上一步的结果不确定，请核实后继续',new_user_input_received:'收到新消息，已暂停当前步骤',
})

/** Bounded snapshots carry only status. Full plans and logs are fetched in small pages. */
export function mountWorkbenchAgent(parent,{c,el,run,api,planHost}){
 const root=el('section',undefined,'workbench-agent'),bar=el('div',undefined,'workbench-mode-bar');parent.append(root);root.append(bar)
 const info=el('div',undefined,'workbench-build-info'),status=el('span','','workbench-build-status'),project=el('span','','workbench-build-project'),reason=el('span','','workbench-build-reason'),buildActions=el('div',undefined,'workbench-build-actions')
 status.setAttribute('role','status');info.append(status,project,reason);bar.append(info,buildActions)
 const stop=el('button',t('停止')),resume=el('button',t('继续')),details=el('button',t('执行记录'));for(const [button,icon] of [[stop,'stop'],[resume,'play'],[details,'list']]){button.type='button';withIcon(button,icon);buildActions.append(button)}
 stop.addEventListener('click',()=>run(()=>c.command('build.stop',{id:c.selectedId})));resume.addEventListener('click',()=>run(()=>c.command('build.resume',{id:c.selectedId})))
 const log=el('pre',undefined,'workbench-tool-log');log.hidden=true;root.append(log)
 details.addEventListener('click',()=>run(async()=>{
  log.hidden=!log.hidden;if(log.hidden)return
  const id=c.selectedId;let offset=0,text='';do{const page=await c.command('build.details',{id,offset});if(id!==c.selectedId)return;text+=page.text;offset=page.next_offset}while(offset!==null);log.textContent=text
 }))
 const approval=el('section',undefined,'workbench-local-approval');approval.hidden=true;root.append(approval)
 const approvalTitle=el('h3',t('本地工具待确认')),preview=el('pre'),approve=el('button',t('允许本次')),deny=el('button',t('拒绝')),always=el('button',t('始终允许'));approve.type=deny.type=always.type='button';always.hidden=true;deny.className='ghost';approve.className='soft'
 const approvalHead=el('div',undefined,'workbench-approval-head'),approvalIcon=iconNode('shield');if(approvalIcon)approvalHead.append(approvalIcon);approvalHead.append(approvalTitle);const approvalActions=el('div',undefined,'workbench-approval-actions');approvalActions.append(deny,always,approve);approval.append(approvalHead,preview,approvalActions)
 let loadedApproval=null,loadingApproval=null
 async function loadApproval(pending,id){
  if(loadingApproval===pending.id||loadedApproval===pending.id)return
  if(pending.name==='computer_connect'){
   let app;try{app=JSON.parse(pending.preview)?.params?.application}catch{}
   if(app?.name){preview.textContent=t('允许 Nova 操作 {0}？',app.name);approvalTitle.textContent=t('应用控制授权');always.hidden=false;approval.setAttribute('data-kind','app');loadedApproval=pending.id;approve.disabled=always.disabled=!c.connected;return}
  }
  always.hidden=true;approval.setAttribute('data-kind','tool');approvalTitle.textContent=t('本地工具待确认')
  loadingApproval=pending.id
  try {
   let offset=0,text=''
   do {const page=await c.command('build.details',{id,call_id:pending.call_id,offset});if(c.selectedId!==id||c.selectedConversation?.build?.approval?.id!==pending.id)return;text+=page.text;offset=page.next_offset}while(offset!==null)
   preview.textContent=text;loadedApproval=pending.id
  } finally {if(loadingApproval===pending.id)loadingApproval=null;approve.disabled=loadedApproval!==c.selectedConversation?.build?.approval?.id||!c.connected}
 }
 for(const [button,value] of [[approve,true],[always,true],[deny,false]])button.addEventListener('click',()=>run(async()=>{const pending=c.selectedConversation?.build?.approval;if(pending)await c.command('build.approve',{id:c.selectedId,approval_id:pending.id,approved:value,...(button===always?{always:true}:{})})}))
 const planCard=el('section',undefined,'workbench-plan');planCard.hidden=true;(planHost??root).append(planCard)
 const planTitle=el('h3'),body=el('div',undefined,'workbench-plan-body'),edit=el('textarea');edit.hidden=true;edit.setAttribute('aria-label',t('计划内容'));edit.maxLength=131072
 const actions=el('div',undefined,'workbench-plan-actions'),editButton=el('button',t('修改计划')),save=el('button',t('保存计划')),start=el('button',t('开始 Build'))
 // One runner choice: the built-in Build (synchronous) or a local executor (asynchronous). The workspace follows the runner.
 const runner=el('select');runner.setAttribute('aria-label',t('执行器'));const runnerNote=el('p','','hint workbench-runner-note')
 const directories=el('select');directories.setAttribute('aria-label',t('工作区'));directories.append(Object.assign(el('option',t('选择工作区')),{value:''}))
 const workspace=mountWorkspaceBar(planCard,{c,el,button:(label,click,parent)=>{const node=el('button',label);node.type='button';node.addEventListener('click',click);parent.append(node);return node},run,api:api?.personal,visible:()=>!runner.value&&localBuildSupported,onChange:()=>update()})
 const runnerLabel=el('small',t('执行器'),'workbench-field-label'),directoryLabel=el('small',t('工作区'),'workbench-field-label')
 planCard.append(planTitle,body,edit,runnerLabel,runner,runnerNote,directoryLabel,directories,workspace.element,actions);for(const button of [editButton,save,start]){button.type='button';actions.append(button)}save.hidden=true;start.className='soft'
 const retry=el('button',t('重试'));retry.type='button';retry.hidden=true;planCard.append(retry)
 let planKey='',failedKey='',plan=null,loading=false,sequence=0,lastSelected=null,busy=false,localBuildSupported=false,preselected='',registered=[]
 /** The workspace list follows the runner: Build has its own managed picker; Codex uses registered directories, other executors none. */
 function fillDirectories(){
  const executor=runner.value,previous=directories.value,options=[{value:'',label:t('选择工作区')}],add=(value,label)=>{if(value&&!options.some(option=>option.value===value))options.push({value,label})}
  const listed=()=>{for(const target of registered)add(target.directory,target.project)}
  if(executor==='codex')listed()
  directories.replaceChildren(...options.map(option=>Object.assign(el('option',option.label),{value:option.value})))
  directories.value=options.some(option=>option.value===previous)?previous:''
 }
 retry.addEventListener('click',()=>{failedKey='';retry.hidden=true;update()})
 const reference=()=>{const item=c.selectedConversation;return item?.plan?{id:item.id,plan_id:item.plan.id,version:item.plan.version}:null}
 async function load(){
  const ref=reference();if(!ref)return;const key=JSON.stringify(ref);if(planKey===key||failedKey===key||loading)return;loading=true;const token=++sequence
  try{
   let offset=0,content='',page;do{page=await c.command('plans.get',{plan_id:ref.plan_id,version:ref.version,offset});content+=page.content;offset=page.next_offset}while(offset!==null)
   if(token!==sequence||JSON.stringify(reference())!==key)return
   plan={...page,content};planKey=key;body.replaceChildren(renderMarkdown(content));planTitle.textContent=t('计划 · {0} · v{1}',plan.title,plan.version);edit.value=content;edit.hidden=true;body.hidden=false;save.hidden=true
   const targets=await c.command('conversations.targets',{});if(token!==sequence)return
   localBuildSupported=targets.local_build_supported===true
   registered=(targets.targets??[]).filter(target=>target.directory)
   const previous=runner.value;runner.replaceChildren();if(localBuildSupported)runner.append(Object.assign(el('option',t('Nova 内置 · Build')),{value:''}));for(const name of targets.executors??[])runner.append(Object.assign(el('option',name),{value:name}))
   runner.value=[...runner.options].some(option=>option.value===previous)?previous:runner.options[0]?.value??''
   // The composer's Delegate mode pre-selects the first executor, once per plan.
   if(preselected!==key){preselected=key;if(c.state?.(c.selectedId)?.execution==='delegate'&&(targets.executors??[]).length)runner.value=targets.executors[0]}
   fillDirectories()
  }catch(error){if(token===sequence){failedKey=key;retry.hidden=false}throw error}
  finally{if(token===sequence){loading=false;update()}}
 }
 directories.addEventListener('change',update);runner.addEventListener('change',()=>{fillDirectories();update()})
 editButton.addEventListener('click',()=>{edit.hidden=!edit.hidden;body.hidden=!edit.hidden;save.hidden=edit.hidden;if(!edit.hidden)edit.focus()})
 save.addEventListener('click',()=>run(async()=>{
  const ref=reference();if(!ref||!edit.value.trim())return;busy=true;update()
  try{const text=edit.value;for(let offset=0;offset<text.length;offset+=2000)await c.command('plans.edit',{id:ref.id,plan_id:ref.plan_id,expected_version:ref.version,offset,text:text.slice(offset,offset+2000),final:offset+2000>=text.length})}finally{busy=false;update()}
 }))
 start.addEventListener('click',()=>run(async()=>{const ref=reference(),executor=runner.value;if(!ref||busy)return;busy=true;update();try{if(executor)await c.command('plans.delegate',{...ref,executor,...(executor==='codex'&&directories.value?{project:directories.value}:{})});else await c.command('build.start',{...ref,...workspace.value()})}finally{busy=false;update()}}))
 function update(){
  const ready=c.connected&&c.presentationReady!==false,item=c.selectedConversation,build=item?.build,active=['running','awaiting_approval'].includes(build?.status),voiceActive=Boolean(c.voiceId&&c.voiceId===c.selectedId)
  root.hidden=!item
  status.textContent=build?t('Build · {0}',t(({running:'执行中',awaiting_approval:'待确认',paused:'已暂停',completed:'已完成',finished:'已锁定',failed:'失败',outcome_unknown:'结果不确定',idle:'就绪'})[build.status]??build.status)):''
  status.setAttribute('data-state',build?.status??'')
  // The path is one ellipsized line; the full value stays reachable on hover.
  project.textContent=folderName(build?.project);project.title=folderName(build?.project);project.hidden=!project.textContent
  reason.textContent=build?.reason&&build.reason!=='stopped'&&BUILD_REASONS[build.reason]?t(BUILD_REASONS[build.reason]):'';reason.hidden=!reason.textContent;reason.title=reason.textContent
  stop.hidden=!build||!active;resume.hidden=!build||active||['completed','finished'].includes(build.status);details.hidden=!build
  stop.disabled=resume.disabled=details.disabled=!ready
  always.disabled=!ready||loadedApproval!==build?.approval?.id;approval.hidden=!build?.approval;deny.disabled=!ready;approve.disabled=!ready||loadedApproval!==build?.approval?.id
  if(ready&&build?.approval&&loadedApproval!==build.approval.id){if(loadingApproval!==build.approval.id)preview.textContent=build.approval.name+'\n'+build.approval.preview;void loadApproval(build.approval,item.id).catch(error=>{c.error=error.message;c.changed()})}
  const hasPlan=item?.mode==='plan'&&item.plan;planCard.hidden=!hasPlan
  // The mode lives in the composer; this strip appears only for a Build session or a published plan.
  bar.hidden=!build;if(!build&&(planHost||!hasPlan))root.hidden=true
  if(lastSelected!==c.selectedId){lastSelected=c.selectedId;log.hidden=true;sequence++;loading=false;planKey='';failedKey='';plan=null;retry.hidden=true;body.replaceChildren()}
  if(ready&&hasPlan)void load().catch(error=>{c.error=error.message;c.changed()})
  const delegating=Boolean(runner.value)
  runner.disabled=busy||!ready;directories.hidden=runner.value!=='codex';directoryLabel.hidden=directories.hidden;directories.disabled=busy||!ready;workspace.update()
  start.textContent=delegating?t('交给 {0}',runner.value):t('开始 Build')
  runnerNote.textContent=delegating?t('异步执行：{0} 在后台完成，进度在悬浮窗查看，对话可以继续。',runner.value):t('同步执行：在选定工作区读写文件、运行命令，完成前这段对话保持占用。')
  start.disabled=busy||!plan||!ready||JSON.stringify(reference())!==planKey||(!delegating&&!localBuildSupported)||voiceActive
  start.title=voiceActive?t('请先结束语音'):''
  save.disabled=busy||!ready;editButton.disabled=busy||!plan;retry.disabled=!ready
  planCard.setAttribute('data-execution',delegating?'delegate':'build')
 }
 return {update,element:root}
}
