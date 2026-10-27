import {t} from './locale.mjs'
import {parseTaskSnapshot} from './task-banner.mjs'

const PHASE_LABEL={started:'已开始',working:'进行中',failed:'执行失败',refused:'未执行',unknown:'结果待确认'}
const DONE=new Set(['completed','cancelled'])

/**
 * A small window floating at the vertical middle of the workbench edge that follows executor tasks. Output of a
 * delegated plan shows here, not in the task tab: collapsed it is one line per task, expanded it shows the latest
 * output and a link to the task detail. Snapshots come from the host's `executor.tasks` frames.
 */
export function mountExecutorFloat(parent,{el,button,openTask,taskFor}){
 const root=el('aside',undefined,'executor-float');root.hidden=true;root.dataset.expanded='false';root.setAttribute('aria-label',t('执行器进展'));root.setAttribute('aria-live','polite')
 parent.append(root)
 let tasks=[],revision=-1,expanded=false
 function render(){
  root.hidden=!tasks.length;root.dataset.expanded=String(expanded);root.replaceChildren()
  const first=tasks[0]
  if(!first)return
  const label=tasks.length>1?t('{0} · {1} 个任务',first.executor,tasks.length):`${first.executor} · ${t(PHASE_LABEL[first.phase]??first.phase)}`
  const pill=button(label,()=>{expanded=!expanded;render()},root);pill.className='executor-float-pill';pill.setAttribute('aria-expanded',String(expanded))
  if(!expanded)return
  for(const task of tasks){
   const card=el('article',undefined,'executor-float-task')
   card.append(el('strong',task.title),el('small',`${task.executor} · ${task.project} · ${t(PHASE_LABEL[task.phase]??task.phase)}`),el('p',task.summary,'executor-float-output'))
   const durable=taskFor?.(task.work_id)
   if(durable)button(t('查看详情'),()=>openTask(durable),card)
   root.append(card)
  }
 }
 function receive(frame){
  const snapshot=parseTaskSnapshot(frame)
  if(!snapshot||snapshot.revision<revision)return
  revision=snapshot.revision;tasks=snapshot.tasks.filter(task=>!DONE.has(task.phase))
  if(!tasks.length)expanded=false
  render()
 }
 /** A new connection may be a restarted backend whose revisions start over. */
 function reset(){tasks=[];revision=-1;expanded=false;render()}
 return {element:root,receive,reset}
}
