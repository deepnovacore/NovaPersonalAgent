export function renderConnectors({state,local,card,el,button,command,api,refresh}) {
 const intro=card('邮件与日历','通过 Composio 连接 Google。Nova 只读取所选范围；托管 Google 授权可能包含写入权限，请以授权页面为准。')
 if(!state?.available)intro.append(el('p','Google 连接需要在设置 → API 密钥填写 Composio 密钥。'))
 if(state?.memory_available===false){intro.append(el('p','请先在本机配置中启用本地记忆，再连接应用。'));return}
 const call=(method,params)=>command('connector.'+method,params)
 if(state?.local_available)button('连接本机日历',async()=>{const status=await call('local_status',{});if(status.status!=='granted'){local.permission=true;refresh();return}await call('local_connect',{})},intro)
 if(local.permission){intro.append(el('p','macOS 要求完整日历访问权限才能读取日程；Nova 只读，不修改日程。'));button('向系统申请日历权限',async()=>{await call('local_access',{});await call('local_connect',{});local.permission=false},intro)}
 if(state?.available)for(const [toolkit,title] of [['gmail','连接 Gmail'],['googlecalendar','连接 Google 日历']])button(title,async()=>{const result=await call('link',{toolkit});local[result.id]={url:result.url};await api.personal.openConnectorAuthorization(result.url)},intro)
 button('刷新连接',()=>call('status',{}),intro)
 for(const connection of state?.connections??[]){
  const id=connection.id,edit=local[id]??=( {} ),a=card((connection.toolkit==='gmail'?'Gmail':connection.toolkit==='macos_calendar'?'本机日历':'Google 日历')+(connection.identity?' · '+connection.identity:''),({authorizing:'等待授权',connected:'已连接',paused:'已暂停',disconnected:'已断开，保留已同步数据'}[connection.state]??connection.state))
  if(connection.last_complete)a.append(el('p','最近完整同步：'+new Date(connection.last_complete).toLocaleString()))
  if(connection.last_attempt)a.append(el('p','最近尝试：'+new Date(connection.last_attempt).toLocaleString()))
  if(connection.error)a.append(el('p','同步需要处理：'+connection.error))
  if(connection.has_pending)a.append(el('p','正在分批同步，已保存进度。'))
  if(connection.state==='authorizing'){
   if(edit.url)button('打开授权页面',()=>api.personal.openConnectorAuthorization(edit.url),a)
   button('我已完成授权',async()=>{await call('complete',{id});edit.url=null},a);continue
  }
  button(connection.scope?'调整同步范围':'选择同步范围',async()=>{edit.choices=await call('scopes',{id});edit.selected=new Set(connection.scope?.labels??connection.scope?.calendars??[]);edit.processing=connection.processing_allowed;refresh()},a)
  if(edit.choices){
   const group=el('fieldset');group.append(el('legend','允许读取的标签或日历'));a.append(group)
   for(const item of edit.choices.items){const label=el('label',item.name),input=el('input');input.type='checkbox';input.checked=edit.selected.has(item.id);input.addEventListener('change',()=>input.checked?edit.selected.add(item.id):edit.selected.delete(item.id));label.prepend(input);group.append(label)}
   if(edit.choices.next)button('加载更多',async()=>{const next=await call('scopes',{id,pageToken:edit.choices.next});edit.choices={items:[...edit.choices.items,...next.items],next:next.next};refresh()},a)
   const days=(title,name,fallback)=>{const label=el('label',title),input=el('input');input.type='number';input.min='1';input.max='365';input.value=String(edit[name]??connection.scope?.[name]??fallback);input.addEventListener('input',()=>{edit[name]=Number(input.value)});label.append(input);a.append(label);return input}
   const past=days('回溯天数','pastDays',30),future=connection.toolkit!=='gmail'?days('未来天数','futureDays',90):null
   const label=el('label','允许将所选原文发送给已配置的模型服务，抽取记忆和生成向量'),consent=el('input');consent.type='checkbox';consent.checked=!!edit.processing;consent.addEventListener('change',()=>{edit.processing=consent.checked});label.prepend(consent);a.append(label)
   button('保存范围并开始同步',async()=>{const values=[...edit.selected];await call('configure',{id,scope:future?{kind:'calendar',calendars:values,pastDays:Number(past.value),futureDays:Number(future.value)}:{kind:'gmail',labels:values,pastDays:Number(past.value)},processingConsent:consent.checked});edit.choices=null},a)
  }
  if(connection.scope){
   a.append(el('p',connection.processing_allowed?'已允许模型处理所选内容':'仅保存在本机，不发送内容给模型'))
   if(connection.processing_allowed)button('撤回模型处理同意',()=>call('consent',{id,processingConsent:false}),a)
   button('立即同步',()=>call('sync',{id}),a)
   button(connection.state==='connected'?'暂停同步':'恢复同步',()=>call(connection.state==='connected'?'pause':'resume',{id}),a)
   button('断开连接',()=>call('disconnect',{id}),a)
  }
  const deletion=el('div');deletion.hidden=true;deletion.append(el('p','删除 Nova 中此连接的同步数据及关联记忆；不会删除 Google 中的邮件或日程。'))
  button('确认删除本地数据',()=>call('delete',{id}),deletion);button('取消',()=>{deletion.hidden=true},deletion)
  button('删除本地数据',()=>{deletion.hidden=false},a);a.append(deletion)
 }
}
