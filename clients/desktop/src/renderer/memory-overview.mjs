const sourceNames={conversation:'对话',file:'文件',mail:'邮件',calendar:'日历',task:'任务'}
const kindNames={fact:'已知信息',preference:'偏好',plan:'计划',concern:'关注事项'}
/** Summarize only explicit projection fields; topic names never imply a person's identity. */
export function memoryOverview(entries) {
 const active=entries.filter(entry=>entry.status==='active')
 const topics=[...new Set(active.map(entry=>entry.topic).filter(Boolean))]
 const sources=[...new Set(active.flatMap(entry=>entry.source_refs??[]).map(source=>sourceNames[source.type]).filter(Boolean))]
 const sourceCount=new Set(active.flatMap(entry=>entry.source_refs??[]).map(source=>`${source.type}:${source.ref}`)).size
 const groups=['fact','preference','plan','concern'].flatMap(kind=>{
  const items=active.filter(entry=>entry.kind===kind)
  if(!items.length)return []
  const groupTopics=[...new Set(items.map(entry=>entry.topic).filter(Boolean))]
  const lead=`${groupTopics.length} 个主题 · ${items.length} 条记录`
  return [{kind,label:kindNames[kind],entries:items,topics:groupTopics,lead}]
 })
 const stated=active.filter(entry=>entry.origin==='stated').length
 const coverage=`本页 ${active.length} 条 · ${sourceCount} 处${sources.join('、')||'已记录'}来源`
 const summary=topics.length?`涉及 ${topics.slice(0,3).join('、')}${topics.length>3?` 等 ${topics.length} 个主题`:''}。${stated?`${stated} 条来自你说过的内容。`:''}`:active.length?'':'暂无记忆。'

 return {topics,sources,sourceCount,groups,stated,coverage,summary}
}
