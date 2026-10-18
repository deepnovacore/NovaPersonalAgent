import {t} from './locale.mjs'
export function sourceStatus(sources=[],status){
 if(sources.some(source=>source.processing_consent_required))return {kind:'consent',text:'部分资料需要授权后才能整理'}
 if(sources.length&&sources.every(source=>['paused','disconnected'].includes(source.state)))return {kind:'paused',text:'资料来源已暂停'}
 if(sources.some(source=>source.state==='error'||['error','degraded'].includes(source.health)))return {kind:'partial',text:'部分来源暂不可用，已有内容仍可查看'}
 if(status==='failed')return {kind:'failed',text:'这次整理未完成，已有内容仍可查看'}
 if(status==='working')return {kind:'working',text:'正在整理资料，已有内容仍可查看'}
 if(sources.some(source=>source.scan_pending))return {kind:'indexing',text:'资料索引仍在更新'}
 return null
}
export function renderSourceStatus(parent,{sources=[],status,processing=[],el,button,openSettings}){
 const state=sourceStatus(sources,status);if(!state&&!sources.length&&!processing.length)return
 const details=el('details',undefined,'source-status');details.dataset.state=state?.kind??'ready';details.append(el('summary',t(state?.text??'查看来源')));parent.append(details)
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
 if(openSettings)button(t('来源设置'),()=>openSettings('connections'),body)
}
