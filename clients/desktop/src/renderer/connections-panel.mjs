import {renderConnectors} from './connectors-view.mjs'
import {renderDailyBrief} from './daily-brief-view.mjs'

/** Sources, app connectors, briefing schedule and discovery cadence, reached through the settings window's narrow IPC bridge. */
export function createConnectionsPanel({document, api}) {
 const root=document.querySelector('#connections-panel'),error=document.querySelector('#connections-error')
 let state=null,busy=false
 const local={onError:caught=>{error.textContent=caught?.message||'连接暂时不可用'}}
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
 const button=(text,action,parent)=>{const node=el('button',text);node.type='button';node.disabled=busy;node.addEventListener('click',()=>{void Promise.resolve().then(action).catch(local.onError)});parent.append(node);return node}
 const chips=(parent,values)=>{const row=el('div',undefined,'personal-chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 function render(){
  root.replaceChildren()
  const card=(title,description)=>{const node=el('article',undefined,'im-card');node.append(el('h3',title));if(description)node.append(el('p',description));root.append(node);return node}
  if(state===null){const loading=card('连接与权限','正在读取连接状态…');loading.setAttribute('aria-busy',String(busy));return}
  const s=state,caps=s.capabilities??{}
  const sources=card('本机目录','允许后台读取所选目录并用于检索与建议。')
  const consent=el('label',undefined,'personal-consent');const check=el('input');check.type='checkbox';consent.append(check,document.createTextNode('允许后台读取所选目录并用于检索与建议'));sources.append(consent)
  const add=button('选择并授权目录',async()=>{const path=await api.chooseDirectory();if(path)await command('sources.add',{path,consent:true})},sources);add.disabled=true;check.addEventListener('change',()=>{add.disabled=!check.checked||!caps.sources})
  if(!caps.sources)sources.append(el('p','来源服务不可用，请先在知识库中启用。','hint'))
  for(const source of s.sources??[]){const a=card(source.path);chips(a,[{connected:'已连接',paused:'已暂停',disconnected:'已断开',error:'异常'}[source.state]||source.state,`扫描 ${source.scanned}`,`本次读取正文 ${source.read}`,`跳过 ${source.skipped}`]);a.append(el('p',`上次同步：${source.last_sync??'尚未同步'}`))
   const details=el('details');details.append(el('summary','同步详情'));for(const line of [`排除：${(source.excludes??[]).join('、')}`,`跳过原因：${JSON.stringify(source.reasons??{})}`,...(source.failures??[]).map(f=>`${f.path} · ${f.code}`)])details.append(el('p',line));a.append(details)
   if(source.state!=='disconnected')for(const [label,method]of [[source.state==='paused'?'恢复同步':'暂停同步',source.state==='paused'?'resume':'pause'],['立即同步','sync'],['断开（保留数据）','disconnect']])button(label,()=>command(`sources.${method}`,{id:source.id}),a)
   else a.append(el('p','已停止访问；重新授权连接暂不支持。'))
   const deletion=el('div');deletion.hidden=true;deletion.setAttribute('role','group');deletion.setAttribute('aria-label','确认删除来源数据');deletion.append(el('p',`确认删除「${source.path}」的索引与来源记录？依赖此来源的记忆和建议也会更新或撤回；不会删除磁盘原文件。`))
   button('确认删除来源数据',()=>command('sources.delete',{id:source.id}),deletion);button('取消删除',()=>{deletion.hidden=true},deletion)
   button('删除来源数据',()=>{deletion.hidden=false;deletion.querySelector('button')?.focus?.()},a);a.append(deletion)
  }
  renderConnectors({state:s.connectors,local,card,el,button,command,api:{personal:{openConnectorAuthorization:url=>api.openConnectorAuthorization(url)}},refresh:render})
  renderDailyBrief({settings:s.settings,connected:true,card,el,button,command})
  const discovery=card('主动发现','有依据才提出建议。关闭后仍可主动交办任务。');const select=el('select');select.setAttribute('aria-label','主动发现间隔');for(const [value,label]of [['0','关闭'],['15','每 15 分钟'],['30','每 30 分钟'],['60','每小时'],['120','每两小时']]){const option=el('option',label);option.value=value;select.append(option)}select.value=s.settings?.discovery_enabled?String(s.settings.discovery_interval_minutes):'0';select.disabled=!caps.discovery||busy;select.addEventListener('change',()=>{void command('discovery.configure',{enabled:select.value!=='0',...(select.value!=='0'?{interval_minutes:Number(select.value)}:{})}).catch(local.onError)});discovery.append(select)
  if(busy)for(const input of root.querySelectorAll('button,input,select'))input.disabled=true
 }
 async function command(method,params={}){
  if(busy)throw new Error('请等待当前操作完成')
  busy=true;error.textContent='';render()
  try{
   const result=await api.personalCommand(method,params)
   if(result?.error)throw new Error(result.error)
   state=method==='state'?result:await api.personalCommand('state',{})
   if(state?.error)throw new Error(state.error)
   return result
  }finally{busy=false;render()}
 }
 async function load(){if(busy)return;try{await command('state')}catch(caught){root.replaceChildren(el('p','未能读取连接状态，请重试。'));local.onError(caught)}}
 render()
 return {load}
}
