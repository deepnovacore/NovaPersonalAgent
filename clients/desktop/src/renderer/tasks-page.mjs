import {t} from './locale.mjs'
export const TASK_PHASE_LABEL={started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
export const activeTaskCount=state=>(state?.tasks??[]).filter(task=>['started','working'].includes(task.phase)).length
/** Executor tasks. The task banner owns the data; this page only renders and forwards actions. */
export function renderTasksPage(panel,{tasks,taskAction,results,card,chips,button,askProgress,local,rerender}){
 const state=tasks(),list=state?.tasks??[],retained=new Set(list.map(task=>task.work_id))
 for(const id of local.keys())if(!retained.has(id))local.delete(id)
 if(!list.length)card('暂无任务','开始对话后可在这里查看任务进展。')
 for(const task of list){
  if(!local.has(task.work_id))local.set(task.work_id,{expanded:false,error:'',asking:false})
  const view=local.get(task.work_id)
  const a=card(task.title,task.summary);a.dataset.phase=task.phase
  chips(a,[task.project,TASK_PHASE_LABEL[task.phase]||task.phase,task.executor])
  const actions=document.createElement('div');actions.className='card-actions';a.append(actions)
  const ask=button(view.asking?t('正在打开对话…'):'询问任务进展',async()=>{
   if(view.asking)return
   view.asking=true;view.error='';rerender()
   try{await askProgress(task)}catch(error){view.error=error.message==='conversation_not_found'?t('原任务对话已不存在，无法询问进展。'):error.message}
   finally{view.asking=false;rerender()}
  },actions);ask.disabled=!state.connected||view.asking
  const open=button(task.opening?'正在打开…':'打开项目',()=>taskAction(task.work_id,'open'),actions);open.disabled=!state.connected||task.opening
  if(['started','working'].includes(task.phase)){const cancel=button(task.cancelling?'正在停止…':'停止任务',()=>taskAction(task.work_id,'cancel'),actions);cancel.disabled=!state.connected||task.cancelling}
  if(view.error||task.error){const notice=document.createElement('p');notice.textContent=view.error||task.error;notice.setAttribute('role','alert');a.append(notice)}
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=t('查看结果');summary.setAttribute('data-task-result',task.work_id);details.append(summary);details.dataset.workId=task.work_id;details.open=view.expanded
  details.addEventListener('toggle',()=>{if(details.isConnected!==false)view.expanded=details.open})
  const result=results().find(result=>result.delegateId===task.work_id)
  const lines=result?[
   t(TASK_PHASE_LABEL[result.outcome==='ok'?'completed':result.outcome]),result.summary,
   t('变更文件：{0}',result.changedFiles??t('未知')),
   t('耗时：{0} 秒',(result.endedAt-result.startedAt).toFixed(1)),
   ...(result.diagnostic?[`${result.executor} ${result.diagnostic.method} (${result.diagnostic.server_code})`,result.diagnostic.message]:[]),
  ]:[t('暂无结果')]
  for(const text of lines){const p=document.createElement('p');p.textContent=text;details.append(p)}
  a.append(details)
 }
}
