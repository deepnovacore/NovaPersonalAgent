import React, {useEffect, useState} from 'react'
import {Action, Card, Field, useCommand} from './controls'
import {currentLanguage} from '../../locale.mjs'

export function SpaceHostPanel({api}: any) {
 const {state, busy, error, command}=useCommand(api,'personalCommand','space.status')
 const [pending,setPending]=useState<any[]>([]),[pairingError,setPairingError]=useState(''),[fingerprints,setFingerprints]=useState<Record<string,string>>({}),[invitation,setInvitation]=useState<any>(null),[revoke,setRevoke]=useState<string|null>(null)
 const label=(zh:string,en:string)=>currentLanguage()==='en'?en:zh
 useEffect(()=>{
  let active=true;setPending([]);setPairingError('')
  if(state?.mode==='host')void api.personalCommand('space.pairings',{}).then((result:any)=>{if(result?.error)throw Error(result.error);if(active)setPending(Array.isArray(result)?result:[])}).catch((e:any)=>{if(active)setPairingError(e?.message??'unavailable')})
  return ()=>{active=false}
 },[api,state])
 const {qr_image,...wire}=invitation??{}
 return <Card title={label('Space 与手机','Space and phones')}>
  <p>{label('Host 保存全部数据。Host 损坏后此 Space 无法恢复；撤销设备会轮换密钥，但无法收回已下载历史。','The Host keeps all data. Losing the Host loses this Space. Revocation rotates keys but cannot erase previously downloaded history.')}</p>
  {(error||pairingError)&&<p role="alert">{error||pairingError}</p>}
  {state?.mode==='host'?<>
   <p>{state.space}</p>
   <Action disabled={busy} action={()=>command()}>{label('刷新设备','Refresh devices')}</Action>
   <Action disabled={busy} action={async()=>setInvitation(await command('space.invitation'))}>{label('生成一次性配对码','Create one-time pairing code')}</Action>
   {invitation&&<>
    {typeof qr_image==='string'&&qr_image.startsWith('data:image/png;base64,')&&<img src={qr_image} width={240} height={240} alt={label('使用手机扫码绑定','Scan with your phone to pair')}/>}
    <p>{label('只交给你要绑定的手机；配对码会过期。扫码后刷新并核对手机显示的指纹。','Share only with your phone; this code expires. After scanning, refresh and compare the fingerprint shown on the phone.')}</p>
    <Field label={label('配对内容','Pairing payload')} type="textarea" readOnly value={JSON.stringify(wire)} onChange={()=>{}}/>
   </>}
   {pending.map(request=><article key={request.id}>
    <p>{request.device}</p><p>{request.fingerprint}</p>
    <Field label={label('输入手机显示的完整指纹','Enter the full fingerprint shown on the phone')} value={fingerprints[request.id]??''} disabled={busy} onChange={(value:string)=>setFingerprints(previous=>({...previous,[request.id]:value}))}/>
    <Action disabled={busy} action={async()=>{
     const fingerprint=(fingerprints[request.id]??'').trim()
     if(fingerprint!==request.fingerprint)throw Error(label('指纹不匹配，未绑定','Fingerprint mismatch; device not paired'))
     await command('space.confirm_pairing',{id:request.id,fingerprint});setInvitation(null)
    }}>{label('确认绑定','Confirm pairing')}</Action>
   </article>)}
   {(state.clients??[]).map((device:string)=><Action key={device} disabled={busy} action={()=>setRevoke(device)}>{label('撤销 '+device,'Revoke '+device)}</Action>)}
   {revoke&&<div role="group" aria-label={label('确认撤销设备','Confirm device revocation')}>
    <p>{label('撤销 '+revoke+' 后，该设备将无法读取新消息。','After revoking '+revoke+', it cannot read new messages.')}</p>
    <Action disabled={busy} action={async()=>{await command('space.revoke',{device:revoke});setRevoke(null);setInvitation(null)}}>{label('确认撤销并轮换密钥','Confirm revocation and rotate keys')}</Action>
    <Action disabled={busy} action={()=>setRevoke(null)}>{label('取消','Cancel')}</Action>
   </div>}
  </>:<p>{label('尚未配置 Host Space。先使用 nova-space-host init 创建独立空间，再以该配置启动桌面端。','No Host Space configured. Create an independent Space with nova-space-host init, then launch the desktop with its configuration.')}</p>}
 </Card>
}
