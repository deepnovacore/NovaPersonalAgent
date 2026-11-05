import React, {useEffect, useRef, useState} from 'react'
import {Button} from '@radix-ui/themes'
import {Action, Field, useCommand} from './controls'
import {currentLanguage} from '../../locale.mjs'

/** Main's relay failures arrive as stable codes; these mean the relay itself is out of reach. */
const RELAY_CODES=new Set(['relay_unreachable','relay_unavailable','relay_response_invalid','relay_tls_error','network_unavailable'])

// Rendered inside the standalone #space-host-section page (the left-nav heading
// already names the category), so this panel must not wrap itself in a card.

export function SpaceHostPanel({api}: any) {
 const {state, busy, error, command}=useCommand(api,'personalCommand','space.status')
 const [pending,setPending]=useState<any[]>([]),[pairingError,setPairingError]=useState(''),[fingerprints,setFingerprints]=useState<Record<string,string>>({}),[invitation,setInvitation]=useState<any>(null),[revoke,setRevoke]=useState<string|null>(null)
 const [detailsOpen,setDetailsOpen]=useState(false),[invitationFailed,setInvitationFailed]=useState(false)
 const createInvitation=async()=>{setInvitationFailed(false);try{setInvitation(await command('space.invitation'))}catch(error){setInvitationFailed(true);throw error}}
 const label=(zh:string,en:string)=>currentLanguage()==='en'?en:zh
 const relayMessage=label('无法连接中继服务。请检查网络、Tailscale 与中继地址后重试。','Cannot reach the relay service. Check your network, Tailscale and the relay address, then retry.')
 // Transport failures (raw `fetch failed`, or a code main assigns to an unreachable relay) never show verbatim.
 const pairingMessage=(reason:string)=>{
  if(RELAY_CODES.has(reason)||/fetch failed|ECONNREFUSED|ETIMEDOUT/iu.test(reason))return relayMessage
  if(reason==='pairing_request_expired')return label('配对请求已过期，请重新生成配对码并扫码。','The pairing request expired. Generate a new code and scan it again.')
  if(reason==='pairing_fingerprint_mismatch')return label('手机指纹不匹配，请核对手机上显示的完整指纹。','The phone fingerprint does not match. Check the full fingerprint displayed on your phone.')
  if(/^[a-z_]+$/u.test(reason))return label('连接未完成，请刷新后重试。','Connection was not completed. Refresh and try again.')
  return label('操作未完成，请重新尝试；若持续失败，请检查后台连接。','The operation did not complete. Try again; if it persists, check the backend connection.')
 }
 useEffect(()=>{
  let active=true;setPending([]);setPairingError('')
  if(state?.mode==='host')void api.personalCommand('space.pairings',{}).then((result:any)=>{if(result?.error)throw Error(result.error);if(active)setPending(Array.isArray(result)?result:[])}).catch((e:any)=>{if(active)setPairingError(e?.message??'unavailable')})
  return ()=>{active=false}
 },[api,state])
 const {qr_image,...wire}=invitation??{}
 return <div className="space-host-panel" aria-busy={busy}>
  <h3>{label('连接手机','Connect your phone')}</h3>
  <p className="personal-hint">{label('扫码后，在电脑确认手机指纹。','Scan the code, then confirm your phone’s fingerprint on this computer.')}</p>
  {(error||pairingError)&&<div className="space-host-actions" role="alert"><p>{pairingMessage(error||pairingError)}</p><Action disabled={busy} action={invitationFailed?createInvitation:()=>command()}>{invitationFailed?label('重试生成配对码','Retry pairing code'):error&&state?label('刷新连接状态','Refresh connection status'):label('重试','Retry')}</Action></div>}
  {state?.mode==='host'?<>
   <div className="space-host-actions">
    <Action disabled={busy} action={()=>command()}>{label('刷新设备','Refresh devices')}</Action>
    <Action disabled={busy} action={createInvitation}>{label('生成一次性配对码','Create one-time pairing code')}</Action>
   </div>
   {invitation&&<div className="space-host-invitation">
    {typeof qr_image==='string'&&qr_image.startsWith('data:image/png;base64,')&&<img src={qr_image} width={240} height={240} alt={label('使用手机扫码绑定','Scan with your phone to pair')}/>}
   </div>}
   {pending.length>0&&<div className="space-host-pairings">
    {pending.map(request=>{const expired=typeof request.expiresAt==='number'&&request.expiresAt<=Date.now();return <article key={request.id} className="space-host-pairing">
     <p className="space-host-pairing-device"><strong>{label('待连接的手机','Phone waiting to connect')}</strong></p><p className="space-host-pairing-fingerprint">{request.fingerprint}</p>
     <Field label={label('输入手机显示的完整指纹','Enter the full fingerprint shown on the phone')} value={fingerprints[request.id]??''} disabled={busy} onChange={(value:string)=>setFingerprints(previous=>({...previous,[request.id]:value}))}/>
     {expired&&<><p role="status">{pairingMessage('pairing_request_expired')}</p><Action disabled={busy} action={createInvitation}>{label('重新生成配对码','Generate a new pairing code')}</Action></>}
     <Action disabled={busy||expired} action={async()=>{
      const fingerprint=(fingerprints[request.id]??'').trim()
      if(fingerprint!==request.fingerprint)throw Error(label('指纹不匹配，未绑定','Fingerprint mismatch; device not paired'))
      try{await command('space.confirm_pairing',{id:request.id,fingerprint});setInvitation(null)}catch(e:any){
       try{const result=await api.personalCommand('space.pairings',{});if(!result?.error)setPending(Array.isArray(result)?result:[])}catch{/* Keep the confirmation error visible if refreshing also fails. */}
       throw Error(pairingMessage(e?.message??'unavailable'))
      }
     }}>{label('确认绑定','Confirm pairing')}</Action>
    </article>})}
   </div>}
   <details open={detailsOpen} onToggle={event=>setDetailsOpen(event.currentTarget.open)}>
    <summary>{label('连接详情','Connection details')}</summary>
    <>
     <p className="space-host-space">{state.space}</p>
     {typeof state.relay_url==='string'&&<p className="space-host-relay">{label('中继地址','Relay')} · {state.relay_url}</p>}
     <p>{label('数据保存在这台电脑，请定期备份。电脑数据丢失后无法恢复连接历史。断开手机不会删除其已下载的内容。','Your data stays on this computer. Back it up regularly; lost data cannot be recovered. Disconnecting a phone does not erase content it has already downloaded.')}</p>
     {invitation&&<Field label={label('配对内容','Pairing payload')} type="textarea" readOnly value={JSON.stringify(wire)} onChange={()=>{}}/>}
     {pending.map(request=><p key={request.id}>{request.device}</p>)}
     {(state.clients??[]).length>0&&<div className="space-host-devices">
      {(state.clients??[]).map((device:string)=><Action key={device} disabled={busy} action={()=>setRevoke(device)}>{label('撤销 '+device,'Revoke '+device)}</Action>)}
     </div>}
    </>
   </details>
   {revoke&&<div className="space-host-confirm" role="group" aria-label={label('确认撤销设备','Confirm device revocation')}>
    <p>{label('断开后，这部手机将无法读取新消息，已下载的内容仍会保留。','After disconnecting, this phone cannot read new messages. Downloaded content remains on it.')}</p>
    <div className="space-host-actions">
     <Action disabled={busy} action={async()=>{await command('space.revoke',{device:revoke});setRevoke(null);setInvitation(null)}}>{label('确认撤销并轮换密钥','Confirm revocation and rotate keys')}</Action>
     <Action disabled={busy} action={()=>setRevoke(null)}>{label('取消','Cancel')}</Action>
    </div>
   </div>}
  </>:state?<SpaceCreateForm api={api} label={label} onReady={async()=>{await command();setInvitation(await command('space.invitation'))}}/>:null}
 </div>
}

const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]'])
// Codes come from main's closed list (space-create.mjs); anything else gets the generic message.
function createFailure(code:string,relayUrl:string|undefined,label:(zh:string,en:string)=>string){
 const messages:Record<string,[string,string]>={
  tailscale_not_installed:['请先安装 Tailscale，并登录电脑和手机。','Install Tailscale and sign in on your computer and phone first.'],
  tailscale_unavailable:['无法读取 Tailscale，请打开 Tailscale 确认已登录并重试。','Cannot read Tailscale. Open it, check you are signed in, and retry.'],
  tailscale_not_running:['请先连接 Tailscale，再重试创建。','Connect Tailscale before creating a Space.'],
  tailscale_https_required:['请在 Tailscale 管理页开启 MagicDNS 和 HTTPS 证书，再重试。','Enable MagicDNS and HTTPS certificates in Tailscale, then retry.'],
  tailscale_port_in_use:['Tailscale 的可用端口均已有服务。请保留现有服务并使用高级选项，或释放该端口后重试。','All supported Tailscale ports already host services. Use the advanced option, or free that port and retry.'],
  tailscale_identity_changed:['此空间绑定的 Tailscale 电脑地址已改变。请恢复原地址后重试；现有数据已保留。','The Tailscale address for this Space changed. Restore the original address and retry; existing data is preserved.'],
  tailscale_serve_failed:['Tailscale HTTPS 入口未能启动。请检查 HTTPS 授权和 Tailscale 版本后重试。','Tailscale HTTPS could not start. Check HTTPS authorization and your Tailscale version, then retry.'],
  bootstrap_denied:['Relay 拒绝了 bootstrap 凭据，请核对后重试。','The relay rejected the bootstrap credential. Check it and try again.'],
  relay_unreachable:['无法连接 relay。请检查地址与网络后重试；重试会沿用同一个空间身份。','Cannot reach the relay. Check the address and network, then retry; a retry keeps the same Space identity.'],
  relay_tls_required:['Relay 必须使用 HTTPS（仅本机地址可用 HTTP）。','The relay must use HTTPS (HTTP only for this computer).'],
  relay_url_invalid:['Relay 地址只能是 https://主机[:端口]，不能带路径、参数或账号。','The relay address must be https://host[:port] with no path, query or credentials.'],
  relay_rejected:['Relay 拒绝了请求，请稍后重试。','The relay refused the request. Try again later.'],
  bootstrap_token_too_short:['Bootstrap 凭据至少 32 个字符。','The bootstrap credential needs at least 32 characters.'],
  bootstrap_token_invalid:['Bootstrap 凭据含有无效字符。','The bootstrap credential contains invalid characters.'],
  space_already_created:['已经创建过空间。请点击重启后台使其生效。','A Space already exists. Restart the backend to use it.'],
  space_create_busy:['正在创建空间，请稍候。','A Space is already being created.'],
  space_existing_data_unavailable:['请先启动本机后台并确认现有数据可用，再重试连接。','Start the local backend and confirm existing data is available, then retry.'],
  space_data_exists:['空间数据目录已存在，无法新建。','The Space data folder already exists; a new Space cannot be created.'],
  space_directory_not_private:['空间目录权限过宽，需仅当前用户可访问。','The Space folder must be accessible only to your user.'],
  space_config_invalid:['上次未完成的空间配置已损坏，无法继续。','The unfinished Space configuration is damaged and cannot be resumed.'],
 }
 if(code==='space_relay_mismatch')return label('上次未完成的空间使用 '+(relayUrl??'')+'，请填写同一地址继续。','The unfinished Space uses '+(relayUrl??'')+'. Enter the same address to continue.')
 const message=messages[code]??['创建失败，请稍后重试。','Creation failed. Try again later.']
 return label(message[0],message[1])
}

export function SpaceCreateForm({api,label,onReady}:{api:any;label:(zh:string,en:string)=>string;onReady:()=>Promise<unknown>}){
 const [mode,setMode]=useState('tailscale'),[dataMode,setDataMode]=useState('isolated')
 const [relayUrl,setRelayUrl]=useState(''),[token,setToken]=useState(''),[reveal,setReveal]=useState(false)
 const [phase,setPhase]=useState<'idle'|'creating'|'restarting'|'restart_failed'>('idle'),[problem,setProblem]=useState('')
 const active=useRef(true),lock=useRef(false)
 useEffect(()=>{active.current=true;return ()=>{active.current=false}},[])
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
  if(mode==='manual'&&(!url||!parsed)){setProblem(label('请填写 relay 地址，例如 https://relay.example.com。','Enter the relay address, e.g. https://relay.example.com.'));return}
  if(mode==='manual'&&parsed&&parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&LOOPBACK.has(parsed.hostname))){setProblem(createFailure('relay_tls_required',undefined,label));return}
  if(mode==='manual'&&secret.length<32){setProblem(createFailure('bootstrap_token_too_short',undefined,label));return}
  if(typeof api?.spaceCreate!=='function'){setProblem(createFailure('',undefined,label));return}
  lock.current=true;setPhase('creating');setProblem('')
  try{
   let result:any
   try{result=await api.spaceCreate(mode==='tailscale'?{mode:'tailscale',dataMode}:{relayUrl:url,bootstrapToken:secret,dataMode})}catch{result={ok:false,error:'space_create_failed'}}
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
  <p className="space-host-empty">{label('连接本机数据，或新建一个全新空间。','Connect your existing data, or start a new Space.')}</p>
  <Field label={label('空间数据','Space data')} value={dataMode} disabled={working||phase==='restart_failed'} options={[{value:'isolated',label:label('新建空白空间','Start a new Space')},{value:'existing',label:label('连接本机现有数据','Connect existing data on this computer')}]} onChange={setDataMode}/>
  {dataMode==='existing'&&<p>{label('连接后，配对的手机可查看本机数据。','Paired phones will be able to view your data on this computer.')}</p>}
  <Field label={label('连接方式','Connection')} value={mode} disabled={working||phase==='restart_failed'} options={[{value:'tailscale',label:label('Tailscale 自动配置','Tailscale automatic setup')},{value:'manual',label:label('高级：使用已有 Relay','Advanced: existing relay')}]} onChange={setMode}/>
  {mode==='manual'&&<>
  <Field label={label('Relay 地址','Relay address')} value={relayUrl} placeholder="https://relay.example.com" disabled={working||phase==='restart_failed'} autoComplete="off" spellCheck={false} onChange={setRelayUrl}/>
  <div className="space-host-token">
   <Field label={label('Bootstrap 凭据','Bootstrap credential')} type={reveal?'text':'password'} value={token} disabled={working||phase==='restart_failed'} autoComplete="off" spellCheck={false} onChange={setToken}/>
   <Button type="button" variant="soft" disabled={working||phase==='restart_failed'} onClick={()=>setReveal(value=>!value)}>{reveal?label('隐藏凭据','Hide credential'):label('显示凭据','Show credential')}</Button>
  </div>
  </>}
  <div className="space-host-actions">
   <Button type="button" disabled={working||phase==='restart_failed'} aria-busy={working} onClick={()=>void create()}>{dataMode==='existing'?label('连接本机数据','Connect existing data'):label('创建空间','Create Space')}</Button>
   {phase==='restart_failed'&&<Button type="button" onClick={()=>void restart()}>{label('重启后台','Restart backend')}</Button>}
  </div>
  {phase==='creating'&&<p role="status">{label('正在创建空间…','Creating the Space…')}</p>}
  {phase==='restarting'&&<p role="status">{label('空间已创建，正在重启后台…','Space created. Restarting the backend…')}</p>}
  {problem&&<p role="alert">{problem}</p>}
  <details><summary>{label('连接详情','Connection details')}</summary><p>{label('电脑和手机需登录同一个 Tailscale 网络，并开启电脑的 MagicDNS 与 HTTPS 证书。数据保存在电脑，请定期备份。','Use the same Tailscale network on both devices, with MagicDNS and HTTPS certificates enabled on this computer. Back up your data regularly.')}</p></details>
 </div>
}
