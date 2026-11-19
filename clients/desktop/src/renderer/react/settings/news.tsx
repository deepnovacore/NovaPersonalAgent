import React,{useEffect,useRef} from 'react'
import {PageContext} from '../pages/shared'
import {Interests} from '../pages/preferences'
import {useCommand,Action} from './controls'
import {t} from '../../locale.mjs'
export function NewsPreferencesPanel({api,local,setLocal}:any){
 const {state,busy,error,command}=useCommand(api),live=useRef(true)
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const context={snapshot:state,connected:!!state?.news,local,setLocal:(key:string,value:any)=>{if(live.current)setLocal((prior:any)=>({...prior,[key]:value}))},command,pending:new Set(busy?['interest:save']:[]),execute:async(_key:any,action:any)=>{try{await action()}catch{/* The editor retains the draft and shows the command error. */}}}
 return <section className="news-preferences" aria-label={t('资讯设置')}><PageContext.Provider value={context}>{state?.news?<Interests/>:<p role="status">{t(error?'资讯设置暂时不可用，请确认后台已连接后重试。':'正在读取资讯设置…')}</p>}</PageContext.Provider>{error&&<p role="alert">{error}</p>}<Action disabled={busy} action={()=>command()}>{t('刷新资讯设置')}</Action><p className="hint">{t('此处调整立即生效，无需重启。')}</p></section>
}
