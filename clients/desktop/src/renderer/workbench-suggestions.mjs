import {renderSourceStatus} from './source-status.mjs'
import {t} from './locale.mjs'
import {attachSources,attachSourceTags} from './source-popover.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
/** Renders grounded suggestions; these cards never become Life objects automatically, and a goal suggestion is saved only when the user adopts it. */
export function renderSourceSuggestions(panel,{tab,context,sources=[],button,command,continueChat,openSettings,openArticle,connected=true,everConnected=true,startupFailed=false,clampable}){
 if(!['ideas','goals'].includes(tab))return
 // The goal list above has its own empty state; a goal suggestion appears only when there is one.
 if(tab==='goals'&&!context?.daily&&!(context?.cards??[]).some(item=>item.tab==='goals'))return
 const heading=tab==='goals'?t('可以定下的方向'):t('我想到的')
 const section=el('section',undefined,'workbench-suggestions');section.setAttribute('aria-label',heading);panel.append(section)
 section.append(el('h2',heading))
 if(context?.daily){section.append(el('p',context.automatic_available?t('每天共同整理一次想法和目标。'):t('今天已自动整理，新的资料会在下一轮更新。'),'hint'));button(context.status==='working'?t('正在整理…'):t('重新整理'),()=>command('context.refresh',{}),section,'context:refresh')}
 const cards=(context?.cards??[]).filter(item=>item.tab===tab).slice(0,3)
 for(const item of cards){const card=el('article',undefined,'card');card.append(el('h3',item.title));section.append(card)
  const body=el(clampable?'button':'p',item.body,clampable?'card-body':undefined)
  if(clampable)clampable(body,item.id,item.title)
  card.append(body)
  if(item.next)card.append(el('p',tab==='goals'?t('先从：{0}',item.next):t('下一步：{0}',item.next),'workbench-next'))
  if(!attachSourceTags(card,item.sources,{openArticle}))attachSources(card,item.refs?.map(ref=>ref.label).filter(Boolean))
  const actions=el('div',undefined,'card-actions');card.append(actions)
  if(item.update)button(t('更新原记录'),()=>command('context.adopt',{id:item.id}),actions,`suggestion:${item.id}`)
  if(tab==='ideas'&&context?.daily)button(t('保存想法'),()=>command('context.adopt',{id:item.id}),actions,`suggestion:${item.id}`)
  if(tab==='goals'&&!item.update)button(t('设为目标'),()=>command('context.adopt',{id:item.id}),actions,`suggestion:${item.id}`)
  else button(t('聊聊这个'),()=>continueChat(`${item.title}：${item.body}`),actions,`suggestion:${item.id}`)
  button(t('隐藏'),()=>command('context.dismiss',{id:item.id}),actions,`suggestion:${item.id}`).className='quiet'
 }
 const failed=sources.filter(source=>source.state==='error'),sourceName=source=>source.scope==='computer'?t('整机资料'):source.path?.split(/[\\/]/u).filter(Boolean).pop()??t('已连接目录')
 renderSourceStatus(section,{sources,status:context?.status,el,button,openSettings})
 if(cards.length)return
 const empty=el('div',undefined,'workbench-empty');section.append(empty)
 const reason=context?.empty_reasons?.[tab]??context?.empty_reason
 let title=t('暂时没什么要提的'),body=t('想查资料里的东西，直接问我就行。')
 // Before the first connection this is ordinary startup, not an outage.
 if(!sources.length&&!connected&&!everConnected&&!startupFailed){title=t('正在连接后台');body=t('连上之后，我就来看看你的资料。')}
 else if(!sources.length&&!connected){title=t('暂时连不上后台');body=t('连上之后，我再看看你的资料。')}
 else if(!sources.length&&!context?.daily){title=t('还没给我看过资料');body=t('连一个文件夹进来，我读过之后就能帮你理出要做的事。')}
 else if(sources.length&&sources.every(source=>source.state==='paused'||source.state==='disconnected')){title=t('资料来源已暂停');body=t('恢复之后我再接着读。')}
 else if(sources.some(source=>source.processing_consent_required)&&context?.candidate_count===0){title=t('这些资料我还不能用');body=t('去来源设置里看看处理授权，允许之后我再读。')}
 else if(failed.length){title=t('{0}有一部分没读到',failed.map(sourceName).join(t('、')));body=t('读到的部分照常能用，详情在来源设置里。')}
 else if(context?.status==='working'){title=t('我在看你的资料');body=t('稍等一下，已有的记录照常能用。')}
 else if(context?.status==='failed'){title=t('这次没整理完');body=t('我过一会儿再试，已有的记录照常能用。')}
 else if(sources.some(source=>source.scan_pending&&source.state==='connected')){title=t('资料索引仍在更新');body=t('已有内容可以继续查看，新资料整理后会出现在这里。')}
 else if(reason==='validation_filtered'){title=t('这次没有可靠的结果');body=t('生成的内容没有通过来源校验，可以稍后重新整理。')}
 else if(reason==='model_abstained'){title=t('暂时没什么要提的');body=t('资料我都看过了，没找到有把握的建议。')}
 else if(reason==='no_eligible_sources'){title=t('暂时没什么要提的');body=t('现有的资料里还没有适合放这里的事。')}
 empty.append(el('h3',title),el('p',body))
 if(!sources.length&&!context?.daily&&connected&&openSettings)button(t('连接资料'),()=>openSettings('connections'),empty)
 else if(sources.some(source=>source.state==='error'||source.processing_consent_required)&&openSettings)button(t('查看来源'),()=>openSettings('connections'),empty)
}
