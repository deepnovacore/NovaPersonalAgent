import {mountWindowChrome} from './window-chrome.mjs'
import {t} from './locale.mjs'
import {startupMessage} from './startup-notice.mjs'
import {mountPermissionCards} from './welcome-permissions.mjs'
export function welcomePhase({startup,profile,entered}){
 if(entered)return 'chat'
 if(startup?.stage==='failed')return 'failed'
 if(startup?.stage!=='ready'||!profile)return 'loading'
 return profile.permissionsSeen?'chat':'permissions'
}
export function mountWelcomeFlow({api,onProfile}){
 const root=document.querySelector('#welcome-screen')
 if(!root||!api.welcome)return {startup(){}}
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
 mountWindowChrome(root,{api,el})
 const bypass=el('button',t('暂时跳过欢迎设置'));bypass.type='button';bypass.hidden=true;root.append(bypass)
 bypass.addEventListener('click',()=>{entered=true;render()})
 const loading=root.querySelector('.welcome-loading'),permission=root.querySelector('.welcome-permissions'),status=root.querySelector('[data-welcome-status]'),retry=root.querySelector('[data-welcome-settings]'),skip=root.querySelector('[data-welcome-skip]'),error=root.querySelector('[data-welcome-error]')
 const cards=mountPermissionCards(permission.querySelector('[data-permission-cards]'),{api:api.welcome})
 let startup={stage:'configuration'},view=null,entered=false,busy=false
 const render=()=>{
  const phase=welcomePhase({startup,profile:view?.profile,entered})
  if(phase==='chat')entered=true
  root.hidden=entered;root.dataset.phase=phase
  document.querySelector('#personal-workspace')?.toggleAttribute('inert',!entered)
  document.querySelector('#shell')?.toggleAttribute('inert',!entered&&document.body.dataset.personalCollapsed!=='true')
  loading.hidden=phase==='permissions';permission.hidden=phase!=='permissions'
  status.textContent=startupMessage(startup)||t('正在准备你的工作台…')
  retry.hidden=phase!=='failed';skip.hidden=phase!=='failed'
  root.querySelector('.welcome-spinner').hidden=phase==='failed'
  if(view){root.querySelector('[data-welcome-avatar]').src=view.profile.avatar??view.defaultAvatar;root.querySelector('[data-welcome-name]').textContent=view.profile.assistantName;cards.update(view.permissions)}
 }
 const accept=value=>{view=value;error.hidden=true;bypass.hidden=true;root.querySelector('[data-welcome-reload]').hidden=true;onProfile(value);render()}
 const report=()=>{bypass.hidden=false;error.textContent=t('暂时无法读取或保存设置，请重试。');error.hidden=false;root.querySelector('[data-welcome-reload]').hidden=false}
 const load=()=>api.welcome.get().then(accept).catch(report)
 retry.addEventListener('click',()=>api.orbMenu.openSettings())
 skip.addEventListener('click',()=>{startup={stage:'ready'};render()})
 const next=permission.querySelector('[data-permission-continue]')
 next.addEventListener('click',async()=>{if(busy)return;busy=true;next.disabled=true;error.hidden=true;try{accept(await api.welcome.save({permissionsSeen:true}))}catch{report()}finally{busy=false;next.disabled=false}})
 root.querySelector('[data-welcome-reload]').addEventListener('click',load)
 api.welcome.onChanged(accept)
 window.addEventListener('focus',()=>{if(!entered)void load()})
 new MutationObserver(render).observe(document.body,{attributes:true,attributeFilter:['data-personal-collapsed']})
 void load();render()
 return {startup:value=>{startup=value??startup;render()}}
}
