export function createChatGptPanel(document,api){
  const element=id=>document.getElementById(`chatgpt-${id}`)
  if(!element('settings')||!api)return
  let view=null
  const render=state=>{
    if(view?.active!==state.active)element('model').replaceChildren()
    view=state
    element('account').replaceChildren(new Option('添加账号',''),...state.accounts.map(a=>new Option(`${a.email} · ${a.id.slice(-8)}${a.connected?'':' · 已退出'}`,a.id)))
    element('account').value=state.active??''
    element('use-models').checked=state.useModels;element('use-codex').checked=state.useCodex
    if(state.model&&!Array.from(element('model').options).some(o=>o.value===state.model))element('model').add(new Option(state.model,state.model))
    element('model').value=state.model
    element('status').textContent=state.remoteRevocationConfirmed===false?'已在本机退出，远端撤销未确认；可在 ChatGPT 设置断开授权。':state.restartRequired?'配置已保存，服务重启未完成，请重试。':state.pending?'请在浏览器中完成授权，然后刷新账号状态。':state.accounts.some(a=>a.id===state.active&&a.connected&&a.planEnabled)?'ChatGPT 套餐授权已连接。':'请登录并授权 ChatGPT 套餐使用。'
  }
  const run=async(action,value)=>{const account=view?.active;try{const result=await api.action(action,value);if(action==='models'){if(account!==view?.active)return;element('model').replaceChildren(...result.map(m=>new Option(m.name,m.id)));if(result.some(m=>m.id===view?.model))element('model').value=view.model}else render(result)}catch{element('status').textContent='操作未完成，请检查网络、账号授权及系统安全存储后重试。'}}
  for(const [id,action]of Object.entries({refresh:'status',cancel:'cancel',logout:'logout',models:'models',usage:'usage'}))element(id).addEventListener('click',()=>run(action))
  element('account').addEventListener('change',()=>{if(element('account').value)void run('configure',{active:element('account').value})})
  element('login').addEventListener('click',()=>run('login',element('account').value||null))
  element('apply').addEventListener('click',()=>run('configure',{...(element('account').value?{active:element('account').value}:{}),useModels:element('use-models').checked,useCodex:element('use-codex').checked,...(element('model').value?{model:element('model').value}:{})}))
  element('settings').addEventListener('toggle',()=>{if(element('settings').open)void run('status')})
}
