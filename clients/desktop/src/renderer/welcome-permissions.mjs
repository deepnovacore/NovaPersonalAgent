import {t} from './locale.mjs'
const LABELS={granted:'已授权',denied:'未授权',restricted:'受系统限制','not-determined':'尚未设置',unknown:'暂时无法确认',not_required:'无需此系统授权',unsupported:'当前系统不支持'}
export function mountPermissionCards(root,{api}){
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=t(text);if(cls)n.className=cls;return n}
 const rows=new Map(),note=el('p','','permission-note'),error=el('p','','welcome-error');error.setAttribute('role','alert')
 for(const [kind,title,description]of [['microphone','麦克风','用于语音对话；不授权也可以打字聊天。'],['screen','屏幕录制','用于查看电脑画面。使用电脑操作时，截图会发送给你配置的 GUI 模型。'],['accessibility','辅助功能','用于点击、输入和滚动。电脑操作仍需在 Nova 内逐次批准。']]){
  const row=el('article',null,'permission-row'),copy=el('div'),heading=el('h3',title),desc=el('p',description),state=el('span',null,'permission-state'),button=el('button','去设置')
  button.type='button';button.setAttribute('aria-label',t('设置{0}权限',t(title)))
  copy.append(heading,desc,state);row.append(copy,button);root.append(row);rows.set(kind,{state,button})
  button.addEventListener('click',async()=>{button.disabled=true;error.textContent='';try{const view=await api.permission(kind);update(view.permissions)}catch{error.textContent=t('无法打开系统设置，请手动前往隐私与安全性。')}finally{button.disabled=false}})
 }
 const refresh=el('button','重新检查权限');refresh.type='button';refresh.addEventListener('click',async()=>{refresh.disabled=true;try{update((await api.get()).permissions);error.textContent=''}catch{error.textContent=t('暂时无法读取或保存设置，请重试。')}finally{refresh.disabled=false}})
 root.append(note,refresh,error)
 function update(status){if(!status)return;for(const [kind,row]of rows){const state=status[kind]??'unknown';row.state.textContent=t(LABELS[state]??LABELS.unknown);row.state.dataset.status=state;row.button.hidden=['unsupported','not_required','granted'].includes(state)}
  note.textContent=t(status.computerReady?'电脑操作已配置，系统权限已就绪。执行前仍会请求批准。':status.computerConfigured?'电脑操作已配置。授权后可重新检查；若仍不可用，请重启 Nova。':'电脑操作尚未配置。系统授权不会自动启用它；需配置 GUI 模型和显示器。')
 }
 return {update}
}
