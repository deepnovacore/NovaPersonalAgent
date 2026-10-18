import {t} from './locale.mjs'
const services = {realtime:t("实时语音"),llm:t("文本模型"),asr:t("语音识别"),tts:t("语音合成"),embedding:t("向量化"),agent:t("外部 Agent")}
const fields = {inputTokens:t("输入词元"),outputTokens:t("输出词元"),inputTextTokens:t("输入文本"),inputAudioTokens:t("输入音频"),outputTextTokens:t("输出文本"),outputAudioTokens:t("输出音频"),cachedTokens:t("缓存命中"),reasoningTokens:t("推理词元"),characters:t("计费字符")}
const money = (value,symbol='¥') => value > 0 && value < 0.0001 ? `< ${symbol}0.0001` : `${symbol}${value.toFixed(4)}`
export const usageFeatureLabels={conversation:t("对话"),voice:t("语音对话"),profile:t("画像生成"),timeline:t("时间线生成"),context:t("上下文生成"),digest:t("摘要与简报"),embedding:t("向量化"),recall:t("记忆检索"),memory:t("记忆处理"),compression:t("上下文压缩"),verification:t("任务验收"),proactivity:t("主动建议"),news:t("新闻筛选"),understanding:t("个人理解"),scheduled:t("定时任务"),source_processing:t("资料处理 Agent"),vision:t("视觉理解"),agent:t("外部 Agent"),other:t("未分类"),legacy:t("历史未分类")}
export function usageCostText(view) {
 const costs=[]
 if(view.costCny>0||((view.estimatedCostReports??view.pricedReports??0)>0&&!(view.reportedCostReports>0)))costs.push(money(view.costCny??0))
 if(view.costUsd>0||view.reportedCostReports>0)costs.push(money(view.costUsd??0,'$'))
 return costs.join(' + ')||t("暂无费用数据")
}
export function frontendUsageText(view) {
  if (!view?.requests) return t("暂无用量报告")
  const partial = view.truncated || view.missingReports || view.unpricedReports
  const total = view.pricedReports ? `${usageCostText(view)}${partial ? t("（部分费用）") : ''}` : t("暂不可估算")
  const lines = [`${total}`, t("调用 {0} 次 · 缺少用量 {1} 次 · 无法估价 {2} 次", view.requests, view.missingReports, view.unpricedReports)]
  if (view.truncated) lines.push(t("已达统计容量上限，部分用量未计入；退出并重新打开应用可重新统计。"))
  for (const row of view.rows) {
    const counts = Object.entries(fields).filter(([key]) => row[key] !== undefined).map(([key,label]) => `${label} ${row[key].toLocaleString('zh-CN')}`)
    if (row.audioDurationMs !== undefined) counts.push(t("音频 {0} 秒", (row.audioDurationMs/1000).toFixed(3)))
    lines.push(`${services[row.service]} · ${row.provider}\n${row.model}\n${row.pricedReports ? usageCostText(row) : t("暂无费用数据")}${row.missingReports || row.unpricedReports ? t("（不完整）") : ''}\n${counts.join('；') || t("服务未返回用量")}`)
  }
  return lines.join('\n\n')
}

export function renderFrontendUsage(root, view, document = window.document, group = 'models') {
  const element = (tag, className, text) => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const metric = (label, value) => {
    const cell = element('div', 'usage-metric')
    cell.append(element('span', 'usage-metric-label', label), element('strong', 'usage-metric-value', value))
    return cell
  }
  root.replaceChildren()
  if (!view?.requests) return
  const stats = element('div', 'usage-stats')
  stats.append(metric(t("调用次数"), String(view.requests)), metric(t("缺少用量"), String(view.missingReports ?? 0)), metric(t("无法估价"), String(view.unpricedReports ?? 0)))
  stats.append(metric(t("失败调用"),String(view.failedRequests??0)),metric(t("取消调用"),String(view.cancelledRequests??0)))
  root.append(stats)
  const rows=group==='features'?(view.features??view.rows):group==='runs'?(view.runs??[]):view.rows
  if(!rows?.length)root.append(element('p','usage-empty',t("暂无该维度的用量记录")))
  for (const row of rows ?? []) {
    const card = element('article', 'usage-card')
    const header = element('div', 'usage-card-header')
    const service = element('div', 'usage-service')
    service.append(element('strong', '', group==='models'?(services[row.service] ?? t("模型服务")):(usageFeatureLabels[row.feature]??t("未分类"))))
    if(group==='models')service.append(element('span', 'usage-provider', {qwen: t("通义千问"), ark: t("火山方舟"), deepseek: 'DeepSeek', volcengine: t("火山语音")}[row.provider] ?? row.provider))
    const amount = element('div', 'usage-amount')
    amount.append(element('strong', '', row.pricedReports ? usageCostText(row) : t("暂无数据")))
    if (row.missingReports || row.unpricedReports) amount.append(element('span', 'usage-incomplete', t("部分用量")))
    header.append(service, amount)
    card.append(header, element('p', 'usage-model', group==='models'?row.model:group==='runs'?(row.runId??row.taskId??''):t("按功能汇总所有模型")))
    if(group==='runs'&&row.taskId)card.append(element('p','usage-model',t("任务 {0}",row.taskId)))
    const grid = element('div', 'usage-grid')
    for (const [key, label] of Object.entries(fields)) {
      if (row[key] !== undefined) grid.append(metric(label, row[key].toLocaleString('zh-CN')))
    }
    if (row.audioDurationMs !== undefined) grid.append(metric(t("音频时长"), t("{0} 秒", (row.audioDurationMs / 1000).toFixed(1))))
    grid.append(metric(t("调用次数"),String(row.requests)),metric(t("失败调用"),String(row.failedRequests??0)),metric(t("取消调用"),String(row.cancelledRequests??0)))
    if(row.durationMs!==undefined)grid.append(metric(t("平均耗时"),t("{0} 秒",(row.durationMs/Math.max(1,row.requests)/1000).toFixed(2))))
    if (!grid.children.length) grid.append(element('p', 'usage-empty', t("服务未返回用量")))
    card.append(grid)
    root.append(card)
  }
  if(view.recent?.length){
    const detail=element('details','usage-recent')
    detail.append(element('summary','',t("最近 {0} 次调用",view.recent.length)))
    for(const call of [...view.recent].reverse()){
      const line=element('div','usage-call')
      const outcome={success:t("成功"),error:t("失败"),cancelled:t("已取消")}[call.outcome]??t("未知")
      line.append(element('strong','',`${usageFeatureLabels[call.feature]??t("未分类")} · ${call.operation??call.service} · ${outcome}`))
      line.append(element('p','usage-model',`${call.model} · ${call.timestamp?new Date(call.timestamp).toLocaleString():''}`))
      line.append(element('p','',`${t("输入词元")} ${call.inputTokens??'—'} · ${t("输出词元")} ${call.outputTokens??'—'} · ${call.durationMs??'—'} ms${call.status==='missing'?' · '+t("缺少用量"):''}`))
      if(call.runId||call.taskId)line.append(element('p','usage-model',[call.runId,call.taskId].filter(Boolean).join(' · ')))
      detail.append(line)
    }
    root.append(detail)
  }
  if (view.truncated) root.append(element('p', 'usage-empty', t("统计已达容量上限，部分用量未计入")))
}
