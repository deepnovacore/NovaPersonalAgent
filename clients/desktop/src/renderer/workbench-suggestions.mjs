const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
/** Renders the Todo recap and grounded suggestions; these cards never become Life objects automatically. */
export function renderSourceSuggestions(panel,{tab,context,sources=[],button,command,continueChat,delegate=continueChat,openSettings,connected=true}){
 if(!['todos','ideas'].includes(tab))return
 const projects=tab==='todos'?(context?.recap?.projects??[]).slice(0,4):[]
 if(tab==='todos'&&(context?.recap?.text||projects.length)){
  const recap=el('section',undefined,'workbench-recap');recap.setAttribute('aria-label','近况');panel.append(recap)
  recap.append(el('h2','近况'))
  if(context.recap.text)recap.append(el('p',context.recap.text))
  if(projects.length){const list=el('ul');for(const project of projects)list.append(el('li',`${project.name} · ${project.line}`));recap.append(list)}
 }
 const heading=tab==='todos'?'值得关注':'Nova 的建议'
 const section=el('section',undefined,'workbench-suggestions');section.setAttribute('aria-label',heading);panel.append(section)
 section.append(el('h2',heading))
 const cards=(context?.cards??[]).filter(item=>item.tab===tab).slice(0,3)
 for(const item of cards){const card=el('article',undefined,'card');card.append(el('h3',item.title));section.append(card)
  if(tab==='todos'&&(item.why||item.next)){if(item.why)card.append(el('p',item.why));if(item.next)card.append(el('p',`下一步：${item.next}`,'workbench-next'))}
  else card.append(el('p',item.body))
  if(item.refs?.length){const refs=el('details');refs.append(el('summary','查看依据'));for(const ref of item.refs)refs.append(el('p',ref.label??ref.entry_id));card.append(refs)}
  if(tab==='todos'&&item.next)button('交给 Nova',()=>delegate(`请帮我推进「${item.title}」：${item.next}`),card)
  else button('继续讨论',()=>continueChat(`${item.title}：${item.body}`),card)
  button('隐藏',()=>command('context.dismiss',{id:item.id}),card)
 }
 const failed=sources.filter(source=>source.state==='error'),sourceName=source=>source.scope==='computer'?'整机资料':source.path?.split(/[\\/]/u).filter(Boolean).pop()??'已连接目录'
 if(cards.length){if(failed.length){const note=el('p',`${failed.map(sourceName).join('、')}尚未读完；已显示可用内容。`,'hint');section.append(note);if(openSettings)button('查看来源',()=>openSettings('connections'),section)}return}
 const empty=el('div',undefined,'workbench-empty');section.append(empty)
 const reason=context?.empty_reasons?.[tab]??context?.empty_reason
 let title='目前没有新的建议',body='你仍可以查询已连接的资料。'
 if(!sources.length&&!connected){title='资料来源状态暂不可用';body='工作台连接后，可以查看已连接的资料和建议。'}
 else if(!sources.length){title='还没有连接资料';body='连接后，Nova 才能根据这些资料提供建议。'}
 else if(sources.every(source=>source.state==='paused'||source.state==='disconnected')){title='资料来源已暂停';body='恢复来源后，Nova 才会继续读取。'}
 else if(sources.some(source=>source.processing_consent_required)&&context?.candidate_count===0){title='资料还不能用于生成建议';body='可在来源设置中检查处理授权。'}
 else if(failed.length){title=`${failed.map(sourceName).join('、')}暂时无法完整读取`;body='已获取的内容仍可使用；可在来源设置查看详情。'}
 else if(context?.status==='working'){title='正在整理建议';body='已有记录可以照常使用。'}
 else if(context?.status==='failed'){title='这次整理没有完成';body='已有记录可以照常使用，稍后会重试。'}
 else if(tab==='todos'&&reason==='digests_pending'){title='正在读取近期项目';body='整理好后会在这里显示近况和建议。'}
 else if(sources.some(source=>source.scan_pending&&source.state==='connected')){title='正在整理已授权的资料';body='现有记录可以照常使用。'}
 else if(reason==='model_abstained'){title='目前没有新的建议';body='已整理当前可用资料，没有足够明确的建议。'}
 else if(reason==='no_eligible_sources'){title='目前没有新的建议';body='当前资料中还没有适合放到这里的内容。'}
 empty.append(el('h3',title),el('p',body))
 if(!sources.length&&openSettings)button('连接资料',()=>openSettings('connections'),empty)
 else if(sources.some(source=>source.state==='error'||source.processing_consent_required)&&openSettings)button('查看来源',()=>openSettings('connections'),empty)
}
