import {t} from './locale.mjs'
import {renderMarkdown} from './markdown.mjs'
import {mountComputerUseControl} from './computer-use-control.mjs'
import {iconNode,withIcon} from './icons.mjs'

/** Bounded snapshots carry only status. Full plans and logs are fetched in small pages. */
export function mountWorkbenchAgent(parent,{c,el,run,api}){
 const root=el('section',undefined,'workbench-agent'),bar=el('div',undefined,'workbench-mode-bar');parent.append(root);root.append(bar)
 const info=el('div',undefined,'workbench-build-info'),status=el('span','','workbench-build-status'),project=el('span','','workbench-build-project'),reason=el('span','','workbench-build-reason'),buildActions=el('div',undefined,'workbench-build-actions')
 status.setAttribute('role','status');info.append(status,project,reason);bar.append(info,buildActions)
 const computerUse=mountComputerUseControl(buildActions,root,{c,el,run,api})
 const stop=el('button',t('停止')),resume=el('button','Resume'),details=el('button',t('执行记录'));for(const [button,icon] of [[stop,'stop'],[resume,'play'],[details,'list']]){button.type='button';withIcon(button,icon);buildActions.append(button)}
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
 const planCard=el('section',undefined,'workbench-plan');planCard.hidden=true;root.append(planCard)
 const planTitle=el('h3'),body=el('div',undefined,'workbench-plan-body'),edit=el('textarea');edit.hidden=true;edit.setAttribute('aria-label',t('计划内容'));edit.maxLength=131072
 const actions=el('div',undefined,'workbench-plan-actions'),editButton=el('button',t('修改计划')),save=el('button',t('保存计划')),local=el('button',t('在当前项目 Build')),delegate=el('button',t('交给执行器 Build'));local.hidden=true
 const directories=el('select');directories.hidden=true;directories.setAttribute('aria-label',t('项目目录'));directories.append(Object.assign(el('option',t('选择本地目录…')),{value:''}))
 const pick=el('button',t('选择本地目录…'));pick.type='button';pick.hidden=true
 const executors=el('select');executors.setAttribute('aria-label',t('执行器'))
 planCard.append(planTitle,body,edit,directories,pick,executors,actions);for(const button of [editButton,save,local,delegate]){button.type='button';actions.append(button)}save.hidden=true
 const retry=el('button',t('重试'));retry.type='button';retry.hidden=true;planCard.append(retry)
 let planKey='',failedKey='',plan=null,loading=false,sequence=0,lastSelected=null,busy=false,localBuildSupported=false
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
   const selected=directories.value;directories.replaceChildren(Object.assign(el('option',t('选择本地目录…')),{value:''}));const seen=new Set()
   for(const target of targets.targets??[])if(target.directory&&!seen.has(target.directory)){seen.add(target.directory);directories.append(Object.assign(el('option',target.project+' · '+target.directory),{value:target.directory}))}
   if(selected&&!seen.has(selected))directories.append(Object.assign(el('option',selected),{value:selected}));directories.value=selected
   executors.replaceChildren();for(const name of targets.executors??[])executors.append(Object.assign(el('option',name),{value:name}));delegate.disabled=!executors.value
  }catch(error){if(token===sequence){failedKey=key;retry.hidden=false}throw error}
  finally{if(token===sequence){loading=false;update()}}
 }
 pick.addEventListener('click',()=>run(async()=>{const path=await api.personal.chooseBuildDirectory();if(path){if(![...directories.options].some(option=>option.value===path))directories.append(Object.assign(el('option',path),{value:path}));directories.value=path;update()}}))
 directories.addEventListener('change',update)
 editButton.addEventListener('click',()=>{edit.hidden=!edit.hidden;body.hidden=!edit.hidden;save.hidden=edit.hidden;if(!edit.hidden)edit.focus()})
 save.addEventListener('click',()=>run(async()=>{
  const ref=reference();if(!ref||!edit.value.trim())return;busy=true;update()
  try{const text=edit.value;for(let offset=0;offset<text.length;offset+=2000)await c.command('plans.edit',{id:ref.id,plan_id:ref.plan_id,expected_version:ref.version,offset,text:text.slice(offset,offset+2000),final:offset+2000>=text.length})}finally{busy=false;update()}
 }))
 local.addEventListener('click',()=>run(async()=>{const ref=reference();if(!ref||!directories.value||busy)return;busy=true;update();try{await c.command('build.start',{...ref,project:directories.value})}finally{busy=false;update()}}))
 delegate.addEventListener('click',()=>run(async()=>{const ref=reference();if(!ref||!executors.value||busy)return;busy=true;update();try{await c.command('plans.delegate',{...ref,executor:executors.value})}finally{busy=false;update()}}))
 function update(){
  computerUse.update()
  const item=c.selectedConversation,build=item?.build,active=['running','awaiting_approval'].includes(build?.status)
  root.hidden=!item||item.kind==='proactive'
  status.textContent=build?t('Build · {0}',t(({running:'执行中',awaiting_approval:'待确认',paused:'已暂停',completed:'已完成',finished:'已锁定',failed:'失败',outcome_unknown:'结果不确定',idle:'就绪'})[build.status]??build.status)):''
  status.setAttribute('data-state',build?.status??'')
  // The path is one ellipsized line; the full value stays reachable on hover.
  project.textContent=build?.project??'';project.title=build?.project??''
  reason.textContent=build?.reason&&build.reason!=='stopped'?t(({model_timeout:'模型等待数据超时',model_overflow:'模型回复超出流容量限制',model_network:'模型连接中断',round_limit:'已达到本次工具调用上限',restart_requires_resume:'重启后等待恢复'})[build.reason]??build.reason):'';reason.hidden=!reason.textContent
  stop.hidden=!build||!active;resume.hidden=!build||active||['completed','finished'].includes(build.status);details.hidden=!build
  always.disabled=!c.connected||loadedApproval!==build?.approval?.id;approval.hidden=!build?.approval;deny.disabled=!c.connected;approve.disabled=!c.connected||loadedApproval!==build?.approval?.id
  if(build?.approval&&loadedApproval!==build.approval.id){if(loadingApproval!==build.approval.id)preview.textContent=build.approval.name+'\n'+build.approval.preview;void loadApproval(build.approval,item.id).catch(error=>{c.error=error.message;c.changed()})}
  const hasPlan=item?.mode==='plan'&&item.plan;planCard.hidden=!hasPlan
  // The mode lives in the composer; this strip appears only for a Build session or a published plan.
  bar.hidden=!build;if(!build&&!hasPlan&&!root.hidden)root.hidden=true
  if(lastSelected!==c.selectedId){lastSelected=c.selectedId;log.hidden=true;sequence++;loading=false;planKey='';failedKey='';plan=null;retry.hidden=true;body.replaceChildren()}
  if(hasPlan)void load().catch(error=>{c.error=error.message;c.changed()})
  local.hidden=!localBuildSupported;pick.hidden=!localBuildSupported;directories.hidden=!localBuildSupported
  local.disabled=!localBuildSupported||busy||!plan||!directories.value||!c.connected||JSON.stringify(reference())!==planKey
  delegate.disabled=busy||!plan||!executors.value||!c.connected;save.disabled=busy;editButton.disabled=busy||!plan;pick.disabled=busy;directories.disabled=busy
  // The composer's Build/Delegate choice makes that action the primary one; both stay available.
  const preferred=item?c.state?.(item.id)?.execution:undefined
  planCard.setAttribute('data-execution',preferred??'')
  local.setAttribute('data-primary',String(preferred==='build'));delegate.setAttribute('data-primary',String(preferred==='delegate'))
 }
 return {update,element:root}
}
