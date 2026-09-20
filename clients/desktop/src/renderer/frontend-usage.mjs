import {t} from './locale.mjs'
const services = {realtime:t("实时语音"),llm:t("文本模型"),asr:t("语音识别"),tts:t("语音合成")}
const fields = {inputTokens:t("输入词元"),outputTokens:t("输出词元"),inputTextTokens:t("输入文本"),inputAudioTokens:t("输入音频"),outputTextTokens:t("输出文本"),outputAudioTokens:t("输出音频"),cachedTokens:t("缓存命中"),reasoningTokens:t("推理词元"),characters:t("计费字符")}
const money = value => value > 0 && value < 0.0001 ? '< ¥0.0001' : `¥${value.toFixed(4)}`
export function frontendUsageText(view) {
  if (!view?.requests) return t("暂无用量报告")
  const partial = view.truncated || view.missingReports || view.unpricedReports
  const total = view.pricedReports ? `${money(view.costCny)}${partial ? t("（部分费用）") : ''}` : t("暂不可估算")
  const lines = [`${total}`, t("调用 {0} 次 · 缺少用量 {1} 次 · 无法估价 {2} 次", view.requests, view.missingReports, view.unpricedReports)]
  if (view.truncated) lines.push(t("已达统计容量上限，部分用量未计入；退出并重新打开应用可重新统计。"))
  for (const row of view.rows) {
    const counts = Object.entries(fields).filter(([key]) => row[key] !== undefined).map(([key,label]) => `${label} ${row[key].toLocaleString('zh-CN')}`)
    if (row.audioDurationMs !== undefined) counts.push(t("音频 {0} 秒", (row.audioDurationMs/1000).toFixed(3)))
    lines.push(`${services[row.service]} · ${row.provider}\n${row.model}\n${row.pricedReports ? money(row.costCny) : t("暂无费用数据")}${row.missingReports || row.unpricedReports ? t("（不完整）") : ''}\n${counts.join('；') || t("服务未返回用量")}`)
  }
  return lines.join('\n\n')
}

export function renderFrontendUsage(root, view, document = window.document) {
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
  root.append(stats)
  for (const row of view.rows ?? []) {
    const card = element('article', 'usage-card')
    const header = element('div', 'usage-card-header')
    const service = element('div', 'usage-service')
    service.append(element('strong', '', services[row.service] ?? t("模型服务")), element('span', 'usage-provider', {qwen: t("通义千问"), ark: t("火山方舟"), deepseek: 'DeepSeek', volcengine: t("火山语音")}[row.provider] ?? row.provider))
    const amount = element('div', 'usage-amount')
    amount.append(element('strong', '', row.pricedReports ? money(row.costCny) : t("暂无数据")))
    if (row.missingReports || row.unpricedReports) amount.append(element('span', 'usage-incomplete', t("部分用量")))
    header.append(service, amount)
    card.append(header, element('p', 'usage-model', row.model))
    const grid = element('div', 'usage-grid')
    for (const [key, label] of Object.entries(fields)) {
      if (row[key] !== undefined) grid.append(metric(label, row[key].toLocaleString('zh-CN')))
    }
    if (row.audioDurationMs !== undefined) grid.append(metric(t("音频时长"), t("{0} 秒", (row.audioDurationMs / 1000).toFixed(1))))
    if (!grid.children.length) grid.append(element('p', 'usage-empty', t("服务未返回用量")))
    card.append(grid)
    root.append(card)
  }
  if (view.truncated) root.append(element('p', 'usage-empty', t("统计已达容量上限，部分用量未计入")))
}
