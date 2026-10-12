import {t,currentLanguage} from './locale.mjs'
import {ScheduleDraft,mountScheduleEditor,scheduleError} from './schedule-editor.mjs'
export function scheduleRuleLabel(rule){const days=['周日','周一','周二','周三','周四','周五','周六'];return [rule.kind==='once'?rule.date:rule.kind==='daily'?t('每天'):(rule.weekdays??[]).map(day=>t(days[day])).join('、'),rule.time,rule.timezone].filter(Boolean).join(' · ')}
export async function scheduleMutation(local,command,operation,params){
 local.requests??=new Map();const key=JSON.stringify([operation,params.id??params.run_id]);let pending=local.requests.get(key)
 if(!pending){pending={request_id:crypto.randomUUID(),params:structuredClone(params)};local.requests.set(key,pending)}
 try{const result=await command('schedules.'+operation,pending.params,{request_id:pending.request_id});local.requests.delete(key);return result}
 catch(error){if(['stale_schedule','invalid_params','schedule_running','context_authorization_changed','version_conflict'].includes(error.message))local.requests.delete(key);throw error}
}
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=t(text);if(cls)node.className=cls;return node}
const when=(instant,timezone)=>instant?new Date(instant).toLocaleString(currentLanguage(),{timeZone:timezone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):t('暂无安排')
export function renderScheduledTasksPage(panel,{snapshot,command,openTask,openResult,local,rerender,connected=true}){
 const root=el('section',undefined,'scheduled-page');panel.append(root)
 const act=async action=>{if(local.busy)return;local.busy=true;local.error='';rerender();try{await action()}catch(error){local.error=scheduleError(error)}finally{local.busy=false;rerender()}}
 const button=(label,action,parent,cls)=>{const node=el('button',label,cls);node.type='button';node.disabled=!connected||!!local.busy;node.addEventListener('click',()=>act(action));parent.append(node);return node}
 const back=()=>{local.selected=null;local.editor=false;local.error='';rerender()}
 const edit=value=>{local.focusEditor=true;local.draft=new ScheduleDraft(value,command);local.editor=true;rerender()}
 const load=async id=>{local.selected=id;local.detail=null;local.history=null;local.editor=false;const value=await command('schedules.get',{id});if(local.selected!==id)return;local.detail=value;local.history=await command('schedules.history',{id});rerender()}
 if(local.error){const error=el('p',local.error,'schedule-error');error.setAttribute('role','alert');root.append(error)}
 if(local.editor){
  const view=mountScheduleEditor(root,{model:local.draft,command,onCancel:()=>{local.editor=false;rerender();panel.querySelector?.('button')?.focus()},onSaved:value=>{local.editor=false;local.selected=value.id;local.detail=value;local.history=null;rerender()},onReload:()=>act(async()=>{const value=await command('schedules.get',{id:local.draft.value.id});edit(value)})})
  if(local.focusEditor){local.focusEditor=false;view.focus()}
  return view
 }
 const schedules=snapshot?.schedules?.items??[]
 if(local.selected){
  button('所有定时任务',back,root,'ghost')
  const item=local.detail
  if(!item){root.append(el('p','正在加载…','schedule-muted'));return {dispose(){}}}
  const heading=el('header',undefined,'schedule-heading');heading.append(el('span','◷','schedule-emblem'),el('h2',item.title));root.append(heading)
  root.append(el('p',scheduleRuleLabel(item.rule),'schedule-muted'),el('p',item.goal,'schedule-goal'))
  const current=schedules.find(row=>row.id===item.id)??item
  root.append(el('p',current.enabled?t('下次运行：{0}',when(current.next_slot?.scheduled_at,current.rule.timezone)):t('已暂停 · 当前运行不受影响'),'schedule-preview'))
  const actions=el('div',undefined,'schedule-actions');root.append(actions)
  button('编辑',async()=>edit(await command('schedules.get',{id:item.id})),actions)
  button(current.enabled?'暂停定时':'恢复定时',async()=>{local.detail=await scheduleMutation(local,command,current.enabled?'pause':'resume',{id:item.id,expected_revision:current.revision})},actions)
  const running=(snapshot?.schedules?.active_runs??[]).find(run=>run.schedule_id===item.id)
  button('现在运行',async()=>{await scheduleMutation(local,command,'run_now',{id:item.id,expected_revision:current.revision});local.history=await command('schedules.history',{id:item.id})},actions).disabled=!connected||!!local.busy||!!running
  if(running?.task_id){const task=snapshot.tasks?.find(task=>task.id===running.task_id);button('查看当前任务',()=>openTask(running.task_id),actions,'soft');if(task)button('停止当前任务',()=>command('tasks.cancel',{task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}),actions)}
  const criteria=el('details');criteria.append(el('summary','完成标准'));const list=el('ul');for(const text of item.acceptance)list.append(el('li',text));criteria.append(list);root.append(criteria)
  const historyTitle=el('div',undefined,'schedule-section-heading');historyTitle.append(el('h3','运行记录'));button('刷新记录',async()=>{local.history=await command('schedules.history',{id:item.id})},historyTitle,'ghost');root.append(historyTitle)
  if(!local.history&&!local.loadingHistory){local.loadingHistory=true;void command('schedules.history',{id:item.id}).then(page=>{if(local.selected===item.id)local.history=page}).catch(error=>{local.history={items:[]};local.error=scheduleError(error)}).finally(()=>{local.loadingHistory=false;rerender()})}
  const rows=local.history?.items??[]
  if(!rows.length)root.append(el('p',running?'Nova 正在执行，完成后会在这里显示结果。':'还没有运行记录。你可以先运行一次。','schedule-muted'))
  for(const run of rows){
   const card=el('article',undefined,'schedule-run');card.dataset.runId=run.run_id;const status={completed:'已完成',cancelled:'已停止',missed:'已错过',skipped:'已跳过',failed:'失败'}[run.summary?.outcome]??'进行中'
   card.append(el('small',t('{0} · {1}',when(run.slot?.scheduled_at??run.claimed_at,item.rule.timezone),t(status))),el('p',run.summary?.text??t('结果生成中…')));root.append(card)
   const actions=el('div',undefined,'schedule-actions');card.append(actions)
   if(run.task_id)button('查看任务',()=>openTask(run.task_id),actions,'ghost')
   if(run.summary?.outcome==='completed'){button('继续讨论',()=>openResult(run.run_id),actions,'soft');button('转为事项',()=>{local.adopt={run_id:run.run_id,title:item.title,note:run.summary.text.slice(0,4000),kind:'todo'};rerender()},actions)}
  }
  if(local.history?.next_cursor)button('更多记录',async()=>{const page=await command('schedules.history',{id:item.id,cursor:local.history.next_cursor});local.history={items:[...local.history.items,...page.items],next_cursor:page.next_cursor}},root)
  if(local.adopt)renderAdoption(root,local.adopt,snapshot,button,async value=>{await scheduleMutation(local,command,'adopt_result',value);local.adopt=null;local.notice='已保存到个人事项';rerender()},()=>{local.adopt=null;rerender()})
  if(local.notice){const notice=el('p',local.notice,'schedule-preview');notice.setAttribute('role','status');root.append(notice)}
  const removal=el('details',undefined,'schedule-removal');removal.append(el('summary','删除规则'));removal.append(el('p','删除后不再触发，已有任务和结果仍保留。','schedule-muted'));button('确认删除规则',async()=>{await scheduleMutation(local,command,'delete',{id:item.id,expected_revision:current.revision});back()},removal);root.append(removal)
  return {dispose(){}}
 }
 const header=el('header',undefined,'schedule-heading'),copy=el('div');copy.append(el('h2','留给 Nova，按时完成'),el('p','为反复需要的整理和跟进，安排一个固定时间。','schedule-muted'));header.append(copy);button('创建定时任务',()=>edit({rule:{kind:'daily',time:'09:00',timezone:snapshot?.settings?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone},acceptance:[t('完成任务并说明依据与不确定性。')]}),header,'primary');root.append(header)
 if(schedules.length){const grid=el('div',undefined,'schedule-list');root.append(grid);for(const item of schedules){const card=el('article',undefined,'schedule-card');card.dataset.scheduleId=item.id;card.dataset.enabled=String(item.enabled);grid.append(card);const icon=el('span','◷','schedule-emblem'),body=el('div',undefined,'schedule-card-copy');body.append(el('h3',item.title),el('p',scheduleRuleLabel(item.rule),'schedule-muted'),el('small',item.enabled?t('下次 {0}',when(item.next_slot?.scheduled_at,item.rule.timezone)):t('已暂停')));card.append(icon,body);button('查看',()=>load(item.id),card,'ghost')}}
 else{const empty=el('div',undefined,'schedule-empty');empty.append(el('span','◷','schedule-emblem'),el('h3','把重复的事安排好'),el('p','选择下面的常用任务，或创建自己的定时任务。','schedule-muted'));root.append(empty)}
 root.append(el('h3','常用任务','schedule-section-heading'))
 if(!local.presets&&!local.loadingPresets){local.loadingPresets=true;void command('schedules.presets',{}).then(result=>{local.presets=result.items}).catch(error=>{local.presets=[];local.error=scheduleError(error)}).finally(()=>{local.loadingPresets=false;rerender()})}
 const presets=el('div',undefined,'schedule-presets');root.append(presets)
 for(const [index,preset]of(local.presets??[]).entries()){const card=el('article',undefined,'schedule-preset');card.dataset.tone=index%2?'violet':'blue';card.append(el('span',index?'▤':'☷','schedule-emblem'),el('h3',preset.input.title),el('p',preset.description,'schedule-muted'),el('small',scheduleRuleLabel(preset.input.rule)));button('安排这个任务',()=>edit(preset.input),card,'soft');presets.append(card)}
 root.append(el('p','Runtime 在线时自动执行；桌面可在后台运行，手机无需保持打开。','schedule-footnote'))
 return {dispose(){}}
}
function renderAdoption(root,value,snapshot,button,save,cancel){
 const form=el('section',undefined,'schedule-adoption');form.append(el('h3','保存为个人事项'));root.append(form)
 const field=(label,tag,key)=>{const wrap=el('label',undefined,'schedule-field'),input=el(tag);input.value=value[key]??'';input.setAttribute('aria-label',t(label));input.addEventListener('input',()=>{value[key]=input.value});wrap.append(el('span',label),input);form.append(wrap);return input}
 const kind=field('事项类型','select','kind');for(const [key,label]of [['todo','待办'],['idea','想法']]){const option=el('option',label);option.value=key;kind.append(option)}kind.value=value.kind
 field('事项标题','input','title').maxLength=200;field('内容','textarea','note').maxLength=4000
 const goal=field('关联目标','select','goal_id');const none=el('option','不关联目标');none.value='';goal.append(none);for(const row of snapshot?.life?.goals??[]){const option=el('option',row.title);option.value=row.id;goal.append(option)}goal.value=value.goal_id??''
 button('保存事项',()=>{const {goal_id,...input}=value,row=snapshot?.life?.goals?.find(row=>row.id===goal_id);return save({...input,...(row?{goal_id:row.id,goal_version:row.version}:{})})},form,'primary');button('取消',cancel,form)
}
