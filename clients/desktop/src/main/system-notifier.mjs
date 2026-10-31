const MAX_ITEMS=50,MAX_SEEN=1024,MAX_TITLE=120,MAX_BODY=240,MAX_LISTED=3
const PANES=Object.freeze({darwin:'x-apple.systempreferences:com.apple.Notifications-Settings.extension',win32:'ms-settings:notifications'})
export function systemNotificationSettingsUrl(platform){return PANES[platform]??null}
function parse(payload){
 const items=payload?.items
 if(!Array.isArray(items)||items.length>MAX_ITEMS)throw Error('invalid notification payload')
 return items.map(item=>{
  if(typeof item?.id!=='string'||!item.id||item.id.length>128||typeof item.title!=='string'||(item.body!==undefined&&typeof item.body!=='string'))throw Error('invalid notification payload')
  return {id:item.id,title:item.title.trim().slice(0,MAX_TITLE),body:(item.body??'').trim().slice(0,MAX_BODY)}
 })
}
/**
 * Shows an OS notification for proactive messages that land while the workbench is not in front of the user.
 * Electron has no API to read the notification permission, so the only signal is the platform's own `show` and
 * `failed` events: the status reports what actually happened, and the settings pane is one click away.
 */
const identity=(source,...values)=>source.replace(/\{(\d+)\}/g,(match,index)=>values[index]===undefined?match:String(values[index]))
export function createSystemNotifier({Notification,platform=process.platform,isEnabled,windowState,activate,shell,translate=identity,log=()=>{}}){
 const seen=new Set();let state='unverified',error=null
 const status=()=>({supported:Notification.isSupported(),enabled:isEnabled(),state:Notification.isSupported()?state:'unsupported',error})
 function notify(payload){
  const fresh=parse(payload).filter(item=>!seen.has(item.id))
  for(const item of fresh)seen.add(item.id)
  while(seen.size>MAX_SEEN)seen.delete(seen.values().next().value)
  if(!fresh.length)return 'duplicate'
  if(!isEnabled())return 'disabled'
  if(!Notification.isSupported())return 'unsupported'
  const window=windowState()
  if(window.visible&&window.focused)return 'foreground'
  const single=fresh.length===1
  const notification=new Notification({id:'nova-proactive:'+fresh[0].id,silent:false,
   title:single?fresh[0].title:translate('Nova · {0} 条新提醒',fresh.length),
   body:single?fresh[0].body:fresh.slice(0,MAX_LISTED).map(item=>item.title).join(' · ').slice(0,MAX_BODY)})
  notification.on('show',()=>{state='working';error=null})
  notification.on('failed',(_event,reason)=>{state='failed';error=String(reason??'unknown').slice(0,160);log('system_notification_failed')})
  notification.on('click',()=>activate())
  notification.show()
  return 'shown'
 }
 async function openSystemSettings(){
  const url=systemNotificationSettingsUrl(platform)
  if(!url)return false
  await shell.openExternal(url);return true
 }
 return {notify,status,openSystemSettings}
}
