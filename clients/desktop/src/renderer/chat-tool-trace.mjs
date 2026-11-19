import {t} from './locale.mjs'

/**
 * Compact, expandable record of the retrieval/memory calls a chat turn made.
 *
 * The runtime is the only writer of this data: live frames carry
 * `{name,state,summary,turn_id}` and persisted assistant messages may carry
 * `tool_trace:[{name,state,summary}]`. Everything here is display-only and is
 * deliberately narrowed to those three fields, so model arguments and tool
 * results can never be rendered by accident.
 */
export const TOOL_TRACE_LIMIT=16
export const TOOL_TRACE_SUMMARY_LIMIT=160
export const TOOL_TRACE_STATES=Object.freeze(['running','ok','error'])

/**
 * Provider wire names, exactly as the model sees them. A name outside this
 * table still renders through the generic fallback instead of disappearing.
 */
export const TOOL_TRACE_LABELS=Object.freeze({
 'memory__recall':'检索记忆',
 'memory__evidence':'读取原文',
 'memory__remember':'更新记忆',
 'memory__lookup':'查看记忆',
 'source__process':'处理资料',
 'app__context':'读取应用上下文',
 'search__search':'搜索网络',
 'mcp__nova_knowledge__recall':'检索知识库',
 'mcp__nova_knowledge__get_chunk':'读取知识原文',
})
export const TOOL_TRACE_STATE_LABELS=Object.freeze({running:'运行中',ok:'完成',error:'失败'})

/** A tool name only ever becomes a localized label, never raw UI text. */
export function toolTraceLabel(name){return t(TOOL_TRACE_LABELS[name]??'工具调用')}
export function toolTraceStateLabel(state){return t(TOOL_TRACE_STATE_LABELS[state]??TOOL_TRACE_STATE_LABELS.ok)}

const STATE_ALIASES={running:'running',ok:'ok',error:'error',completed:'ok',done:'ok',success:'ok',failed:'error',failure:'error'}

/** Long summaries stay one quiet line; control characters never reach the DOM. */
export function toolTraceSummary(value){
 if(typeof value!=='string')return''
 const text=value.replace(/[\u0000-\u001f\u007f]+/gu,' ').replace(/\s+/gu,' ').trim()
 return text.length>TOOL_TRACE_SUMMARY_LIMIT?text.slice(0,TOOL_TRACE_SUMMARY_LIMIT-1)+'…':text
}

/**
 * Copies only display-safe fields. Unknown states and nameless rows are
 * dropped rather than rendered half-known; the newest surplus rows are
 * dropped at the cap so a chatty turn cannot grow the transcript.
 */
export function normalizeToolTrace(value,{limit=TOOL_TRACE_LIMIT}={}){
 if(!Array.isArray(value)||limit<=0)return[]
 const rows=[]
 for(const item of value){
  if(rows.length>=limit)break
  if(!item||typeof item!=='object')continue
  const name=typeof item.name==='string'?item.name.trim():''
  if(!name)continue
  const state=STATE_ALIASES[item.state]
  if(!state)continue
  rows.push({name,state,summary:toolTraceSummary(item.summary)})
 }
 return rows
}

/** Worst state wins: an error must stay visible even when other calls succeeded. */
export function aggregateToolTraceState(items){
 let running=false
 for(const item of items??[]){
  if(item?.state==='error')return'error'
  if(item?.state==='running')running=true
 }
 return running?'running':'ok'
}

/**
 * Builds a compact trace for one assistant turn, expandable only when there
 * is additional content. Returns null when empty, so callers can append it
 * unconditionally. `el` is the renderer's `(tag,text,className)` factory; a
 * plain object/`children` DOM stub is enough to test it.
 */
export function createToolTraceNode(value,{el,open=false,live=false}={}){
 if(typeof el!=='function')return null
 const items=normalizeToolTrace(value)
 if(!items.length)return null
 const state=aggregateToolTraceState(items)
 if(items.length===1&&!items[0].summary){
  const row=el('div',undefined,'chat-tool-trace chat-tool-trace-static')
  row.dataset.state=state
  row.dataset.live=String(live===true)
  const dot=el('span',undefined,'chat-tool-trace-dot')
  dot.dataset.state=state
  dot.setAttribute('aria-hidden','true')
  row.append(dot,el('span',toolTraceLabel(items[0].name),'chat-tool-trace-label'),el('span',toolTraceStateLabel(state),'visually-hidden'))
  return row
 }
 const details=el('details',undefined,'chat-tool-trace')
 details.open=open===true
 details.dataset.state=state
 details.dataset.live=String(live===true)
 // The summary line names a lone tool; several calls stay compact as a count.
 const label=items.length===1?toolTraceLabel(items[0].name):t('工具调用 · {0}',items.length)
 const summary=el('summary',undefined,'chat-tool-trace-summary')
 const headerDot=el('span',undefined,'chat-tool-trace-dot')
 headerDot.dataset.state=state
 headerDot.setAttribute('aria-hidden','true')
 const labelNode=el('span',label,'chat-tool-trace-label')
 const stateNode=el('span',toolTraceStateLabel(state),'visually-hidden')
 summary.append(headerDot,labelNode,stateNode)
 if(items.length===1)summary.append(el('span',t(items[0].summary),'chat-tool-trace-note'))
 summary.title=`${label} · ${toolTraceStateLabel(state)}`
 const list=el('ol',undefined,'chat-tool-trace-items')
 for(const item of items){
  const row=el('li',undefined,'chat-tool-trace-item')
  row.dataset.state=item.state
  const dot=el('span',undefined,'chat-tool-trace-dot')
  dot.dataset.state=item.state
  dot.setAttribute('aria-hidden','true')
  row.append(dot,el('span',toolTraceLabel(item.name),'chat-tool-trace-label'))
  if(item.summary)row.append(el('span',t(item.summary),'chat-tool-trace-note'))
  row.append(el('span',toolTraceStateLabel(item.state),'visually-hidden'))
  list.append(row)
 }
 details.append(summary,list)
 return details
}
