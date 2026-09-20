import {t} from './locale.mjs'
export function personalMemoryBoard(root, request) {
  const controls = document.createElement('div')
  controls.className = 'board-actions'
  const search = document.createElement('input')
  search.type = 'search'
  search.maxLength = 200
  search.placeholder = t("搜索原话")
  search.setAttribute('aria-label', t("搜索记忆来源原话"))
  const submit = document.createElement('button')
  submit.textContent = t("搜索")
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const list = document.createElement('div')
  const next = document.createElement('button')
  next.textContent = t("下一页")
  next.hidden = true
  controls.append(search, submit)
  root.append(controls, status, list, next)
  let busy = false
  let cursor = null
  let pageQuery = null

  const text = (tag, content) => {
    const node = document.createElement(tag)
    node.textContent = content
    return node
  }
  async function load(before) {
    if (busy) return
    const query = search.value.trim()
    busy = true
    submit.disabled = next.disabled = true
    status.textContent = t("加载中…")
    try {
      const result = await request({channel: 'personal', query, ...(before && query === pageQuery ? {before_seq: before} : {})})
      if (query !== search.value.trim()) return
      pageQuery = query
      list.replaceChildren()
      cursor = null
      next.hidden = true
      if (result?.error) { status.textContent = t("暂时无法读取，请重试"); return }
      if (!result?.personal) { status.textContent = t("当前记忆服务不支持本机条目查看"); return }
      const {entries, next: nextCursor} = result.personal
      for (const entry of entries) {
        const card = document.createElement('article')
        card.className = 'item'
        const state = entry.state === 'learned' ? t("已学习") : t("尚未形成记忆")
        card.append(text('small', `${state} · ${new Date(entry.recordedAt).toLocaleString()}`))
        for (const memory of entry.memories) card.append(text('p', memory))
        if (!entry.memories.length) card.append(text('p', entry.original))
        const details = document.createElement('details')
        details.append(text('summary', t("查看原话")), text('p', entry.original))
        card.append(details)
        if (entry.truncated) card.append(text('small', t("内容较长，当前显示节选")))
        list.append(card)
      }
      cursor = nextCursor
      next.hidden = cursor === null
      status.textContent = entries.length ? t("mem0 · 本页 {0} 条", entries.length) : t("没有找到记忆")
    } catch { list.replaceChildren(); next.hidden = true; status.textContent = t("暂时无法读取，请重试") }
    finally { busy = false; submit.disabled = next.disabled = false }
  }
  search.addEventListener('input', () => { cursor = null; next.hidden = true; status.textContent = t("请点击搜索") })
  submit.addEventListener('click', () => { void load() })
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void load() } })
  next.addEventListener('click', () => { void load(cursor) })
  return {load}
}
