import React,{useEffect,useState} from 'react'
import {Button,TextField} from '@radix-ui/themes'
import {currentLanguage} from '../../locale.mjs'
export function ExperienceSpacesPanel({api,onActiveChange}:any){
 const [state,setState]=useState<any>(null),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const experience=api.experience,label=(zh:string,en:string)=>currentLanguage()==='en'?en:zh
 useEffect(()=>{if(!experience)return;let current=true;void experience.list().then((value:any)=>{if(current)setState(value)}).catch(()=>{});const off=experience.onChanged((value:any)=>{if(current&&value.type==='selection')setState(value)});return()=>{current=false;off?.()}},[experience])
 useEffect(()=>{onActiveChange?.(Boolean(state?.active))},[state?.active,onActiveChange])
 if(!state?.available)return null
 const run=async(action:()=>Promise<any>)=>{setBusy(true);setMessage('');try{await action()}catch{setMessage(label('操作未完成，请检查体验码、额度或网络后重试。','Could not complete this action. Check your experience code, allowance or connection.'))}finally{setBusy(false)}}
 return <section className="space-host-panel" aria-busy={busy}><h3>{label('体验空间','Experience Spaces')}</h3><p>{label('每个人物使用独立空间。你的真实资料、对话和任务会保留在原空间。','Each persona has a separate Space. Your own data, conversations and tasks stay in your original Space.')}</p>
 {state.active&&state.personas.find((persona:any)=>persona.id===state.active)?.avatar&&<img src={state.personas.find((persona:any)=>persona.id===state.active).avatar} alt="" width={72} height={72}/>}
 <label>{label('当前空间','Current Space')}<select disabled={busy} value={state.active??''} onChange={event=>void run(async()=>setState(await experience.select(event.target.value||null)))}><option value="">{label('我的空间','My Space')}</option>{state.personas.map((persona:any)=><option key={persona.id} value={persona.id}>{persona.name} · {persona.occupation}</option>)}</select></label>
 {state.active&&<p>{label('当前体验空间仅保存在这台电脑，不支持手机配对。','This experience Space stays on this computer and cannot pair with a phone.')}</p>}
 <p>{label('合成资料可直接浏览。输入体验码后，可进行文字对话和更新画像。','Browse the synthetic data freely. Redeem an experience code to chat and refresh the profile.')}</p>
 <label>{label('体验码','Experience code')}<TextField.Root type="password" autoComplete="off" value={code} onChange={event=>setCode(event.target.value)} disabled={busy}/></label>
 <Button disabled={busy||!code.trim()} onClick={()=>void run(async()=>{const value=code;setCode('');await experience.redeem(value);setMessage(label('体验码已验证，可以开始对话。','Experience code accepted. You can start chatting.'))})}>{label('验证体验码','Redeem code')}</Button>
 {message&&<p role="status">{message}</p>}</section>
}
