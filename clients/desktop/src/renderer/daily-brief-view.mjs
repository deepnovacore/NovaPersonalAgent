import {t} from './locale.mjs'

const WEEKDAYS=['周一','周二','周三','周四','周五','周六','周日']

/** The diary is one row: a switch saved immediately through the existing personal command. */
export function renderDiary({settings={},connected,card,el,command,onError}) {
 const a=card(t('每日日记'),t('根据昨天经授权的记忆写日记，只供你浏览，不作为模型记忆。'))
 const row=el('div',undefined,'brief-slot'),label=el('label',undefined,'brief-toggle'),box=el('input')
 box.type='checkbox';box.setAttribute('role','switch');box.checked=settings.diary_enabled!==false;box.disabled=!connected;box.setAttribute('aria-label',t('写每日日记'))
 box.addEventListener('change',()=>{void command('discovery.configure',{diary_enabled:box.checked}).catch(onError)})
 label.append(box,el('span',t('写每日日记')));row.append(label);a.append(row)
}

/**
 * Edits host-owned scheduling settings through the existing personal command. The time zone is never asked for:
 * the runtime follows the device unless one was already stored, and saving leaves that stored value alone.
 */
export function renderDailyBrief({settings={},connected,card,el,button,command}) {
 const a=card(t('每日简报'),t('在主对话中查看当天安排和进展。')),fields={}
 const time=(key,title,value,parent)=>{const input=el('input');input.type='time';input.value=value;input.setAttribute('aria-label',title);input.disabled=!connected;parent.append(input);fields[key]=input;return input}
 const slot=(enabledKey,timeKey,title,timeTitle,enabled,value)=>{
  const row=el('div',undefined,'brief-slot'),label=el('label',undefined,'brief-toggle'),box=el('input')
  box.type='checkbox';box.setAttribute('role','switch');box.checked=enabled;box.disabled=!connected;box.setAttribute('aria-label',title)
  label.append(box,el('span',title));row.append(label);fields[enabledKey]=box
  const clock=time(timeKey,timeTitle,value,row)
  const sync=()=>{clock.disabled=!connected||!box.checked}
  box.addEventListener('change',sync);sync();a.append(row)
 }
 slot('briefing_outlook_enabled','briefing_outlook_time',t('早间简报'),t('早间时间'),settings.briefing_outlook_enabled??false,settings.briefing_outlook_time??'08:30')
 slot('briefing_review_enabled','briefing_review_time',t('晚间简报'),t('晚间时间'),settings.briefing_review_enabled??false,settings.briefing_review_time??'18:30')
 const days=el('div',undefined,'brief-days');days.setAttribute('role','group');days.setAttribute('aria-label',t('重复日期'));const weekdays=[]
 for(const [index,name]of WEEKDAYS.entries()){
  const title=t(name),label=el('label',undefined,'day-chip'),input=el('input');input.type='checkbox';input.checked=(settings.briefing_weekdays??[1,2,3,4,5]).includes(index+1);input.disabled=!connected;input.setAttribute('aria-label',title)
  label.append(input,el('span',title));days.append(label);weekdays.push(input)
 }
 a.append(days)
 const quiet=el('details',undefined,'brief-advanced');quiet.append(el('summary',t('免打扰')))
 const quietRow=el('div',undefined,'brief-quiet');quietRow.append(el('span',t('从')));time('quiet_start',t('免打扰开始'),settings.quiet_start??'22:00',quietRow);quietRow.append(el('span',t('到')));time('quiet_end',t('免打扰结束'),settings.quiet_end??'08:00',quietRow)
 quiet.append(quietRow,el('p',t('免打扰期间不发送提醒。'),'personal-hint'));a.append(quiet)
 const save=button(t('保存简报设置'),async()=>{
  const params=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value]))
  params.briefing_weekdays=weekdays.flatMap((input,index)=>input.checked?[index+1]:[])
  if(!params.briefing_weekdays.length)throw new Error(t('请选择至少一天'))
  for(const key of ['briefing_outlook_time','briefing_review_time','quiet_start','quiet_end'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(params[key]))throw new Error(t('请输入有效时间'))
  await command('discovery.configure',params)
 },a);save.disabled=!connected
 return fields
}
