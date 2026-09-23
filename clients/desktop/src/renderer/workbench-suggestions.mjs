const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
/** Renders suggestions after saved records; these cards never become Life objects automatically. */
export function renderSourceSuggestions(panel,{tab,context,sources=[],button,command,continueChat,openSettings}){
 if(!['todos','ideas'].includes(tab))return
 const section=el('section',undefined,'workbench-suggestions');section.setAttribute('aria-label','Nova 的建议');panel.append(section)
 section.append(el('h2','Nova 的建议'))
 const cards=(context?.cards??[]).filter(item=>item.tab===tab).slice(0,3)
 for(const item of cards){const card=el('article',undefined,'card');card.append(el('h3',item.title),el('p',item.body),el('p','来自已授权资料 · 需要你自行判断','hint'));section.append(card)
  if(item.refs?.length){const refs=el('details');refs.append(el('summary','查看依据'));for(const ref of item.refs)refs.append(el('p',ref.label??ref.entry_id));card.append(refs)}
  button('继续讨论',()=>continueChat(`${item.title}：${item.body}`),card)
  button('隐藏',()=>command('context.dismiss',{id:item.id}),card)
 }
 if(cards.length)return
 const empty=el('div',undefined,'workbench-empty');section.append(empty)
 let title='目前没有新的建议',body='你仍可以查询已连接的资料。'
 if(!sources.length){title='还没有连接资料';body='连接后，Nova 才能根据这些资料提供建议。'}
 else if(sources.some(source=>source.scan_pending)){title='正在整理已授权的资料';body='现有记录可以照常使用。'}
 else if(sources.some(source=>source.state==='error')){title='部分资料暂时无法读取';body='已获取的内容仍可使用；可在来源设置查看详情。'}
 else if(context?.status==='working'){title='正在整理建议';body='已有记录可以照常使用。'}
 else if(context?.status==='failed'){title='这次整理没有完成';body='已有记录可以照常使用，稍后会重试。'}
 empty.append(el('h3',title),el('p',body))
 if(!sources.length&&openSettings)button('连接资料',()=>openSettings('connections'),empty)
 else if(sources.some(source=>source.state==='error')&&openSettings)button('查看来源',()=>openSettings('connections'),empty)
}
