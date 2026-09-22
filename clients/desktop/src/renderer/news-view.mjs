const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
export function renderNews(panel,{news,command,button,local,rerender,profile,openArticle,openSettings}){
 panel.append(el('h2','Feeds · 为你发现'),el('p','根据你确认的兴趣筛选公开资讯。标题和摘录来自订阅源，点击查看原文。'))
 button('编辑兴趣',profile,panel)
 if(!news?.enabled){const notice=el('p','资讯获取已关闭。在 Profile 中启用后可更新；已有收藏和缓存仍可阅读。');notice.className='hint';panel.append(notice);if(openSettings)button('前往设置',()=>openSettings('connections'),panel);if(!news)return}
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
  const conversionKey='convert:'+item.id,draft=local[conversionKey]
  if(!draft)button('转为个人事项',()=>{local[conversionKey]={id:item.id,content_hash:item.content_hash,kind:'idea',title:item.title.slice(0,200),note:''};rerender()},card)
  else{
   const form=el('div');form.className='life-form';card.append(form)
   form.append(el('p','把这篇资讯作为参考，写下你自己的想法、目标或待办。保存不会授权 Nova 执行。'))
   const select=el('select');select.setAttribute('aria-label','个人事项类型');for(const [value,label]of [['idea','想法'],['todo','待办'],['goal','目标']]){const option=el('option',label);option.value=value;select.append(option)}select.value=draft.kind;select.addEventListener('change',()=>{draft.kind=select.value});form.append(select)
   for(const [key,label,tag,limit]of [['title','个人事项标题','input',200],['note','我的补充说明','textarea',4000]]){const wrapper=el('label',label),input=el(tag);input.value=draft[key];input.maxLength=limit;input.setAttribute('aria-label',label);input.addEventListener('input',()=>{draft[key]=input.value});wrapper.append(input);form.append(wrapper)}
   if(draft.content_hash!==item.content_hash)form.append(el('p','资讯已更新，请取消后重新打开转换。'))
   const save=button('保存个人事项',async()=>{await command('news.convert',{...draft});delete local[conversionKey];rerender()},form);save.disabled=draft.content_hash!==item.content_hash
   button('取消转换',()=>{delete local[conversionKey];rerender()},form)
  }
  for(const match of item.ranking?.matches??[]){const interest=news.interests.find(i=>i.id===match.interest_id);if(!interest)continue
   button(`多看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.min(2,interest.weight+0.5)}),card)
   button(`少看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.max(0,interest.weight-0.5)}),card)
  }
 }
}
