import React, { useEffect, useRef, useState } from 'react'
import { t, currentLanguage } from '../../locale.mjs'
import { scheduleError } from './helpers.mjs'
export function ScheduleEditor({model,onSaved,onCancel,onReload,connected=true}:any) {
  const [,render]=useState(0), first=useRef<HTMLInputElement>(null),[acceptance,setAcceptance]=useState(model.value.acceptance.join('\n'))
  const value=model.value, rule=value.rule,locked=model.busy||!!model.pending||!connected
  useEffect(()=>{let live=true;model.onChange=()=>{if(live)render(n=>n+1)};first.current?.focus();if(!model.next&&!model.pending)void model.preview();return()=>{live=false;model.onChange=()=>{}}},[model])
  function setRule(next:any){if(model.set('rule',next))void model.preview()}
  const preview=(()=>{if(!model.next)return t('正在计算首次执行时间…');try{return t('首次执行：{0}',new Date(model.next.scheduled_at).toLocaleString(currentLanguage(),{timeZone:rule.timezone}))}catch{return t('请检查时间、时区和任务内容。')}})()
  const label=(text:string,input:React.ReactNode,hidden=false)=><label className="schedule-field" hidden={hidden}><span>{t(text)}</span>{input}</label>
  return <form className="schedule-editor" onSubmit={async e=>{e.preventDefault();if(!connected)return;try{const result=await model.save();if(result)onSaved(result)}catch(error){if(!model.error)model.error=scheduleError(error);model.onChange()}}} onKeyDown={e=>{if(e.key==='Escape'&&!model.busy){e.preventDefault();onCancel()}}}>
    <h3>{t(value.id?'编辑定时任务':'创建定时任务')}</h3><p className="schedule-muted">{t('写下希望 Nova 按时完成的事。每次运行都会生成独立的 Agent 任务。')}</p>
    {label('任务名称',<input ref={first} type="text" aria-label={t('任务名称')} maxLength={200} value={value.title} disabled={locked} onChange={e=>model.set('title',e.target.value)}/>)}
    {label('让 Nova 做什么',<textarea aria-label={t('让 Nova 做什么')} rows={4} maxLength={16000} placeholder={t('例如：结合待办和目标，整理今天最重要的三件事。')} value={value.goal} disabled={locked} onChange={e=>model.set('goal',e.target.value)}/>)}
    <section className="schedule-timing">
      {label('重复',<select aria-label={t('重复')} value={rule.kind} disabled={locked} onChange={e=>{const kind=e.target.value;setRule({kind,time:rule.time,timezone:rule.timezone,...(kind==='weekly'?{weekdays:[1]}:kind==='once'?{date:rule.date??new Date().toLocaleDateString('sv-SE')}:{})})}}>{[['once','仅一次'],['daily','每天'],['weekly','每周']].map(([id,text])=><option key={id} value={id}>{t(text)}</option>)}</select>)}
      {label('时间',<input aria-label={t('时间')} type="time" value={rule.time} disabled={locked} onChange={e=>setRule({...rule,time:e.target.value})}/>)}
      {label('日期',<input aria-label={t('日期')} type="date" value={rule.date??new Date().toLocaleDateString('sv-SE')} disabled={locked} onChange={e=>setRule({...rule,date:e.target.value})}/>,rule.kind!=='once')}
      {label('时区',<input aria-label={t('时区')} type="text" value={rule.timezone} disabled={locked} onChange={e=>setRule({...rule,timezone:e.target.value.trim()})}/>)}
    </section>
    <div className="schedule-weekdays" role="group" aria-label={t('运行星期')} hidden={rule.kind!=='weekly'}>{['周一','周二','周三','周四','周五','周六','周日'].map((text,i)=><button key={i} type="button" data-day={i+1} disabled={locked} aria-pressed={rule.weekdays?.includes(i+1)??false} onClick={()=>{const days=new Set<number>(rule.weekdays??[]);days.has(i+1)?days.delete(i+1):days.add(i+1);setRule({...rule,weekdays:[...days].sort((a,b)=>a-b)})}}>{t(text)}</button>)}</div>
    <p className="schedule-preview" aria-live="polite">{preview}</p>
    <details><summary>{t('完成标准与读取范围')}</summary>{label('完成标准（每行一条）',<textarea aria-label={t('完成标准（每行一条）')} rows={3} value={acceptance} disabled={locked} onChange={e=>{setAcceptance(e.target.value);model.set('acceptance',e.target.value.split('\n').map((s:string)=>s.trim()).filter(Boolean))}}/>)}<p className="schedule-muted">{t('只读取你勾选的数据；整理结果后，由你决定是否转为事项。')}</p><div className="schedule-scopes">{[['todos','待办'],['goals','目标'],['tasks','Agent 任务'],['memory','记忆'],['knowledge','已授权资料'],['search','联网搜索']].map(([id,text])=><label key={id}><input type="checkbox" aria-label={t(text)} checked={value.context[id]===true} disabled={locked} onChange={e=>model.set('context',{...value.context,[id]:e.target.checked})}/><span>{t(text)}</span></label>)}</div></details>
    <p className="schedule-error" role="alert">{model.error}</p>
    <div className="schedule-actions"><button type="button" disabled={model.busy} onClick={onCancel}>{t('返回')}</button><button type="button" hidden={!model.conflict} disabled={model.busy||!connected} onClick={onReload}>{t('载入最新版本')}</button><button className="primary" type="submit" disabled={!connected||model.busy||model.conflict||!model.pending&&!model.next}>{t(model.busy?'正在保存…':model.pending?'重试确认保存':'保存定时任务')}</button></div>
  </form>
}
