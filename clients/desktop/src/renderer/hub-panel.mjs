import {t} from './locale.mjs'

const STATES = {
 idle:'启用 Mac 后台同步，然后使用 Android Nova 扫码连接。',
 available:'后台同步已就绪，可以生成手机配对二维码。',
 ready:'在 Android Nova 的连接设置中扫码，确认主机后连接。',
 paired:'手机已配对，可以同步资料或连接另一台手机。',
 expired:'二维码已过期，请重新生成。',
 not_installed:'请在 Mac 和 Android 上安装 Tailscale，并登录同一网络。',
 needs_login:'请打开 Tailscale，登录并启用 MagicDNS 和 HTTPS。',
 needs_serve:'Tailscale 已登录，请启用 Hub 的 HTTPS 连接。',
 public_endpoint:'Hub 端口存在 Funnel 公网配置，请先在 Tailscale 中移除。',
 conflict:'Hub 的网络端口已被其他服务占用，未修改现有配置。',
 unavailable:'无法检查 Tailscale，请确认它正在运行后重试。',
 hub_unavailable:'无法连接后台 Hub，请重新启用；若仍失败，请检查本机端口是否被占用。',
 hub_start_failed:'后台 Hub 启动失败。请检查 8787 端口是否被其他 Hub 占用。',
 hub_stop_timeout:'后台 Hub 尚未停止，请稍后重试。',
 hub_service_conflict:'已有同名后台服务，无法自动接管。',
 hub_path_too_long:'用户目录路径过长，无法创建本地管理连接。',
 install_app_first:'请将 Nova 安装到 Mac 本机后再启用后台同步。',
 device_capacity:'已达到 32 台设备上限，请撤销不再使用的设备。',
 unsupported:'此连接流程目前支持 Mac 与 Android。',
}

export function createHubPanel({document, api, confirm = message => globalThis.confirm(message)}) {
 const node=id=>document.getElementById(id)
 let active=false,busy=false,generation=0,timer,expiry=0,primary='enable'
 function countdown() {
  const left=Math.max(0,Math.ceil((expiry-Date.now())/1000))
  node('hub-expiry').textContent=expiry ? (left ? t('二维码剩余 {0} 秒',left) : t('二维码已过期，请重新生成。')) : ''
  if(expiry && !left){node('hub-qr').hidden=true;node('hub-qr').removeAttribute('src')}
 }
 function render(view) {
  node('hub-description').textContent=view.network_cleanup_pending ? t('Hub 已停止，Tailscale 映射尚未移除；网络恢复后可再次移除后台服务。') : t(STATES[view.state]??STATES.hub_unavailable)
  node('hub-host').textContent=view.host??''
  node('hub-qr').hidden=!view.image
  if(view.image)node('hub-qr').src=view.image
  else node('hub-qr').removeAttribute('src')
  expiry=view.expires_at??0;countdown()
  primary=['available','ready','paired','expired','device_capacity'].includes(view.state)?'refresh':'enable'
  node('hub-primary').textContent=t(primary==='refresh'?'生成新二维码':'启用后台同步')
  node('hub-primary').disabled=busy||view.state==='unsupported'
  node('hub-cancel').hidden=!view.image
  node('hub-stop').hidden=!view.service
  node('hub-remove').hidden=!view.service&&!view.installed&&!view.network_cleanup_pending
  const devices=node('hub-devices');devices.replaceChildren()
  for(const device of view.devices??[]){
   const row=document.createElement('div');row.className='phone-device'
   const name=document.createElement('span');name.textContent=device.device_name
   const button=document.createElement('button');button.type='button';button.textContent=t('撤销连接');button.disabled=busy
   button.addEventListener('click',()=>{if(confirm(t('撤销这台手机的同步连接？手机上的本地资料会保留。')))void run('revoke',device.device_id)})
   row.append(name,button);devices.append(row)
  }
 }
 async function run(action='status',deviceId){
  if(busy||!active)return
  const epoch=generation;busy=true
  node('hub-primary').disabled=true
  try{const view=await api.hubAction(action,deviceId);if(epoch===generation){busy=false;render(view)}}
  catch{if(epoch===generation){busy=false;render({state:'hub_unavailable'})}}
  finally{busy=false}
 }
 node('hub-primary').addEventListener('click',()=>void run(primary))
 node('hub-recheck').addEventListener('click',()=>void run())
 node('hub-cancel').addEventListener('click',()=>void run('cancel'))
 for(const action of ['stop','remove'])node(`hub-${action}`).addEventListener('click',()=>{
  if(confirm(t(action==='stop'?'停止后台同步？已连接手机可继续在本机使用。':'移除后台服务？Hub 数据将保留，可再次启用。')))void run(action)
 })
 render({state:'idle'})
 return {setActive(value){
  if(active===value)return
  active=value;generation++;clearInterval(timer)
  if(value){void run();let ticks=0;timer=setInterval(()=>{countdown();if(++ticks%3===0)void run()},1000);timer.unref?.()}
  else{expiry=0;node('hub-qr').hidden=true;node('hub-qr').removeAttribute('src');void api.hubAction('cancel').catch(()=>{})}
 }}
}
