import {t,currentLanguage} from './locale.mjs'
export function sourceStatus(sources=[],status){
 if(sources.some(source=>source.processing_consent_required))return {kind:'consent',text:'部分资料需要授权后才能整理'}
 if(sources.length&&sources.every(source=>['paused','disconnected'].includes(source.state)))return {kind:'paused',text:'资料来源已暂停'}
 if(sources.some(source=>source.state==='error'||['error','degraded'].includes(source.health)))return {kind:'partial',text:'部分来源暂不可用，已有内容仍可查看'}
 if(status==='failed')return {kind:'failed',text:'这次整理未完成，已有内容仍可查看'}
 if(status==='working')return {kind:'working',text:'正在整理资料，已有内容仍可查看'}
 if(sources.some(source=>source.scan_pending))return {kind:'indexing',text:'资料索引仍在更新'}
 return null
}
/**
 * The briefing's metadata block is at most two lines: a constant summary, then at most one problem sentence.
 * Counts come from the backend coverage string ("本轮资料：N 条消息 · N 份文档 · N 条个人记录；消息记录 A—B"); the date range moves to the tooltip.
 */
export function timelineMeta({attention,sources=[],status,total=0,shown=0,archived=0,timeZone}){
 const parts=[],tips=[]
 if(attention.updated_at&&Number.isFinite(Date.parse(attention.updated_at)))parts.push(t('整理于 {0}',new Date(attention.updated_at).toLocaleString(currentLanguage(),{timeZone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})))
 if(attention.input_count&&attention.coverage){
  const match=/^本轮资料：([^；]*)(?:；消息记录 (.*))?$/u.exec(attention.coverage)
  parts.push(match?match[1]:attention.coverage)
  if(match?.[2])tips.push(t('消息记录 {0}',match[2]))
 }
 if(total)parts.push(t('共 {0} 条（已展示 {1}）',total,shown))
 if(archived)tips.push(t('其中 {0} 条为来源不可用的归档记录',archived))
 const state=sourceStatus(sources,status)
 let issue=null
 if(state?.kind==='consent')issue={kind:'consent',text:'部分资料需要授权后才能整理',sources:true}
 else if(attention.status==='failed'&&attention.cards?.length)issue={kind:'failed',text:'本次更新未完成，已保留上次结果'}
 else if((attention.diagnostics?.failed_batches?.length||attention.diagnostics?.pending_batches)&&attention.status!=='working')issue={kind:'partial',text:'部分资料尚未整理，可刷新补充'}
 else if(state&&['paused','partial'].includes(state.kind))issue={kind:state.kind,text:state.text,sources:true}
 return {line:parts.join(' · '),title:tips.join('\n'),issue}
}
export function renderSourceStatus(parent,{sources=[],status,processing=[],el,button,openSettings,text,link,className=''}){
 const state=sourceStatus(sources,status);if(!state&&!text&&!sources.length&&!processing.length)return
 const details=el('details',undefined,('source-status '+className).trim());details.dataset.state=state?.kind??'ready';details.append(el('summary',t(text??state?.text??'查看来源')+(link?' · '+t(link):'')));parent.append(details)
 const body=el('div',undefined,'source-status-details');details.append(body)
 for(const source of sources){
  const label=source.scope==='computer'?t('本机资料'):source.path?.split(/[\\/]/u).filter(Boolean).at(-1)??t('资料来源')
  const flags=[label,source.processing_consent_required?t('等待授权'):source.state==='paused'?t('已暂停'):source.state==='disconnected'?t('已断开'):source.state==='error'||source.health==='degraded'?t('部分读取失败'):t('已连接')]
  if(source.indexed!==undefined)flags.push(t('已索引 {0} 份资料',source.indexed))
  if(source.last_sync)flags.push(t('上次同步：{0}',source.last_sync))
  body.append(el('p',flags.join(' · ')))
  for(const failure of (source.failures??[]).slice(0,3))body.append(el('p',[failure.path?.split(/[\\/]/u).at(-1),failure.reason??failure.code??t('读取失败')].filter(Boolean).join(' · '),'hint'))
 }
 for(const run of processing){const label=run.status==='completed'?'已完成':run.status==='running'?'处理中':'未完成';body.append(el('p',`${t('资料整理')} · ${t(label)} · ${run.started_at} · ${t('模型调用 {0} 次',run.model_calls)}`))}
 if(openSettings)button(t('来源设置'),()=>openSettings('connectors'),body)
}
