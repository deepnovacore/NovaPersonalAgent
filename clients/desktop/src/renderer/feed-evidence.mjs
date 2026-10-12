import {attachSources} from './source-popover.mjs'
import {t} from './locale.mjs'
/** Read excerpts on demand through the host; reference IDs are never interpreted as item identities. */
export function attachFeedEvidence(card,item,{el,button,command,memory=[],connected=true,currentItem=()=>item}){
 const memoryRefs=item.memory_refs??[],entries=memoryRefs.map(ref=>memory.find(entry=>entry.id===ref.entry_id&&entry.version===ref.version&&entry.status==='active'))
 const refs=[...new Set([...(item.evidence_refs??[]),...(item.prepared?.evidence_refs??[]),...entries.flatMap(entry=>entry?.evidence_refs??[])])]
 if(!refs.length&&!memoryRefs.length)return
 const available=()=>{const current=currentItem();return current&&current.updated_at===item.updated_at&&current.lifecycle!=='invalidated'}
 const details=attachSources(card,[t('{0} 条原文引用 · {1} 条记忆引用',refs.length,memoryRefs.length)],{title:t('建议依据')})
 if(item.lifecycle==='invalidated'){details.popover.append(el('p',t('依据已变化，这条建议已失效。')));return details}
 for(const [index,ref]of memoryRefs.entries()){
  const entry=entries[index],record=el('div',undefined,'feed-memory-reference')
  record.append(el('strong',t('记忆引用 · 版本 {0}',ref.version)),el('p',entry?entry.content:t('这条记忆已变化或尚未载入。')));details.popover.append(record)
 }
 if(refs.length>16)details.popover.append(el('p',t('显示前 16 条原文引用。'),'hint'))
 for(const [index,ref]of refs.slice(0,16).entries()){
  const row=el('div',undefined,'feed-evidence-row'),excerpt=el('p','', 'feed-evidence-excerpt'),status=el('p',connected?'':t('连接后可读取原文。'),'hint');status.setAttribute('role','status')
  row.append(el('strong',t('原文 {0}',index+1)));details.popover.append(row)
  let loading=false
  const read=button(t('查看原文节选'),async()=>{
   if(loading||!connected||!available())return
   loading=true;read.disabled=true;excerpt.textContent='';status.textContent=t('正在读取依据…')
   try{
    const result=await command('memory.evidence',{evidence_id:ref})
    if(row.isConnected===false||!available())return
    const evidence=result?.evidence
    const valid=result?.state==='ok'&&evidence?.evidence_id===ref&&typeof evidence.text==='string'
    excerpt.textContent=valid?evidence.text:'';status.textContent=valid?'':t(result?.state==='gone'?'原文已移除或当前不可读取。':'暂时无法读取原文，请稍后重试。')
   }catch{if(row.isConnected!==false&&available())status.textContent=t('暂时无法读取原文，请稍后重试。')}
   finally{loading=false;read.disabled=!connected||!available()}
  },row,`feed-evidence:${item.id}:${ref}`)
  read.className='feed-evidence-read';read.disabled=!connected;row.append(status,excerpt)
 }
 return details
}
