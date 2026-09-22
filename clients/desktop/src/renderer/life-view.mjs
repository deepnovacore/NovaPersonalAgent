const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
const labels={todo:'待办',idea:'想法',goal:'目标'}
const statuses={todo:{open:'待办',doing:'进行中',waiting:'等待他人',done:'已完成',cancelled:'已取消'},idea:{active:'保留',archived:'已归档'},goal:{active:'推进中',paused:'已暂停',completed:'已达成',archived:'已归档'}}
export function renderLife(panel,{kind,state,command,button,local,rerender,delegate,openArticle,run=action=>action()}){
 const rows=state?.[kind==='todo'?'todos':kind==='idea'?'ideas':'goals']??[]
 panel.append(el('h2',`${{todo:'Todos',idea:'Ideas',goal:'Goals'}[kind]} · ${labels[kind]}`))
 panel.append(el('p',{todo:'自己要做的事、正在等待的事。需要协助时再交给 Nova。',idea:'先保存想法；准备行动时，再转成待办或目标。',goal:'记录方向和成功标准，用关联待办追踪行动。'}[kind]))
 const formKey=kind+':form';const draft=local[formKey]??={title:'',note:'',goal_id:'',due:'',success_criteria:''}
 const field=(parent,key,label,multiline=false)=>{const wrapper=el('label',label),input=el(multiline?'textarea':'input');input.value=draft[key]??'';input.maxLength=key==='title'?200:key==='success_criteria'?2000:4000;input.setAttribute('aria-label',label);if(key==='due')input.type='date';input.addEventListener('input',()=>{draft[key]=input.value});wrapper.append(input);parent.append(wrapper);return input}
 const openKey=kind+':formOpen',formOpen=Boolean(local[openKey])||Boolean(draft.id)
 button(formOpen&&!draft.id?'收起表单':`添加${labels[kind]}`,()=>{local[openKey]=!formOpen;if(!local[openKey])delete local[formKey];rerender()},panel).className='page-add'
 const form=el('div');form.className='life-form';form.hidden=!formOpen;panel.append(form)
 field(form,'title',`${labels[kind]}标题`);field(form,'note',kind==='goal'?'为什么重要':'补充说明',true)
 if(kind==='todo')field(form,'due','到期日期')
 if(kind==='goal')field(form,'success_criteria','怎样算达成',true)
 else{const wrapper=el('label','关联目标'),select=el('select');select.setAttribute('aria-label','关联目标');for(const g of [{id:'',title:'不关联'},...(state?.goals??[])]){const opt=el('option',g.title);opt.value=g.id;select.append(opt)}select.value=draft.goal_id??'';select.addEventListener('change',()=>{draft.goal_id=select.value});wrapper.append(select);form.append(wrapper)}
 button(draft.id?'保存修改':'保存',async()=>{const params={op:draft.id?'update':'create',kind,title:draft.title,note:draft.note};if(draft.id)Object.assign(params,{id:draft.id,expected_version:draft.version});if(kind==='todo')params.due=draft.due||null;if(kind==='goal')params.success_criteria=draft.success_criteria;else params.goal_id=draft.goal_id||null;await command('life.mutate',params);delete local[formKey];delete local[openKey];rerender()},form)
 if(draft.id)button('取消编辑',()=>{delete local[formKey];delete local[openKey];rerender()},form)
 button(local[kind+':all']?'隐藏已完成／归档':'显示已完成／归档',()=>{local[kind+':all']=!local[kind+':all'];rerender()},panel)
 const visible=rows.filter(r=>local[kind+':all']||!['done','cancelled','archived','completed'].includes(r.status))
 if(!visible.length)panel.append(el('p',`暂无${labels[kind]}，可以从上方添加。`))
 for(const row of visible){const card=el('article');card.className='personal-card';card.dataset.lifeId=row.id;card.append(el('h3',row.title),el('p',row.note));panel.append(card)
  if(row.news_source){card.append(el('p',`由你从公开资讯保存：${row.news_source.title}`),el('p',row.news_source.url));if(openArticle)button('查看资讯原文',()=>openArticle(row.news_source.url),card)}
  if(row.due)card.append(el('p',`到期：${row.due}`))
  if(row.goal_id)card.append(el('p',`目标：${state.goals.find(g=>g.id===row.goal_id)?.title??'不可用'}`))
  if(row.idea_id)card.append(el('p',`来自想法：${state.ideas.find(i=>i.id===row.idea_id)?.title??'不可用'}`))
  if(kind==='goal'){card.append(el('p',`达成标准：${row.success_criteria||'尚未填写'}`),el('p',row.progress.total?`行动进度：${row.progress.done}/${row.progress.total}（不含已取消待办；目标是否达成由你确认）`:'尚未关联待办；不代表目标已达成'))}
  const select=el('select');select.setAttribute('aria-label',`${row.title}状态`);for(const [value,label]of Object.entries(statuses[kind])){const opt=el('option',label);opt.value=value;select.append(opt)}select.value=row.status;select.addEventListener('change',()=>{const value=select.value;select.value=row.status;void run(()=>command('life.mutate',{op:'update',kind,id:row.id,expected_version:row.version,status:value}))});card.append(select)
  button('编辑',()=>{local[formKey]={...row};rerender()},card)
  if(kind==='idea'){const converted=[...(state?.todos??[]),...(state?.goals??[])].filter(r=>r.idea_id===row.id);for(const target of ['todo','goal']){const existing=converted.find(r=>r.kind===target);if(existing)card.append(el('p',`已转为${labels[target]}：${existing.title}`));else if(row.status!=='archived')button(`转为${labels[target]}`,()=>command('life.mutate',{op:'convert',id:row.id,target,expected_version:row.version}),card)}}
  if(kind==='todo'&&!['done','cancelled'].includes(row.status))button('请 Nova 协助',()=>delegate(`请帮我处理待办「${row.title}」。${row.note}。先和我确认处理方式。`),card)
 }
}
export function renderProfile(panel,{state,news,command,button,local,rerender}){
 panel.append(el('h2','Profile · 关于我'),el('p','由你明确填写的信息；新闻阅读和收藏不会自动改写这里。'))
 const draft=local.profile??={about:state?.profile?.about??'',version:state?.profile?.version??0}
 const about=el('textarea');about.value=draft.about;about.maxLength=4000;about.setAttribute('aria-label','关于我');about.addEventListener('input',()=>{draft.about=about.value});panel.append(about)
 button('保存个人介绍',async()=>{await command('life.mutate',{op:'profile',expected_version:draft.version,about:draft.about});delete local.profile;rerender()},panel)
 panel.append(el('h3','资讯兴趣'),el('p','一行一个主题，最多 8 个。只把这些主题与公开新闻摘要发送给推荐模型。'))
 const interestDraft=local.interests??={text:(news?.interests??[]).map(i=>i.text).join('\n'),enabled:news?.enabled??false,explore:news?.explore??true,version:news?.profile_version??0}
 const interests=el('textarea');interests.value=interestDraft.text;interests.setAttribute('aria-label','资讯兴趣');interests.maxLength=808;interests.addEventListener('input',()=>{interestDraft.text=interests.value});panel.append(interests)
 for(const [key,label]of [['enabled','启用资讯获取与推荐'],['explore','允许少量探索内容']]){const wrapper=el('label',label),input=el('input');input.type='checkbox';input.checked=interestDraft[key];input.addEventListener('change',()=>{interestDraft[key]=input.checked});wrapper.append(input);panel.append(wrapper)}
 button('保存兴趣与开关',async()=>{await command('news.configure',{interests:interestDraft.text.split('\n').map(s=>s.trim()).filter(Boolean),enabled:interestDraft.enabled,explore:interestDraft.explore,expected_version:interestDraft.version});delete local.interests;rerender()},panel)
 for(const interest of news?.interests??[]){const row=el('p',`${interest.text} · 推荐权重 ${interest.weight}`);button('恢复默认权重',()=>command('news.action',{action:'weight',interest_id:interest.id,value:1}),row);panel.append(row)}
}
