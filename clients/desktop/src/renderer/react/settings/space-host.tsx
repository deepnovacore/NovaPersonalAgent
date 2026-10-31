import React, {useEffect, useRef, useState} from 'react'
import {Button} from '@radix-ui/themes'
import {Action, Field, useCommand} from './controls'
import {currentLanguage} from '../../locale.mjs'

// Rendered inside the standalone #space-host-section page (the left-nav heading
// already names the category), so this panel must not wrap itself in a card.

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
 return <div className="space-host-panel" aria-busy={busy}>
  <p className="personal-hint">{label('Host 保存全部数据。Host 损坏后此 Space 无法恢复；撤销设备会轮换密钥，但无法收回已下载历史。','The Host keeps all data. Losing the Host loses this Space. Revocation rotates keys but cannot erase previously downloaded history.')}</p>
  {(error||pairingError)&&<p role="alert">{error||pairingError}</p>}
  {state?.mode==='host'?<>
   <p className="space-host-space"><strong>{label('当前 Space','Current Space')}</strong> · {state.space}</p>
   <div className="space-host-actions">
    <Action disabled={busy} action={()=>command()}>{label('刷新设备','Refresh devices')}</Action>
    <Action disabled={busy} action={async()=>setInvitation(await command('space.invitation'))}>{label('生成一次性配对码','Create one-time pairing code')}</Action>
   </div>
   {invitation&&<div className="space-host-invitation">
    {typeof qr_image==='string'&&qr_image.startsWith('data:image/png;base64,')&&<img src={qr_image} width={240} height={240} alt={label('使用手机扫码绑定','Scan with your phone to pair')}/>}
    <p>{label('只交给你要绑定的手机；配对码会过期。扫码后刷新并核对手机显示的指纹。','Share only with your phone; this code expires. After scanning, refresh and compare the fingerprint shown on the phone.')}</p>
    <Field label={label('配对内容','Pairing payload')} type="textarea" readOnly value={JSON.stringify(wire)} onChange={()=>{}}/>
   </div>}
   {pending.length>0&&<div className="space-host-pairings">
    {pending.map(request=><article key={request.id} className="space-host-pairing">
     <p className="space-host-pairing-device"><strong>{request.device}</strong></p><p className="space-host-pairing-fingerprint">{request.fingerprint}</p>
     <Field label={label('输入手机显示的完整指纹','Enter the full fingerprint shown on the phone')} value={fingerprints[request.id]??''} disabled={busy} onChange={(value:string)=>setFingerprints(previous=>({...previous,[request.id]:value}))}/>
     <Action disabled={busy} action={async()=>{
      const fingerprint=(fingerprints[request.id]??'').trim()
      if(fingerprint!==request.fingerprint)throw Error(label('指纹不匹配，未绑定','Fingerprint mismatch; device not paired'))
      await command('space.confirm_pairing',{id:request.id,fingerprint});setInvitation(null)
     }}>{label('确认绑定','Confirm pairing')}</Action>
    </article>)}
   </div>}
   {(state.clients??[]).length>0&&<div className="space-host-devices">
    {(state.clients??[]).map((device:string)=><Action key={device} disabled={busy} action={()=>setRevoke(device)}>{label('撤销 '+device,'Revoke '+device)}</Action>)}
   </div>}
   {revoke&&<div className="space-host-confirm" role="group" aria-label={label('确认撤销设备','Confirm device revocation')}>
    <p>{label('撤销 '+revoke+' 后，该设备将无法读取新消息。','After revoking '+revoke+', it cannot read new messages.')}</p>
    <div className="space-host-actions">
     <Action disabled={busy} action={async()=>{await command('space.revoke',{device:revoke});setRevoke(null);setInvitation(null)}}>{label('确认撤销并轮换密钥','Confirm revocation and rotate keys')}</Action>
     <Action disabled={busy} action={()=>setRevoke(null)}>{label('取消','Cancel')}</Action>
    </div>
   </div>}
  </>:state?<SpaceCreateForm api={api} label={label} onReady={()=>command()}/>:null}
 </div>
}

const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]'])
// Codes come from main's closed list (space-create.mjs); anything else gets the generic message.
function createFailure(code:string,relayUrl:string|undefined,label:(zh:string,en:string)=>string){
 const messages:Record<string,[string,string]>={
  bootstrap_denied:['Relay 拒绝了 bootstrap 凭据，请核对后重试。','The relay rejected the bootstrap credential. Check it and try again.'],
  relay_unreachable:['无法连接 relay。请检查地址与网络后重试；重试会沿用同一个空间身份。','Cannot reach the relay. Check the address and network, then retry; a retry keeps the same Space identity.'],
  relay_tls_required:['Relay 必须使用 HTTPS（仅本机地址可用 HTTP）。','The relay must use HTTPS (HTTP only for this computer).'],
  relay_url_invalid:['Relay 地址只能是 https://主机[:端口]，不能带路径、参数或账号。','The relay address must be https://host[:port] with no path, query or credentials.'],
  relay_rejected:['Relay 拒绝了请求，请稍后重试。','The relay refused the request. Try again later.'],
  bootstrap_token_too_short:['Bootstrap 凭据至少 32 个字符。','The bootstrap credential needs at least 32 characters.'],
  bootstrap_token_invalid:['Bootstrap 凭据含有无效字符。','The bootstrap credential contains invalid characters.'],
  space_already_created:['已经创建过空间。请点击重启后台使其生效。','A Space already exists. Restart the backend to use it.'],
  space_create_busy:['正在创建空间，请稍候。','A Space is already being created.'],
  space_data_exists:['空间数据目录已存在，无法新建。','The Space data folder already exists; a new Space cannot be created.'],
  space_directory_not_private:['空间目录权限过宽，需仅当前用户可访问。','The Space folder must be accessible only to your user.'],
  space_config_invalid:['上次未完成的空间配置已损坏，无法继续。','The unfinished Space configuration is damaged and cannot be resumed.'],
 }
 if(code==='space_relay_mismatch')return label('上次未完成的空间使用 '+(relayUrl??'')+'，请填写同一地址继续。','The unfinished Space uses '+(relayUrl??'')+'. Enter the same address to continue.')
 const message=messages[code]??['创建失败，请稍后重试。','Creation failed. Try again later.']
 return label(message[0],message[1])
}

function SpaceCreateForm({api,label,onReady}:{api:any;label:(zh:string,en:string)=>string;onReady:()=>Promise<unknown>}){
 const [relayUrl,setRelayUrl]=useState(''),[token,setToken]=useState(''),[reveal,setReveal]=useState(false)
 const [phase,setPhase]=useState<'idle'|'creating'|'restarting'|'restart_failed'>('idle'),[problem,setProblem]=useState('')
 const active=useRef(true),lock=useRef(false)
 useEffect(()=>()=>{active.current=false},[])
 const restart=async()=>{
  setPhase('restarting');setProblem('')
  let applied=false
  try{applied=(await api.restart())?.operationStatus==='applied'}catch{applied=false}
  if(!active.current)return
  if(!applied){setPhase('restart_failed');setProblem(label('空间已创建，但后台未能重启。请重启后台后再配对手机。','The Space was created, but the backend did not restart. Restart it before pairing a phone.'));return}
  setPhase('idle');await onReady().catch(()=>{})
 }
 const create=async()=>{
  if(lock.current)return
  const url=relayUrl.trim(),secret=token.trim()
  let parsed:URL|undefined
  try{parsed=new URL(url)}catch{parsed=undefined}
  if(!url||!parsed){setProblem(label('请填写 relay 地址，例如 https://relay.example.com。','Enter the relay address, e.g. https://relay.example.com.'));return}
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&LOOPBACK.has(parsed.hostname))){setProblem(createFailure('relay_tls_required',undefined,label));return}
  if(secret.length<32){setProblem(createFailure('bootstrap_token_too_short',undefined,label));return}
  if(typeof api?.spaceCreate!=='function'){setProblem(createFailure('',undefined,label));return}
  lock.current=true;setPhase('creating');setProblem('')
  try{
   let result:any
   try{result=await api.spaceCreate({relayUrl:url,bootstrapToken:secret})}catch{result={ok:false,error:'space_create_failed'}}
   if(!active.current)return
   if(result?.error==='space_already_created'){
    let hosted=false
    try{hosted=(await api.personalCommand('space.status',{}))?.mode==='host'}catch{hosted=false}
    if(!active.current)return
    if(!hosted){setPhase('restart_failed');setProblem(label('空间已创建，重启后台后生效','Space created. Restart the backend to use it.'));return}
   }
   if(result?.ok!==true){setPhase('idle');setProblem(createFailure(String(result?.error??''),typeof result?.relayUrl==='string'?result.relayUrl:undefined,label));return}
   setToken('');setReveal(false)
   await restart()
  }finally{lock.current=false}
 }
 const working=phase==='creating'||phase==='restarting'
 return <div className="space-host-create" aria-busy={working}>
  <p className="space-host-empty">{label('尚未配置 Host Space。在这里新建一个空间：新空间是全新数据，不会迁移本机现有数据。需要一个可用的 HTTPS relay 及其 bootstrap 凭据。','No Host Space yet. Create one here: a new Space starts with fresh data and does not migrate existing data on this computer. You need a working HTTPS relay and its bootstrap credential.')}</p>
  <Field label={label('Relay 地址','Relay address')} value={relayUrl} placeholder="https://relay.example.com" disabled={working||phase==='restart_failed'} autoComplete="off" spellCheck={false} onChange={setRelayUrl}/>
  <div className="space-host-token">
   <Field label={label('Bootstrap 凭据','Bootstrap credential')} type={reveal?'text':'password'} value={token} disabled={working||phase==='restart_failed'} autoComplete="off" spellCheck={false} onChange={setToken}/>
   <Button type="button" variant="soft" disabled={working||phase==='restart_failed'} onClick={()=>setReveal(value=>!value)}>{reveal?label('隐藏凭据','Hide credential'):label('显示凭据','Show credential')}</Button>
  </div>
  <div className="space-host-actions">
   <Button type="button" disabled={working||phase==='restart_failed'} aria-busy={working} onClick={()=>void create()}>{label('创建空间','Create Space')}</Button>
   {phase==='restart_failed'&&<Button type="button" onClick={()=>void restart()}>{label('重启后台','Restart backend')}</Button>}
  </div>
  {phase==='creating'&&<p role="status">{label('正在创建空间…','Creating the Space…')}</p>}
  {phase==='restarting'&&<p role="status">{label('空间已创建，正在重启后台…','Space created. Restarting the backend…')}</p>}
  {problem&&<p role="alert">{problem}</p>}
  <p className="space-host-empty">{label('也可以用命令行 nova-space-host init 创建，再以 NOVA_SPACE_HOST_CONFIG 启动桌面端。','You can also create one with nova-space-host init and launch the desktop with NOVA_SPACE_HOST_CONFIG.')}</p>
 </div>
}
