import {memoryOverview} from './memory-overview.mjs'
import {PersonalController} from './personal-controller.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node}
export function mountPersonalView({send,start,stop,tasks,taskAction,results,openResults,api}) {
 const root=el('main',undefined,'personal-workspace');root.id='personal-workspace';document.body.prepend(root)
 const header=el('header');header.append(el('strong','✦ Nova'))
 const status=el('span','正在连接','personal-status');header.append(status)
 const button=(label,action,parent=header)=>{const b=el('button',label);b.type='button';b.addEventListener('click',()=>run(action));parent.append(b);return b}
 const error=el('p','','personal-error');error.setAttribute('role','alert')
 const run=async(action)=>{try{c.error='';await action()}catch(e){c.error=e.message;if(/conflict|version/i.test(e.message)&&c.connected)await c.command('state').catch(()=>{})}update()}
 button('连接与权限',()=>{selected='来源';renderPanel()});button('设置',()=>api.orbMenu.openSettings());button('收起',()=>collapse(true))
 const columns=el('div',undefined,'personal-columns');root.append(header,columns)
 const chat=el('section',undefined,'personal-chat');chat.setAttribute('aria-label','对话');columns.append(chat)
 const intro=el('div',undefined,'personal-intro');intro.append(el('h1','有什么需要帮忙？'))
 const history=el('div',undefined,'personal-history');history.setAttribute('role','log');history.append(intro)
 const composer=el('div',undefined,'personal-composer');const draft=el('textarea');draft.placeholder='输入消息…';draft.maxLength=4000;draft.setAttribute('aria-label','消息草稿');draft.rows=3
 draft.addEventListener('input',()=>{c.draft=draft.value});draft.addEventListener('focus',()=>{if(c.mode==='voice')void run(()=>c.text())})
 draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void run(()=>c.submit())}})
 const inputActions=el('div',undefined,'personal-input-actions');const dictate=button('按住说话',()=>{},inputActions)
 dictate.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();dictate.setPointerCapture(e.pointerId);void run(()=>c.dictate())})
 dictate.addEventListener('pointerup',()=>run(()=>c.finish()));dictate.addEventListener('pointercancel',()=>run(()=>c.text()))
 dictate.addEventListener('keydown',e=>{if([' ','Enter'].includes(e.key)&&!e.repeat){e.preventDefault();void run(()=>c.dictate())}})
 dictate.addEventListener('keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();void run(()=>c.finish())}})
 const voice=button('持续对话',()=>c.mode==='voice'?c.text():c.voice(),inputActions);const submit=button('发送 ↑',()=>c.submit(),inputActions);submit.className='primary'
 const hint=el('p','','personal-hint');composer.append(draft,inputActions,hint,error);chat.append(history,composer)
 const side=el('section',undefined,'personal-side');side.setAttribute('aria-label','个人空间');columns.append(side)
 const tabs=el('nav',undefined,'personal-tabs');tabs.setAttribute('aria-label','个人空间视图');const panel=el('div',undefined,'personal-panel');side.append(tabs,panel)
 let selected='动态',ignored=false,debugEvidence=false,renderedSnapshot=null,taskRevision=-1
 const presented=new Set()
 const tabButtons=new Map();for(const title of ['动态','任务','记忆'])tabButtons.set(title,button(title,()=>{selected=title;renderPanel()},tabs))
 const expand=el('button','展开 Nova');expand.id='personal-expand';expand.type='button';expand.addEventListener('click',()=>run(()=>collapse(false)));document.querySelector('#shell').append(expand)
 const c=new PersonalController({send,start,stop,changed:update})
 const chips=(parent,values)=>{const row=el('div',undefined,'personal-chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 const card=(title,summary)=>{const a=el('article',undefined,'personal-card');a.append(el('h3',title));if(summary)a.append(el('p',summary));panel.append(a);return a}
 const continueChat=(text)=>{c.draft=`关于「${text}」：`;update();draft.focus()}
 function evidence(parent,refs,diagnostics=false) {if(!debugEvidence&&!diagnostics)return null;const details=el('details');details.append(el('summary',diagnostics?'同步详情':'查看依据'));for(const ref of refs??[])details.append(el('p',typeof ref==='string'?ref:`${ref.type??'记忆'} · ${ref.ref??ref.entry_id??''}${ref.observed_at?' · '+ref.observed_at:''}`));parent.append(details);return details}
 function renderPanel(){
  panel.replaceChildren();for(const [name,b]of tabButtons)b.setAttribute('aria-current',String(name===selected))
  const s=c.snapshot;const caps=s?.capabilities??{}
  if(selected==='动态'){
   const heading=el('div',undefined,'personal-section-heading');heading.append(el('h2','动态'));button(ignored?'返回当前':'查看已忽略',()=>{ignored=!ignored;renderPanel()},heading);panel.append(heading)
   const feed=(s?.feed??[]).filter(item=>ignored?item.user_state==='dismissed'||item.user_state==='dismiss':item.user_state!=='dismissed'&&item.user_state!=='dismiss')
   if(!feed.length)card(ignored?'没有已忽略的动态':'暂无动态','有新建议时会显示在这里。')
   for(const item of feed){if(!c.collapsed&&!item.delivery?.presented_at&&!presented.has(item.id)){presented.add(item.id);void c.command('feed.action',{id:item.id,action:'presented'}).catch(()=>presented.delete(item.id))}const a=card(item.title,item.why_now);chips(a,[item.kind==='question'?'待回应':'建议',({active:'待处理',resolved:'已完成',invalidated:'已失效'}[item.lifecycle]||item.lifecycle),item.task_ref?'关联任务':null]);evidence(a,[...(item.evidence_refs??[]),...(item.memory_refs??[])])?.addEventListener('toggle',e=>{if(e.target.open)void run(()=>c.command('feed.action',{id:item.id,action:'expand_evidence'}))});const actions=el('div',undefined,'personal-actions');a.append(actions)
    button('接着聊',async()=>{await c.command('feed.action',{id:item.id,action:'open'});continueChat(item.title)},actions)
    if(item.lifecycle==='active'&&!ignored){button('处理',()=>c.command('feed.action',{id:item.id,action:'act'}),actions);button('稍后',()=>c.command('feed.action',{id:item.id,action:'snooze',snooze_until:new Date(Date.now()+3600000).toISOString()}),actions);button('忽略',()=>c.command('feed.action',{id:item.id,action:'dismiss'}),actions)}
   }
  }else if(selected==='任务'){
   panel.append(el('h2','任务'));if(tasks()?.error){const notice=el('p',tasks().error,'personal-error');notice.setAttribute('role','alert');panel.append(notice)}const list=tasks()?.tasks??[];if(!list.length)card('暂无任务','开始对话后可在这里查看任务进展。')
   for(const task of list){const a=card(task.title,task.summary);chips(a,[task.project,{started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}[task.phase]||task.phase,task.executor]);button('接着聊',()=>continueChat(`${task.title} · ${task.work_id}`),a);const active=tasks()?.selected?.work_id===task.work_id;const open=button(active&&tasks()?.opening?'正在打开…':'打开项目',()=>taskAction(task.work_id,'open'),a);open.disabled=active&&tasks()?.opening;if(['started','working'].includes(task.phase)){const cancel=button(active&&tasks()?.cancelling?'正在停止…':'停止任务',()=>taskAction(task.work_id,'cancel'),a);cancel.disabled=active&&tasks()?.cancelling;}if(results().length)button('查看结果',openResults,a)}
   button('任务控制与结果',openResults,panel)
  }else if(selected==='记忆'){
   const entries=(s?.memory?.entries??[]).filter(m=>m.status==='active')
   const overview=memoryOverview(entries,s?.memory?.overview)
   const recordDetails=(parent,items,label)=>{
    const records=el('details',undefined,'memory-group-details');records.append(el('summary',label));parent.append(records)
    for(const entry of items){
     const a=el('article',undefined,'memory-entry-details');a.append(el('h4',entry.topic||entry.content?.slice(0,48)||'记忆'));a.append(el('p',entry.content));chips(a,[entry.origin==='stated'?'你说过':'根据资料',entry.confidence_note]);evidence(a,entry.source_refs);records.append(a)
     const correction=el('textarea');correction.value=entry.content;correction.maxLength=500;correction.setAttribute('aria-label','纠正记忆内容');correction.hidden=true;a.append(correction)
     const edit=button('纠正',async()=>{if(correction.hidden){correction.hidden=false;correction.focus();edit.textContent='保存纠正';return}await c.command('memory.correct',{id:entry.id,expected_version:entry.version,content:correction.value})},a);edit.disabled=!caps.memory?.correct||entry.version==null;edit.title=edit.disabled?'当前后端不支持版本化纠正':''
     const forget=button('忘记',()=>c.command('memory.forget',{id:entry.id,expected_version:entry.version}),a);forget.disabled=!caps.memory?.forgetEntry||entry.version==null;forget.title=forget.disabled?'当前后端不支持按条目忘记':'';button('接着聊',()=>continueChat(entry.content),a)
    }
    return records
   }
   if(!caps.memory?.list)card('当前后端不支持记忆列表','连接支持此能力的记忆后端后可查看。')
   else {
    const hero=card('记忆');hero.classList.add('memory-hero')
    hero.append(el('p',overview.summary,'memory-overview-copy'))
    if(!overview.generated&&entries.length)hero.append(el('p','摘要尚未生成，先显示已保存的内容。','personal-hint'))
    if(debugEvidence)hero.append(el('p',overview.coverage,'memory-coverage'))
    for(const group of overview.groups){
     const a=card(group.title,group.summary);a.classList.add('memory-group')
     chips(a,group.keywords)
     if(debugEvidence)recordDetails(a,group.entries,'相关记录')
    }
    if(entries.length){const a=el('div',undefined,'memory-records');panel.append(a);recordDetails(a,entries,'管理记忆')}
   }
   if(s?.memory?.cursor)button('下一页',()=>c.command('memory.list',{cursor:s.memory.cursor,limit:50}),panel)
   if(caps.memory?.list)button('返回第一页',()=>c.command('memory.list',{limit:50}),panel)
  }else{
   panel.append(el('h2','连接与权限'),el('p','只读取你授权的目录。正文可能交由设置中的模型服务处理；读取权限不授予修改或发送权限。','personal-hint'))
   const debug=el('details',undefined,'personal-debug');debug.append(el('summary','调试'));const debugLabel=el('label',undefined,'personal-consent');const debugCheck=el('input');debugCheck.type='checkbox';debugCheck.checked=debugEvidence;debugLabel.append(debugCheck,document.createTextNode('显示来源与依据'));debug.append(debugLabel);panel.append(debug);debugCheck.addEventListener('change',()=>{debugEvidence=debugCheck.checked;renderPanel()})
   const consent=el('label',undefined,'personal-consent');const check=el('input');check.type='checkbox';consent.append(check,document.createTextNode('允许后台读取所选目录并用于检索与建议'));panel.append(consent)
   const add=button('选择并授权目录',async()=>{const path=await api.personal.chooseDirectory();if(path)await c.command('sources.add',{path,consent:true})},panel);add.disabled=true;check.addEventListener('change',()=>{add.disabled=!check.checked||!caps.sources})
   if(!caps.sources)panel.append(el('p','来源服务不可用，请先在设置中启用知识库。','personal-hint'))
   for(const source of s?.sources??[]){const a=card(source.path);chips(a,[{connected:'已连接',paused:'已暂停',disconnected:'已断开',error:'异常'}[source.state]||source.state,`扫描 ${source.scanned}`,`本次读取正文 ${source.read}`,`跳过 ${source.skipped}`]);a.append(el('p',`上次同步：${source.last_sync??'尚未同步'}`));evidence(a,[`排除：${(source.excludes??[]).join('、')}`,`跳过原因：${JSON.stringify(source.reasons??{})}`,...(source.failures??[]).map(f=>`${f.path} · ${f.code}`)],true)
    if(source.state!=='disconnected')for(const [label,method]of [[source.state==='paused'?'恢复同步':'暂停同步',source.state==='paused'?'resume':'pause'],['立即同步','sync'],['断开（保留数据）','disconnect']])button(label,()=>c.command(`sources.${method}`,{id:source.id}),a)
    else a.append(el('p','已停止访问；重新授权连接暂不支持。'))
    const deletion=el('div');deletion.hidden=true;deletion.setAttribute('role','group');deletion.setAttribute('aria-label','确认删除来源数据');deletion.append(el('p',`确认删除「${source.path}」的索引与来源记录？依赖此来源的记忆和建议也会更新或撤回；不会删除磁盘原文件。`))
    button('确认删除来源数据',()=>c.command('sources.delete',{id:source.id}),deletion);button('取消删除',()=>{deletion.hidden=true},deletion)
    button('删除来源数据',()=>{deletion.hidden=false;deletion.querySelector('button').focus()},a);a.append(deletion)
   }
   const discovery=card('主动发现','有依据才提出建议。关闭后仍可主动交办任务。');const select=el('select');select.setAttribute('aria-label','主动发现间隔');for(const [value,label]of [['0','关闭'],['15','每 15 分钟'],['30','每 30 分钟'],['60','每小时'],['120','每两小时']]){const option=el('option',label);option.value=value;select.append(option)}select.value=s?.settings?.discovery_enabled?String(s.settings.discovery_interval_minutes):'0';select.disabled=!caps.discovery;select.addEventListener('change',()=>run(()=>c.command('discovery.configure',{enabled:select.value!=='0',...(select.value!=='0'?{interval_minutes:Number(select.value)}:{})})));discovery.append(select)
  }
  for(const b of panel.querySelectorAll('button'))if(!c.connected)b.disabled=true
 }
 function update(){
  document.body.dataset.personalCollapsed=String(c.collapsed);status.textContent=c.connected?`运行中 · ${(tasks()?.tasks??[]).filter(t=>['started','working'].includes(t.phase)).length} 个后台任务`:'已断开 · 草稿保留'
  if(draft.value!==c.draft)draft.value=c.draft
  draft.disabled=!c.connected||!c.inputInstance||Boolean(c.submittedRequestId)||!c.capabilities.includes('text_input');submit.disabled=draft.disabled||Boolean(c.submittedRequestId)||['starting','dictation','transcribing'].includes(c.mode)
  dictate.disabled=!c.connected||!c.capabilities.includes('dictation')||c.mode==='transcribing';voice.disabled=!c.connected||c.mode==='starting';voice.textContent=c.mode==='voice'?'结束持续对话':'持续对话';voice.setAttribute('aria-pressed',String(c.mode==='voice'))
  hint.textContent=c.submittedRequestId?'正在确认发送状态…':!c.capabilities.includes('text_input')?'当前模式不支持文字，请在设置中切换为级联模式。':c.mode==='dictation'?'正在录音 · 松开后生成可编辑草稿':c.mode==='transcribing'?'正在识别，草稿不会自动发送':c.mode==='voice'?'持续对话中 · 点击输入框回到文字':'Enter 发送 · Shift + Enter 换行 · 按住说话仅生成草稿'
  error.textContent=c.error;error.hidden=!c.error
  expand.textContent=`展开 Nova${(c.snapshot?.feed??[]).filter(f=>f.lifecycle==='active'&&f.user_state==='new').length?' · 有新动态':''}`
  if(renderedSnapshot!==c.snapshot||taskRevision!==JSON.stringify(tasks())){renderedSnapshot=c.snapshot;taskRevision=JSON.stringify(tasks());renderPanel()}
 }
 async function collapse(value){c.collapse(value);await api.personal.setCollapsed(value)}
 let captionKey=null,captionNode=null
 function receive(frame){
  c.receive(frame)
  if(frame.type==='caption'&&typeof frame.text==='string'){
   if(frame.text){
    const key=`${frame.role}:${frame.turn_id??''}`
    if(key!==captionKey||!captionNode){captionNode=el('article',undefined,`personal-message ${frame.role==='user'?'user':'assistant'}`);captionNode.append(el('small',frame.role==='user'?'你':'Nova'),el('p'));history.append(captionNode);captionKey=key}
    captionNode.querySelector('p').textContent=frame.text;history.scrollTop=history.scrollHeight
   }
   if(frame.final){captionNode=null;captionKey=null}
  }
  if(frame.type==='executor.tasks')renderPanel()
 }

 api.personal.onCollapsed?.(value=>c.collapse(value));update();renderPanel();return {controller:c,receive,refresh:update}
}
