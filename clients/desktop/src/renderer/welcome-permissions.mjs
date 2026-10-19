import {t} from './locale.mjs'
const LABELS={granted:'已授权',denied:'未授权',restricted:'受系统限制','not-determined':'尚未设置',unknown:'暂时无法确认',not_required:'无需此系统授权',unsupported:'当前系统不支持'}
// Static, trusted glyphs only: never interpolate user or runtime text here.
const glyph=body=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const ICONS={
 microphone:glyph('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>'),
 screen:glyph('<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/>'),
 accessibility:glyph('<path d="M6 4l12 6.5-5.2 1.6L11 18z"/>')
}
export function mountPermissionCards(root,{api}){
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=t(text);if(cls)n.className=cls;return n}
 const rows=new Map(),note=el('p','','permission-note'),error=el('p','','welcome-error');error.setAttribute('role','alert')
 for(const [kind,title,description]of [['microphone','麦克风','用于语音对话；不授权也可以打字聊天。'],['screen','屏幕录制','用于查看电脑画面。使用电脑操作时，截图会发送给你配置的 GUI 模型。'],['accessibility','辅助功能','用于点击、输入和滚动。电脑操作仍需在 Nova 内逐次批准。']]){
  const row=el('article',null,'permission-row'),badge=el('span',null,'permission-icon'),copy=el('div',null,'permission-copy'),heading=el('h3',title),desc=el('p',description),aside=el('div',null,'permission-aside'),state=el('span',null,'permission-state'),button=el('button','去设置')
  button.type='button';button.setAttribute('aria-label',t('设置{0}权限',t(title)))
  badge.innerHTML=ICONS[kind];copy.append(heading,desc);aside.append(state,button);row.append(badge,copy,aside);root.append(row);rows.set(kind,{state,button})
  button.addEventListener('click',async()=>{button.disabled=true;error.textContent='';try{const view=await api.permission(kind);update(view.permissions)}catch{error.textContent=t('无法打开系统设置，请手动前往隐私与安全性。')}finally{button.disabled=false}})
 }
 const refresh=el('button','重新检查权限');refresh.type='button';refresh.addEventListener('click',async()=>{refresh.disabled=true;try{update((await api.get()).permissions);error.textContent=''}catch{error.textContent=t('暂时无法读取或保存设置，请重试。')}finally{refresh.disabled=false}})
 root.append(note,refresh,error)
 function update(status){if(!status)return;for(const [kind,row]of rows){const state=status[kind]??'unknown';row.state.textContent=t(LABELS[state]??LABELS.unknown);row.state.dataset.status=state;row.button.hidden=['unsupported','not_required','granted'].includes(state)}
  note.textContent=t(status.computerReady?'电脑操作已配置，系统权限已就绪。执行前仍会请求批准。':status.computerConfigured?'电脑操作已配置。授权后可重新检查；若仍不可用，请重启 Nova。':'电脑操作尚未启用，可在设置中配置。')
 }
 return {update}
}
