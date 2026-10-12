import {t,currentLanguage} from './locale.mjs'
export const scheduleError=error=>t(({stale_schedule:'规则已更新，请载入最新版本后再保存。',schedule_in_past:'请选择未来的执行时间。',invalid_params:'请检查时间、时区和任务内容。',schedule_running:'上次任务尚未结束，请先查看执行进展。',context_authorization_changed:'相关资料已变化，请重新运行后查看结果。'})[error?.message]??error?.message??String(error))
const contextDefault={todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false}
export class ScheduleDraft{
 constructor(value,command){this.value=structuredClone(value??{});this.value={title:'',goal:'',acceptance:[],rule:{kind:'daily',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},context:contextDefault,...this.value};this.command=command;this.next=null;this.sequence=0;this.pending=null;this.busy=false;this.conflict=false;this.error='';this.onChange=()=>{}}
 set(key,value){if(this.pending||this.busy)return false;this.value[key]=structuredClone(value);this.error='';if(key==='rule'){this.sequence++;this.next=null}this.onChange();return true}
 async preview(){const sequence=++this.sequence,rule=structuredClone(this.value.rule);this.next=null;this.onChange();try{const result=await this.command('schedules.preview',{rule});if(sequence===this.sequence){this.next=result.next_slot;this.previewKey=JSON.stringify(rule);this.error=this.next?'':t('请选择未来的执行时间。')}}catch(error){if(sequence===this.sequence)this.error=scheduleError(error)}finally{if(sequence===this.sequence)this.onChange()}}
 async save(){
  if(this.busy)return null
  if(this.conflict)throw Error('stale_schedule')
  if(!this.pending){
   const {title,goal,acceptance,rule,context,id,revision}=this.value
   if(!title.trim()||!goal.trim()||!acceptance.length||!rule.timezone?.trim()||!rule.time||rule.kind==='weekly'&&!rule.weekdays?.length||rule.kind==='once'&&!rule.date)throw Error('invalid_params')
   if(!this.next||this.previewKey!==JSON.stringify(rule))throw Error('preview_required')
   this.pending={method:id?'schedules.update':'schedules.create',params:{input:{title:title.trim(),goal:goal.trim(),acceptance,rule,context},...(id?{id,expected_revision:revision}:{})},request_id:crypto.randomUUID()}
  }
  this.busy=true;this.error='';this.onChange()
  try{const result=await this.command(this.pending.method,this.pending.params,{request_id:this.pending.request_id});this.pending=null;return result}
  catch(error){this.error=scheduleError(error);if(['stale_schedule','invalid_params','schedule_in_past','context_not_authorized'].includes(error.message)){this.pending=null;this.conflict=error.message==='stale_schedule'}else{this.error=t('尚未确认保存结果，草稿已保留。重试会核对同一请求。');await this.command('schedules.list',{}).catch(()=>{})}throw error}
  finally{this.busy=false;this.onChange()}
 }
}
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=t(text);if(cls)el.className=cls;return el}
export function mountScheduleEditor(container,{value,command,model=new ScheduleDraft(value,command),onSaved,onCancel,onReload}){
 const form=node('form',undefined,'schedule-editor'),heading=node('h3',model.value.id?'编辑定时任务':'创建定时任务');form.append(heading,node('p','写下希望 Nova 按时完成的事。每次运行都会生成独立的 Agent 任务。','schedule-muted'));container.append(form)
 const fields=[]
 const field=(label,tag,value,type,change,parent=form)=>{const wrap=node('label',undefined,'schedule-field'),labelNode=node('span',label),input=node(tag);input.setAttribute('aria-label',t(label));if(type)input.type=type;input.value=value??'';input.addEventListener(tag==='select'||type==='checkbox'?'change':'input',()=>change(input));wrap.append(labelNode,input);parent.append(wrap);fields.push(input);return input}
 field('任务名称','input',model.value.title,'text',input=>model.set('title',input.value)).maxLength=200
 const goal=field('让 Nova 做什么','textarea',model.value.goal,null,input=>model.set('goal',input.value));goal.rows=4;goal.maxLength=16000;goal.placeholder=t('例如：结合待办和目标，整理今天最重要的三件事。')
 const timing=node('section',undefined,'schedule-timing');form.append(timing)
 const frequency=field('重复','select',null,null,input=>{const kind=input.value;model.set('rule',{kind,time:time.value,timezone:zone.value,...(kind==='weekly'?{weekdays:[1]}:kind==='once'?{date:date.value}:{})});updateCalendar();void model.preview()},timing)
 for(const [key,label]of [['once','仅一次'],['daily','每天'],['weekly','每周']]){const option=node('option',label);option.value=key;frequency.append(option)}frequency.value=model.value.rule.kind
 const time=field('时间','input',model.value.rule.time,'time',input=>{model.set('rule',{...model.value.rule,time:input.value});void model.preview()},timing)
 const date=field('日期','input',model.value.rule.date??new Date().toLocaleDateString('sv-SE'),'date',input=>{model.set('rule',{...model.value.rule,date:input.value});void model.preview()},timing)
 const zone=field('时区','input',model.value.rule.timezone,'text',input=>{model.set('rule',{...model.value.rule,timezone:input.value.trim()});void model.preview()},timing)
 const weekdays=node('div',undefined,'schedule-weekdays');weekdays.setAttribute('role','group');weekdays.setAttribute('aria-label',t('运行星期'));form.append(weekdays)
 for(const [day,label]of [[1,'周一'],[2,'周二'],[3,'周三'],[4,'周四'],[5,'周五'],[6,'周六'],[0,'周日']]){const button=node('button',label);button.type='button';button.dataset.day=String(day);button.addEventListener('click',()=>{const days=new Set(model.value.rule.weekdays??[]);days.has(day)?days.delete(day):days.add(day);model.set('rule',{...model.value.rule,weekdays:[...days].sort()});updateCalendar();void model.preview()});fields.push(button);weekdays.append(button)}
 function updateCalendar(){date.parentElement.hidden=frequency.value!=='once';weekdays.hidden=frequency.value!=='weekly';for(const button of weekdays.children)button.setAttribute('aria-pressed',String(model.value.rule.weekdays?.includes(Number(button.dataset.day))??false))}updateCalendar()
 const preview=node('p','正在计算首次执行时间…','schedule-preview');preview.setAttribute('aria-live','polite');form.append(preview)
 const details=node('details'),summary=node('summary','完成标准与读取范围');details.append(summary);form.append(details)
 const acceptance=field('完成标准（每行一条）','textarea',model.value.acceptance.join('\n'),null,input=>model.set('acceptance',input.value.split('\n').map(s=>s.trim()).filter(Boolean)),details);acceptance.rows=3
 details.append(node('p','只读取你勾选的数据；整理结果后，由你决定是否转为事项。','schedule-muted'))
 const scopes=node('div',undefined,'schedule-scopes');details.append(scopes)
 for(const [key,label]of [['todos','待办'],['goals','目标'],['tasks','Agent 任务'],['memory','记忆'],['knowledge','已授权资料'],['search','联网搜索']]){const wrap=node('label'),input=node('input');input.type='checkbox';input.checked=model.value.context[key]===true;input.setAttribute('aria-label',t(label));input.addEventListener('change',()=>model.set('context',{...model.value.context,[key]:input.checked}));fields.push(input);wrap.append(input,node('span',label));scopes.append(wrap)}
 const error=node('p',undefined,'schedule-error');error.setAttribute('role','alert');form.append(error)
 const actions=node('div',undefined,'schedule-actions'),cancel=node('button','返回'),reload=node('button','载入最新版本'),save=node('button','保存定时任务');save.className='primary';save.type='submit';cancel.type=reload.type='button';cancel.addEventListener('click',onCancel);reload.addEventListener('click',onReload??(()=>{}));actions.append(cancel,reload,save);form.append(actions)
 model.onChange=()=>{preview.textContent=model.next?t('首次执行：{0}',new Date(model.next.scheduled_at).toLocaleString(currentLanguage(),{timeZone:model.value.rule.timezone})):t('正在计算首次执行时间…');error.textContent=model.error;reload.hidden=!model.conflict;save.disabled=model.busy||model.conflict||!model.pending&&!model.next;save.textContent=t(model.busy?'正在保存…':model.pending?'重试确认保存':'保存定时任务');for(const input of fields)input.disabled=model.busy||!!model.pending;cancel.disabled=model.busy}
 form.addEventListener('submit',async event=>{event.preventDefault();try{const result=await model.save();if(result)onSaved(result)}catch(error){if(!model.error)model.error=scheduleError(error);model.onChange()}})
 form.addEventListener('keydown',event=>{if(event.key==='Escape'&&!model.busy){event.preventDefault();onCancel()}})
 model.onChange();if(!model.next&&!model.pending)void model.preview()
 return {dispose(){model.onChange=()=>{}},focus(){fields[0].focus()},model}
}
