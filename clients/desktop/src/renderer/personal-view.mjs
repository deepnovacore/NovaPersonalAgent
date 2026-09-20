import {renderLife,renderProfile} from './life-view.mjs'
import {renderNews} from './news-view.mjs'
import {renderConnectors} from './connectors-view.mjs'
import {renderDailyBrief} from './daily-brief-view.mjs'
import {memoryOverview} from './memory-overview.mjs'
import {PersonalController} from './personal-controller.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node}
export function mountPersonalView({send,start,stop,tasks,taskAction,results,openResults,api}) {
 const connectorLocal={}
 const lifeLocal={},newsLocal={}
 const readMessages=new Set();let unreadProjection=null
 const root=el('main',undefined,'personal-workspace');root.id='personal-workspace';document.body.prepend(root)
 const header=el('header');header.append(el('strong','✦ Nova'))
 const status=el('span','正在连接','personal-status');header.append(status)
 const button=(label,action,parent=header)=>{const b=el('button',label);b.type='button';b.addEventListener('click',()=>run(action));parent.append(b);return b}
 const error=el('p','','personal-error');error.setAttribute('role','alert')
 const run=async(action)=>{try{c.error='';await action()}catch(e){c.error=e.message;if(/conflict|version/i.test(e.message)&&c.connected)await c.command('state').catch(()=>{})}update()}
 button('主动提醒',()=>{setSideOpen(true);selected='动态';renderPanel()});button('连接与权限',()=>{setSideOpen(true);selected='来源';renderPanel()});button('设置',()=>api.orbMenu.openSettings());button('收起',()=>collapse(true))
 const columns=el('div',undefined,'personal-columns');root.append(header,columns)
 const conversations=el('aside',undefined,'personal-conversations');conversations.setAttribute('aria-label','会话');const newChat=button('新对话',()=>c.create(),conversations);newChat.className='personal-new-chat';const conversationList=el('nav');conversationList.setAttribute('aria-label','会话列表');conversations.append(conversationList);columns.append(conversations)
 const chat=el('section',undefined,'personal-chat');chat.setAttribute('aria-label','对话');columns.append(chat)
 const intro=el('div',undefined,'personal-intro');intro.append(el('h1','有什么需要帮忙？'))
 const conversationHeader=el('header',undefined,'conversation-header');const conversationTitle=el('h2','对话');const voiceStatus=el('span','','conversation-voice-status');conversationHeader.append(conversationTitle,voiceStatus);const endVoice=button('结束语音',()=>c.stopVoice(),conversationHeader);endVoice.hidden=true;chat.append(conversationHeader)
 const history=el('div',undefined,'personal-history');history.setAttribute('role','log');history.append(intro)
 const composer=el('div',undefined,'personal-composer');const draft=el('textarea');draft.placeholder='输入消息…';draft.maxLength=4000;draft.setAttribute('aria-label','消息草稿');draft.rows=3
 draft.addEventListener('input',()=>{c.draft=draft.value})
 draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void run(()=>c.submit())}})
 const inputActions=el('div',undefined,'personal-input-actions');const dictate=button('按住说话',()=>{},inputActions);dictate.className='composer-dictate';dictate.setAttribute('aria-label','按住说话')
 dictate.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();dictate.setPointerCapture(e.pointerId);void run(()=>c.dictate())})
 dictate.addEventListener('pointerup',()=>run(()=>c.finish()));dictate.addEventListener('pointercancel',()=>run(()=>c.text()))
 dictate.addEventListener('keydown',e=>{if([' ','Enter'].includes(e.key)&&!e.repeat){e.preventDefault();void run(()=>c.dictate())}})
 dictate.addEventListener('keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();void run(()=>c.finish())}})
 const voice=button('持续对话',()=>c.isVoiceConversation?c.stopVoice():c.voice(),inputActions);voice.className='composer-voice';const submit=button('↑',()=>c.submit(),inputActions);submit.className='primary composer-submit';submit.setAttribute('aria-label','发送消息')
 const hint=el('p','','personal-hint');composer.append(draft,inputActions,hint,error);chat.append(history,composer)
 const side=el('section',undefined,'personal-side');side.id='personal-side';side.setAttribute('aria-label','个人空间');columns.append(side)
 let sideOpen=true
 const sideToggle=button('侧栏',()=>{setSideOpen(!sideOpen);renderPanel()});sideToggle.setAttribute('aria-label','显示个人空间');sideToggle.setAttribute('aria-controls',side.id)
 function setSideOpen(value){sideOpen=value;side.hidden=!value;root.dataset.sideOpen=String(value);sideToggle.setAttribute('aria-expanded',String(value))}
 setSideOpen(true)
 const tabs=el('nav',undefined,'personal-tabs');tabs.setAttribute('aria-label','个人空间视图');const panel=el('div',undefined,'personal-panel');side.append(tabs,panel)
 let selected='Feeds',ignored=false,debugEvidence=false,renderedSnapshot=null,taskRevision=-1
 const presented=new Set()
 button('整理最新发言',()=>c.command('understanding.start'),header)
 const tabButtons=new Map();for(const title of ['Todos','Feeds','Ideas','Goals','Profile'])tabButtons.set(title,button(title,()=>{selected=title;renderPanel()},tabs))
 const expand=el('button','展开 Nova');expand.id='personal-expand';expand.type='button';expand.addEventListener('click',()=>run(()=>collapse(false)));document.querySelector('#shell').append(expand)
 panel.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains?.(document.activeElement))update()},0))
 const c=new PersonalController({send,start,stop,changed:update})
 const chips=(parent,values)=>{const row=el('div',undefined,'personal-chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 const card=(title,summary)=>{const a=el('article',undefined,'personal-card');a.append(el('h3',title));if(summary)a.append(el('p',summary));panel.append(a);return a}
 const continueChat=async(text)=>{if(!c.selectedId||c.isVoiceConversation)await c.create();c.draft=`关于「${text}」：`;update();draft.focus()}
 function evidence(parent,refs,diagnostics=false) {if(!debugEvidence&&!diagnostics)return null;const details=el('details');details.append(el('summary',diagnostics?'同步详情':'查看依据'));for(const ref of refs??[])details.append(el('p',typeof ref==='string'?ref:`${ref.type??'记忆'} · ${ref.ref??ref.entry_id??''}${ref.observed_at?' · '+ref.observed_at:''}`));parent.append(details);return details}
 function memoryEvidence(parent,entry){
  const details=evidence(parent,entry.source_refs)
  if(!details||!entry.evidence_refs?.length)return
  const originals=el('div');details.append(originals);let generation=0
  details.addEventListener('toggle',async()=>{
   const current=++generation;originals.replaceChildren()
   if(!details.open||!debugEvidence)return
   originals.append(el('p','正在读取…'))
   try{
    const rows=await Promise.all(entry.evidence_refs.slice(0,2).map(evidence_id=>c.command('memory.evidence',{evidence_id})))
    if(current!==generation||!details.open||!details.isConnected||!debugEvidence)return
    originals.replaceChildren()
    for(const row of rows){if(row?.state==='ok'&&row.evidence){originals.append(el('p',`${row.evidence.locator} · ${row.evidence.observed_at}`),el('p',row.evidence.text))}else originals.append(el('p',row?.state==='gone'?'原文已删除或过期':'暂时无法读取原文'))}
   }catch{if(current===generation&&details.isConnected)originals.replaceChildren(el('p','暂时无法读取原文'))}
  })
 }
 function renderPanel(){
  panel.replaceChildren();for(const [name,b]of tabButtons)b.setAttribute('aria-current',String(name===selected))
  const s=c.snapshot;const caps=s?.capabilities??{}
  if(s?.understanding?.status==='working')panel.append(el('p','正在整理最新一条发言中的结构化候选…'))
  if(s?.understanding?.error)panel.append(el('p','整理未成功，请稍后重试。'))
  const candidateKind=({Todos:'todo',Ideas:'idea',Goals:'goal',Profile:'profile'})[selected]
  for(const item of s?.understanding?.items??[]){if(item.kind!==candidateKind)continue;const a=card('待确认的结构化候选',item.text);a.append(el('p',`依据：${item.quote}`));if(item.kind==='profile')a.append(el('p','确认后将追加到个人介绍，不会替换已有内容。'));const edit=el('textarea');edit.value=lifeLocal['candidate:'+item.id]??item.text;edit.maxLength=1000;edit.setAttribute('aria-label','候选内容');edit.addEventListener('input',()=>{lifeLocal['candidate:'+item.id]=edit.value});a.append(edit);button('确认加入',()=>c.command('understanding.action',{id:item.id,action:'accept',text:edit.value,...(item.kind==='profile'?{expected_profile_version:s.life.profile.version}:{})}),a);button('忽略候选',()=>c.command('understanding.action',{id:item.id,action:'dismiss'}),a)}
  if(['Todos','Ideas','Goals'].includes(selected)){
   renderLife(panel,{kind:({Todos:'todo',Ideas:'idea',Goals:'goal'})[selected],state:s?.life,command:(m,p)=>c.command(m,p),button,run,local:lifeLocal,rerender:renderPanel,delegate:async text=>{if(!c.selectedId||c.isVoiceConversation)await c.create();c.draft=text;update();draft.focus()}})
   if(selected==='Todos')button('查看 Agent 执行任务',()=>{selected='任务';renderPanel()},panel)
  }else if(selected==='Feeds'){
   renderNews(panel,{news:s?.news,command:(m,p)=>c.command(m,p),button,local:newsLocal,rerender:renderPanel,profile:()=>{selected='Profile';renderPanel()},openArticle:url=>api.personal.openArticle(url)})
  }else if(selected==='Profile'){
   renderProfile(panel,{state:s?.life,news:s?.news,command:(m,p)=>c.command(m,p),button,local:lifeLocal,rerender:renderPanel,showMemory:()=>{selected='记忆';renderPanel()}})
  }else if(selected==='动态'){
   const heading=el('div',undefined,'personal-section-heading');heading.append(el('h2','动态'));button(ignored?'返回当前':'查看已忽略',()=>{ignored=!ignored;renderPanel()},heading);panel.append(heading)
   const feed=(s?.feed??[]).filter(item=>ignored?item.user_state==='dismissed'||item.user_state==='dismiss':item.user_state!=='dismissed'&&item.user_state!=='dismiss')
   if(!feed.length)card(ignored?'没有已忽略的动态':'暂无动态','有新建议时会显示在这里。')
   for(const item of feed){if(sideOpen&&!c.collapsed&&!item.delivery?.presented_at&&!presented.has(item.id)){presented.add(item.id);void c.command('feed.action',{id:item.id,action:'presented'}).catch(()=>presented.delete(item.id))}const a=card(item.title,item.why_now);chips(a,[item.kind==='question'?'待回应':'建议',({active:'待处理',resolved:'已完成',invalidated:'已失效'}[item.lifecycle]||item.lifecycle),item.task_ref?'关联任务':null]);evidence(a,[...(item.evidence_refs??[]),...(item.memory_refs??[])])?.addEventListener('toggle',e=>{if(e.target.open)void run(()=>c.command('feed.action',{id:item.id,action:'expand_evidence'}))});const actions=el('div',undefined,'personal-actions');a.append(actions)
    const actionLabel=item.kind==='task_result'?'查看任务结果':item.task_ref?'查看任务进展':item.kind==='question'?'回复这个问题':item.kind==='change'?'查看变化':'讨论这个建议';button(actionLabel,()=>c.openFeed(item.id,actionLabel),actions)
    if(item.lifecycle==='active'&&!ignored){button('稍后',()=>c.command('feed.action',{id:item.id,action:'snooze',snooze_until:new Date(Date.now()+3600000).toISOString()}),actions);button('忽略',()=>c.command('feed.action',{id:item.id,action:'dismiss'}),actions)}
   }
  }else if(selected==='任务'){
   panel.append(el('h2','任务'));if(tasks()?.error){const notice=el('p',tasks().error,'personal-error');notice.setAttribute('role','alert');panel.append(notice)}const list=tasks()?.tasks??[];if(!list.length)card('暂无任务','开始对话后可在这里查看任务进展。')
   for(const task of list){const a=card(task.title,task.summary);chips(a,[task.project,{started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}[task.phase]||task.phase,task.executor]);button('询问任务进展',()=>{const feed=c.snapshot?.feed?.find(item=>item.task_ref?.work_id===task.work_id);return feed?c.openFeed(feed.id,'询问任务进展'):continueChat(`${task.title} · ${task.work_id}`)},a);const active=tasks()?.selected?.work_id===task.work_id;const open=button(active&&tasks()?.opening?'正在打开…':'打开项目',()=>taskAction(task.work_id,'open'),a);open.disabled=active&&tasks()?.opening;if(['started','working'].includes(task.phase)){const cancel=button(active&&tasks()?.cancelling?'正在停止…':'停止任务',()=>taskAction(task.work_id,'cancel'),a);cancel.disabled=active&&tasks()?.cancelling;}if(results().length)button('查看结果',openResults,a)}
   button('任务控制与结果',openResults,panel)
  }else if(selected==='记忆'){
   const includeExpired=s?.memory?.include_expired===true
   const entries=(s?.memory?.entries??[]).filter(m=>m.status==='active')
   const overview=memoryOverview(entries,s?.memory?.overview)
   const recordDetails=(parent,items,label)=>{
    const records=el('details',undefined,'memory-group-details');records.append(el('summary',label));parent.append(records)
    for(const entry of items){
     const a=el('article',undefined,'memory-entry-details');a.append(el('h4',entry.topic||entry.content?.slice(0,48)||'记忆'));a.append(el('p',entry.content));chips(a,[entry.origin==='stated'?'你说过':'根据资料',entry.status==='expired'?'已过期':null,entry.confidence_note]);memoryEvidence(a,entry);records.append(a)
     if(entry.commitment)chips(a,[{owed_by_me:'我答应的',owed_to_me:'等对方回复'}[entry.commitment.direction],{open:'待完成',done:'已完成',dropped:'已取消'}[entry.commitment.status],entry.commitment.due?new Date(entry.commitment.due).toLocaleDateString('zh-CN'):null])
     if(entry.editable!==false){
     const correction=el('textarea');correction.value=entry.content;correction.maxLength=500;correction.setAttribute('aria-label','纠正记忆内容');correction.hidden=true;a.append(correction)
     const edit=button('纠正',async()=>{if(correction.hidden){correction.hidden=false;correction.focus();edit.textContent='保存纠正';return}await c.command('memory.correct',{id:entry.id,expected_version:entry.version,content:correction.value})},a);edit.disabled=!caps.memory?.correct||entry.version==null;edit.title=edit.disabled?'当前后端不支持版本化纠正':''
     const forget=button('忘记',()=>c.command('memory.forget',{id:entry.id,expected_version:entry.version}),a);forget.disabled=!caps.memory?.forgetEntry||entry.version==null;forget.title=forget.disabled?'当前后端不支持按条目忘记':''
     }
     button('接着聊',()=>continueChat(entry.content),a)
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
    const a=el('div',undefined,'memory-records');panel.append(a)
    const managed=(s?.memory?.entries??[]).filter(entry=>entry.status==='active'||includeExpired&&entry.status==='expired')
    const records=recordDetails(a,managed,'管理记忆')
    const expiredLabel=el('label',undefined,'personal-consent'),expiredCheck=el('input');expiredCheck.type='checkbox';expiredCheck.checked=includeExpired;expiredCheck.disabled=!c.connected;expiredLabel.append(expiredCheck,document.createTextNode('包含已过期'));records.append(expiredLabel)
    expiredCheck.addEventListener('change',()=>run(()=>c.command('memory.list',{limit:50,include_expired:expiredCheck.checked})))
   }
   if(s?.memory?.cursor)button('下一页',()=>c.command('memory.list',{cursor:s.memory.cursor,limit:50,include_expired:includeExpired}),panel)
   if(caps.memory?.list)button('返回第一页',()=>c.command('memory.list',{limit:50,include_expired:includeExpired}),panel)
  }else{
   panel.append(el('h2','连接与权限'),el('p','只读取你授权的目录和会话。正文可能交由设置中的模型服务处理；读取权限不授予修改或发送权限。','personal-hint'))
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
   renderConnectors({state:s?.connectors,local:connectorLocal,card,el,button,command:(method,params)=>c.command(method,params),api,refresh:renderPanel})
   renderDailyBrief({settings:s?.settings,connected:c.connected,card,el,button,command:(method,params)=>c.command(method,params)})
   const discovery=card('主动发现','有依据才提出建议。关闭后仍可主动交办任务。');const select=el('select');select.setAttribute('aria-label','主动发现间隔');for(const [value,label]of [['0','关闭'],['15','每 15 分钟'],['30','每 30 分钟'],['60','每小时'],['120','每两小时']]){const option=el('option',label);option.value=value;select.append(option)}select.value=s?.settings?.discovery_enabled?String(s.settings.discovery_interval_minutes):'0';select.disabled=!caps.discovery;select.addEventListener('change',()=>run(()=>c.command('discovery.configure',{enabled:select.value!=='0',...(select.value!=='0'?{interval_minutes:Number(select.value)}:{})})));discovery.append(select)
  }
  for(const b of panel.querySelectorAll('button'))if(!c.connected)b.disabled=true
 }
 const liveCaptions=new Map()
 let renderedConversation=null,renderedMessages='',renderedNavigation=''
 function renderConversations(){
  const state=c.snapshot?.conversations
  const items=state?.items??[]
  const navKey=JSON.stringify([c.connected,c.selectedId,c.voiceId,items,items.map(item=>Boolean(c.state(item.id).submission))])
  if(navKey!==renderedNavigation){
  renderedNavigation=navKey;conversationList.replaceChildren()
  for(const item of [...items].sort((a,b)=>Number(b.kind==='proactive')-Number(a.kind==='proactive'))){
   const b=button(item.kind==='proactive'?'主动提醒':item.title,()=>c.select(item.id),conversationList)
   b.className='conversation-item';b.setAttribute('aria-current',String(item.id===c.selectedId));b.disabled=!c.connected
   if(item.id===c.voiceId){b.append(el('span','语音中','conversation-badge'));b.setAttribute('aria-label',`${b.textContent}，语音中`)}
   else if(c.state(item.id).submission)b.append(el('span','发送中','conversation-badge'))
  }
  if(!items.length)conversationList.append(el('p',c.connected?'正在加载会话…':'尚未连接','personal-hint'))
  }
  const active=items.find(item=>item.id===c.selectedId)
  conversationTitle.textContent=active?.kind==='proactive'?'主动提醒':active?.title??'对话'
  const voiceConversation=items.find(item=>item.id===c.voiceId)
  voiceStatus.textContent=c.voiceId?`语音：${voiceConversation?.title??'另一会话'}`:''
  endVoice.hidden=!c.voiceId;endVoice.disabled=!c.connected
  newChat.disabled=!c.connected
 }
 function renderHistory(){
  const persisted=(c.snapshot?.conversations?.messages??[]).filter(message=>message.conversation_id===c.selectedId)
  const turns=new Set(persisted.map(message=>message.turn_id).filter(Boolean))
  const live=[...liveCaptions.values()].filter(frame=>frame.conversation_id===c.selectedId&&(frame.role!=='user'||frame.conversation_id===c.voiceId)&&!turns.has(frame.turn_id))
  const key=JSON.stringify([c.selectedId,persisted,live])
  if(key===renderedMessages)return
  const changedConversation=renderedConversation!==c.selectedId;const nearBottom=history.scrollHeight-history.scrollTop-history.clientHeight<80
  history.replaceChildren()
  if(!persisted.length&&!live.length)history.append(intro)
  for(const message of [...persisted,...live]){const node=el('article',undefined,`personal-message ${message.role==='user'?'user':'assistant'}`);node.append(el('small',message.role==='user'?'你':'Nova'),el('p',message.text));const generationLabel={pending:'正在回复…',failed:'回复失败，请重新发送',interrupted:'回复已中断，请重新发送'}[message.generation_status];if(generationLabel)node.append(el('small',generationLabel,'personal-hint'));history.append(node)}
  renderedMessages=key;renderedConversation=c.selectedId
  if(changedConversation||nearBottom)history.scrollTop=history.scrollHeight
 }
 function update(){
  document.body.dataset.personalCollapsed=String(c.collapsed);status.textContent=c.connected?`运行中 · ${(tasks()?.tasks??[]).filter(t=>['started','working'].includes(t.phase)).length} 个后台任务`:'已断开 · 草稿保留'
  if(draft.value!==c.draft)draft.value=c.draft
  const localDictation=c.dictationConversationId===c.selectedId&&Boolean(c.dictationId)
  draft.disabled=!c.connected||!c.selectedId||!c.inputInstance||Boolean(c.submittedRequestId)||c.isVoiceConversation||localDictation||!c.capabilities.includes('text_input')
  submit.disabled=draft.disabled
  dictate.disabled=!c.connected||!c.selectedId||Boolean(c.voiceId)||(c.mode!=='text'&&c.dictationConversationId!==c.selectedId)||c.mode==='transcribing'||!c.capabilities.includes('dictation')
  voice.disabled=!c.connected||!c.selectedId||(Boolean(c.voiceId)&&!c.isVoiceConversation)||(c.mode!=='text'&&!c.isVoiceConversation)
  voice.textContent=c.isVoiceConversation?'结束语音':'持续对话';voice.setAttribute('aria-pressed',String(c.isVoiceConversation))
  hint.textContent=!c.connected?'连接已断开，草稿已保留':c.submittedRequestId?'正在确认发送状态…':c.isVoiceConversation?'此会话正在语音对话，结束后可输入文字。':localDictation?(c.mode==='transcribing'?'正在识别，草稿不会自动发送':'正在录音 · 松开后生成草稿'):c.voiceId?'另一会话正在语音对话；这里可以输入文字。':!c.capabilities.includes('text_input')?'正在确认文字输入能力…':'Enter 发送 · Shift + Enter 换行'
  error.textContent=c.error;error.hidden=!c.error
  expand.textContent=`展开 Nova${c.voiceId?' · 语音中':(c.snapshot?.feed??[]).some(f=>f.lifecycle==='active'&&f.user_state==='new')?' · 有新动态':''}`
  renderConversations();renderHistory()
  if(!c.connected)unreadProjection=null
  const unread=c.connected?c.snapshot?.conversations?.unread_count:undefined
  if(Number.isSafeInteger(unread)&&unread>=0&&unreadProjection!==unread){unreadProjection=unread;void api.personal.setUnread?.(unread)}
  markVisibleRead()
  if((renderedSnapshot!==c.snapshot||taskRevision!==JSON.stringify(tasks()))&&!(panel.contains?.(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))){renderedSnapshot=c.snapshot;taskRevision=JSON.stringify(tasks());renderPanel()}
 }

 function markVisibleRead(){
  if(!c.connected||c.collapsed||document.visibilityState!=='visible'||!document.hasFocus()||history.scrollHeight-history.scrollTop-history.clientHeight>24)return
  const data=c.snapshot?.conversations,item=data?.items?.find(row=>row.id===c.selectedId)
  if(item?.kind!=='proactive'||!item.unread_count)return
  const message=data.messages?.filter(row=>row.conversation_id===c.selectedId).at(-1)
  if(!message?.id||readMessages.has(message.id))return
  readMessages.add(message.id)
  void c.command('conversations.read',{id:c.selectedId,through_message_id:message.id}).catch(()=>readMessages.delete(message.id))
 }
 history.addEventListener('scroll',markVisibleRead);document.addEventListener('visibilitychange',markVisibleRead);window.addEventListener('focus',markVisibleRead)
 async function collapse(value){c.collapse(value);await api.personal.setCollapsed(value)}
 function receive(frame){
  if(frame.type==='caption'&&typeof frame.text==='string'&&frame.conversation_id&&frame.turn_id&&(frame.role!=='user'||frame.conversation_id===c.voiceId)){
   const key=`${frame.conversation_id}:${frame.turn_id}`
   if(frame.text)liveCaptions.set(key,frame)
   while(liveCaptions.size>128)liveCaptions.delete(liveCaptions.keys().next().value)
  }
  c.receive(frame)
  if(frame.type==='personal.state')for(const message of frame.conversations?.messages??[])if(message.turn_id)liveCaptions.delete(`${message.conversation_id}:${message.turn_id}`)
  if(frame.type==='executor.tasks')renderPanel()
 }

 api.personal.onCollapsed?.(value=>c.collapse(value));update();renderPanel();return {controller:c,receive,refresh:update}
}
