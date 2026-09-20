const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
export function renderNews(panel,{news,command,button,local,rerender,profile,openArticle}){
 panel.append(el('h2','Feeds · 为你发现'),el('p','根据你确认的兴趣筛选公开资讯。标题和摘录来自订阅源，点击查看原文。'))
 button('编辑兴趣',profile,panel)
 if(!news?.enabled){panel.append(el('p','资讯获取已关闭。在 Profile 中启用后可更新；已有收藏和缓存仍可阅读。'));if(!news)return}
 const refresh=button(!news.enabled?'已暂停获取':news.refreshing?'正在更新…':'刷新资讯',()=>command('news.refresh'),panel);refresh.disabled=news.refreshing||!news.enabled
 panel.append(el('p',`${news.mode==='personalized'?'兴趣推荐':'时间线（暂无可用个性化评分）'} · ${news.pending} 条待评分${news.rank_error?' · 部分评分未成功，保留已完成推荐，可刷新重试':''}`))
 button(local.saved?'返回推荐':'查看收藏',()=>{local.saved=!local.saved;rerender()},panel)
 const sources=el('details');sources.append(el('summary','来源与同步状态'));panel.append(sources)
 for(const source of news.sources){const row=el('div');row.append(el('p',`${source.name} · ${source.blocked?'已屏蔽':source.error?'获取失败：'+source.error:source.last_success?'最近成功：'+new Date(source.last_success).toLocaleString():'尚未获取'} · ${source.count??0} 条`));button(source.blocked?'恢复来源':'屏蔽来源',()=>command('news.action',{action:'block',source_id:source.id,value:!source.blocked}),row);sources.append(row)}
 const items=local.saved?news.saved:news.items
 if(!items.length)panel.append(el('p',local.saved?'尚未收藏资讯。':'暂无可展示资讯。请检查来源状态，或稍后刷新。'))
 for(const item of items){const card=el('article');card.className='personal-card news-card';card.dataset.articleId=item.id;panel.append(card)
  card.append(el('small',`${news.sources.find(s=>s.id===item.source_id)?.name??item.source_id} · ${item.published_at?new Date(item.published_at).toLocaleString():'来源未提供发布时间'}${item.read?' · 已读':''}${item.exploration?' · 探索':''}`),el('h3',item.title));const excerpt=el('p',item.summary);excerpt.className='news-excerpt';card.append(excerpt)
  if(item.ranking?.reason)card.append(el('p',`推荐理由：${item.ranking.reason}`))
  const evidence=el('details');evidence.append(el('summary','推荐依据'));for(const m of item.ranking?.matches??[])evidence.append(el('p',`${news.interests.find(i=>i.id===m.interest_id)?.text??''}：${m.quote}`));card.append(evidence)
  button('阅读原文',async()=>{await openArticle(item.url);await command('news.action',{action:'read',id:item.id,value:true})},card)
  button(item.saved?'取消收藏':'收藏',()=>command('news.action',{action:'save',id:item.id,value:!item.saved}),card)
  for(const match of item.ranking?.matches??[]){const interest=news.interests.find(i=>i.id===match.interest_id);if(!interest)continue
   button(`多看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.min(2,interest.weight+0.5)}),card)
   button(`少看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.max(0,interest.weight-0.5)}),card)
  }
 }
}
