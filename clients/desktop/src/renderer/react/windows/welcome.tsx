import React, {useEffect, useRef, useState} from 'react'
import {ShieldCheck, Mic, Monitor, Accessibility} from 'lucide-react'
import {t} from '../../locale.mjs'
import {startupMessage} from '../../startup-notice.mjs'
import {OrbDragGesture} from '../../drag-gesture.mjs'

export function WindowChrome({api}: any) {
 const gesture = useRef(new OrbDragGesture())
 const finish = (cancel = false) => { const result = cancel ? gesture.current.cancel() : gesture.current.finish(); if (result.active) api.windowDrag?.end() }
 return <><div className={`window-grip ${api.windowDrag?.native?'native-window-drag':''}`} aria-hidden="true"
 onPointerDown={e=>{if(e.button!==0||api.windowDrag?.native)return;gesture.current.start(e.clientX,e.clientY);e.currentTarget.setPointerCapture?.(e.pointerId);api.windowDrag?.start()}}
 onPointerMove={e=>{const d=gesture.current.move(e.clientX,e.clientY);if(d)api.windowDrag?.move(d.dx,d.dy)}} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onDoubleClick={()=>api.windowControls?.toggleMaximize?.()}/>
 <div className="window-controls" role="group" aria-label={t('窗口控制')}>{[['close','关闭窗口','关闭（转入后台）','close'],['minimize','最小化','最小化','minimize'],['toggleMaximize','最大化或还原','最大化或还原','maximize']].map(([action,label,title,cls])=><button key={action} type="button" className={`window-control window-${cls}`} aria-label={t(label)} title={t(title)} onClick={()=>api.windowControls?.[action]?.()}/>)}</div></>
}
const permissions: any[] = [['microphone','麦克风','用于语音对话；不授权也可以打字聊天。',Mic],['screen','屏幕录制','用于查看电脑画面。使用电脑操作时，截图会发送给所用的视觉模型。',Monitor],['accessibility','辅助功能','用于点击、输入和滚动。电脑操作仍需在 Nova 内逐次批准。',Accessibility]]
const labels: any={granted:'已授权',denied:'未授权',restricted:'受系统限制',unknown:'暂时无法确认','not-determined':'尚未设置',unsupported:'当前系统不支持',not_required:'无需此系统授权'}
export function PermissionCards({api, value, onChange}:any) {
 const [busy,setBusy]=useState(''),[error,setError]=useState('')
 const run=async(kind:string)=>{if(busy)return;setBusy(kind);setError('');try{const next=kind==='refresh'?await api.get():await api.permission(kind);onChange(next)}catch{setError(t('无法打开系统设置，请手动前往隐私与安全性。'))}finally{setBusy('')}}
 return <>{permissions.map(([kind,title,description,Icon])=>{const status=value?.[kind]??'unknown';return <article className="permission-row" key={kind}><span className="permission-icon"><Icon/></span><div className="permission-copy"><h3>{t(title)}</h3><p>{t(description)}</p></div><div className="permission-aside"><span className="permission-state" data-status={status}>{t(labels[status]??labels.unknown)}</span><button type="button" aria-label={t('设置{0}权限',t(title))} hidden={['granted','not_required','unsupported'].includes(status)} disabled={!!busy} onClick={()=>void run(kind)}>{t('去设置')}</button></div></article>})}<p className="permission-note">{t(['granted','not_required'].includes(value?.screen)&&['granted','not_required'].includes(value?.accessibility)?'系统权限已就绪。在 Build 中打开 Computer Use 即可使用，执行前仍会请求批准。':'授权后可在 Build 中使用电脑操作；默认使用主屏幕和当前对话模型。')}</p><button type="button" disabled={!!busy} onClick={()=>void run('refresh')}>{t('重新检查权限')}</button><p className="welcome-error" role="alert" hidden={!error}>{error}</p></>
}
export function WelcomeScreen({api,startup,onProfile,onVisible}:any) {
 const [view,setView]=useState<any>(null),[entered,setEntered]=useState(false),[skip,setSkip]=useState(false),[error,setError]=useState(false),[busy,setBusy]=useState(false)
 const enteredRef=useRef(entered);enteredRef.current=entered
 const alive=useRef(true),profileCallback=useRef(onProfile),visibleCallback=useRef(onVisible);profileCallback.current=onProfile;visibleCallback.current=onVisible
 const accept=(next:any)=>{if(!alive.current)return;setView(next);setError(false);profileCallback.current(next)}
 const load=()=>api.welcome?.get().then(accept).catch(()=>{if(alive.current)setError(true)})
 useEffect(()=>{alive.current=true;void load();const stop=api.welcome?.onChanged(accept);const focus=()=>{if(!enteredRef.current)void load()};window.addEventListener('focus',focus);return()=>{alive.current=false;stop?.();window.removeEventListener('focus',focus)}},[api])
 const stage=skip?'ready':startup?.stage??'configuration'
 const phase=entered||!api.welcome?'chat':stage==='failed'?'failed':stage!=='ready'||!view?'loading':view.profile.permissionsSeen?'chat':'permissions'
 useEffect(()=>{visibleCallback.current(phase!=='chat');if(phase==='chat')setEntered(true)},[phase])
 return <section id="welcome-screen" className="welcome-screen" hidden={phase==='chat'} data-phase={phase} aria-label={t('开始使用 nova')}><WindowChrome api={api}/><div className="welcome-loading" hidden={phase==='permissions'}><div className="welcome-portrait"><span className="welcome-spinner" data-stage={stage} role="progressbar" aria-label={t('正在准备工作台')} hidden={phase==='failed'}/><img data-welcome-avatar="" src={view?.profile.avatar??view?.defaultAvatar} alt={t('助手头像')}/></div><h1 data-welcome-name="">{view?.profile.assistantName??'nova'}</h1><p data-welcome-status="" role="status" aria-live="polite" data-stage={stage} hidden={!startupMessage({...startup,stage})}>{startupMessage({...startup,stage})}</p><button type="button" data-welcome-settings="" hidden={phase!=='failed'} onClick={()=>api.orbMenu.openSettings()}>{t('打开设置并重试')}</button><button type="button" data-welcome-skip="" hidden={phase!=='failed'} onClick={()=>setSkip(true)}>{t('先完成欢迎设置')}</button></div><div className="welcome-permissions" hidden={phase!=='permissions'}><div className="welcome-hero" aria-hidden="true"><ShieldCheck/></div><p className="welcome-eyebrow">{t('开始之前')}</p><h1>{t('让 nova 按你的选择工作')}</h1><p className="welcome-lead">{t('选择要开放的权限。你可以随时在设置中调整，也可以稍后再说。')}</p><div data-permission-cards=""><PermissionCards api={api.welcome} value={view?.permissions} onChange={accept}/></div><p className="welcome-footnote">{t('授权屏幕录制后可能需要重启应用。')}</p><button type="button" className="welcome-primary" data-permission-continue="" disabled={busy} onClick={async()=>{if(busy)return;setBusy(true);try{accept(await api.welcome.save({permissionsSeen:true}))}catch{setError(true)}finally{setBusy(false)}}}>{t('继续，认识 nova')}</button></div><div data-welcome-error="" className="welcome-error" role="alert" hidden={!error}>{t('暂时无法读取或保存设置，请重试。')}</div><button type="button" data-welcome-reload="" className="welcome-reload" hidden={!error} onClick={()=>void load()}>{t('重新读取设置')}</button><button type="button" hidden={!error} onClick={()=>setEntered(true)}>{t('暂时跳过欢迎设置')}</button></section>
}
