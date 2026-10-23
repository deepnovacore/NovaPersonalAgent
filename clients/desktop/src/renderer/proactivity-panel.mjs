import {onButton} from './button-action.mjs'
import {t} from './locale.mjs'
import {renderDailyBrief} from './daily-brief-view.mjs'

export const DAILY_CAP_MIN = 1
export const DAILY_CAP_MAX = 10
export const DAILY_CAP_DEFAULT = 5
/** Out-of-range or non-integer input never reaches the runtime; it is pulled into 1-10. */
export function clampDailyCap(value) {
 const number = Math.round(Number(value))
 return Number.isFinite(number) ? Math.min(DAILY_CAP_MAX, Math.max(DAILY_CAP_MIN, number)) : DAILY_CAP_DEFAULT
}
/** One line for the memory-embedding module, or null when the runtime did not report it. */
export function memoryEmbeddingNote(module, moduleStatusNote) {
 if (!module || typeof module.enabled !== 'boolean') return null
 return module.enabled ? t('记忆嵌入可用') : moduleStatusNote(module) || t('记忆嵌入不可用')
}

/** Discovery cadence, briefings, quiet hours and the daily proactive cap, all saved through `discovery.configure`. */
/**
 * The row telling the user that, without an OpenRouter key, interests and article titles go to the chat model.
 * `provider` is null when the settings do not name one; the wording stays generic instead of guessing.
 */
export function rankFallbackNote(provider) {
 return provider
  ? t('没有 OpenRouter 密钥时，会用你的对话模型（{0}）判断资讯相关度：你的兴趣、文章标题和摘要会发给它。', provider)
  : t('没有 OpenRouter 密钥时，会用你的对话模型判断资讯相关度：你的兴趣、文章标题和摘要会发给它。')
}

export function createProactivityPanel({document, api, moduleStatusNote = () => '', rankFallback = () => null}) {
 const root = document.querySelector('#proactivity-panel'), error = document.querySelector('#proactivity-error')
 let state = null, busy = false, memory
 const onError = caught => { error.textContent = caught?.message || t('主动性设置暂时不可用') }
 const el = (tag, text, cls) => {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node}
 const button = (text, action, parent) => {const node = el('button', text); node.type = 'button'; node.disabled = busy; onButton(node, action, onError); parent.append(node); return node}
 const card = (title, description) => {const node = el('article', undefined, 'im-card'); node.append(el('h3', title)); if (description) node.append(el('p', description)); root.append(node); return node}
 async function command(method, params = {}) {
  if (busy) throw new Error(t('请等待当前操作完成'))
  busy = true; error.textContent = ''
  try {
   const result = await api.personalCommand(method, params)
   if (result?.error) throw new Error(result.error)
   const next = method === 'state' ? result : await api.personalCommand('state', {})
   if (next?.error) throw new Error(next.error)
   state = next
   return result
  } finally {busy = false; render()}
 }
 function render() {
  root.replaceChildren()
  const connected = state !== null && !busy, caps = state?.capabilities ?? {}, settings = state?.settings ?? {}
  const discovery = card(t('主动发现'), t('有依据才提出建议。关闭后仍可主动交办任务。'))
  const select = el('select'); select.setAttribute('aria-label', t('主动发现间隔'))
  for (const [value, label] of [['0', t('关闭')], ['15', t('每 15 分钟')], ['30', t('每 30 分钟')], ['60', t('每小时')], ['120', t('每两小时')]]) {const option = el('option', label); option.value = value; select.append(option)}
  select.value = settings.discovery_enabled ? String(settings.discovery_interval_minutes) : '0'
  select.disabled = !connected || !caps.discovery
  select.addEventListener('change', () => {void command('discovery.configure', {enabled: select.value !== '0', ...(select.value !== '0' ? {interval_minutes: Number(select.value)} : {})}).catch(onError)})
  discovery.append(select)
  const cap = card(t('每日主动消息上限'), t('agent 主动找你的消息每天最多几条；你自己发起的任务结果不计入。'))
  const row = el('div', undefined, 'cap-stepper'), input = el('input'), value = clampDailyCap(settings.proactive_daily_cap ?? DAILY_CAP_DEFAULT)
  input.type = 'number'; input.min = String(DAILY_CAP_MIN); input.max = String(DAILY_CAP_MAX); input.step = '1'; input.value = String(value); input.setAttribute('aria-label', t('每日主动消息上限')); input.disabled = !connected
  const apply = next => {const clamped = clampDailyCap(next); input.value = String(clamped); if (clamped !== value) void command('discovery.configure', {proactive_daily_cap: clamped}).catch(onError)}
  input.addEventListener('change', () => apply(input.value))
  const step = (label, delta) => {const b = button(label, () => apply(Number(input.value) + delta), row); b.setAttribute('aria-label', delta < 0 ? t('减少上限') : t('增加上限')); b.disabled = !connected; return b}
  step('−', -1); row.append(input); step('+', 1); cap.append(row)
  const fallback = rankFallback()
  if (fallback?.keyMissing === true) {
   const news = card(t('资讯相关度'), rankFallbackNote(fallback.provider ?? null)), enabled = settings.news_rank_fallback !== false
   const label = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = enabled; box.disabled = !connected; box.setAttribute('aria-label', t('用对话模型判断资讯相关度'))
   box.addEventListener('change', () => {void command('discovery.configure', {news_rank_fallback: box.checked}).catch(onError)})
   label.append(box, el('span', t('用对话模型判断资讯相关度'))); news.append(label)
  }
  renderDailyBrief({settings, connected, card, el, button, command})
  const note = memoryEmbeddingNote(memory, moduleStatusNote)
  if (note) card(t('记忆'), note).dataset.memoryStatus = memory.enabled ? 'on' : 'off'
 }
 async function load() {
  if (busy) return
  try {await command('state')} catch (caught) {root.replaceChildren(el('p', t('未能读取主动性设置，请重试。'))); onError(caught)}
 }
 render()
 return {load, setMemory(module) {memory = module; if (!busy) render()}}
}
