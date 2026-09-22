export const TASK_PHASE_LABEL={started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
export const activeTaskCount=state=>(state?.tasks??[]).filter(t=>['started','working'].includes(t.phase)).length
/** Executor tasks. The task banner owns the data; this page only renders and forwards actions. */
export function renderTasksPage(panel,{tasks,taskAction,results,openResults,card,chips,button,askProgress}){
 const state=tasks()
 if(state?.error){const notice=card('任务列表暂时不可用',state.error);notice.classList.add('warn');notice.setAttribute('role','alert')}
 const list=state?.tasks??[];if(!list.length)card('暂无任务','开始对话后可在这里查看任务进展。')
 for(const task of list){
  const a=card(task.title,task.summary);a.dataset.phase=task.phase
  chips(a,[task.project,TASK_PHASE_LABEL[task.phase]||task.phase,task.executor])
  const actions=document.createElement('div');actions.className='card-actions';a.append(actions)
  button('询问任务进展',()=>askProgress(task),actions)
  const active=state?.selected?.work_id===task.work_id
  const open=button(active&&state?.opening?'正在打开…':'打开项目',()=>taskAction(task.work_id,'open'),actions);open.disabled=active&&state?.opening
  if(['started','working'].includes(task.phase)){const cancel=button(active&&state?.cancelling?'正在停止…':'停止任务',()=>taskAction(task.work_id,'cancel'),actions);cancel.disabled=active&&state?.cancelling}
  if(results().length)button('查看结果',openResults,actions)
 }
}
