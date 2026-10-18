const PANES=Object.freeze({microphone:'Privacy_Microphone',screen:'Privacy_ScreenCapture',accessibility:'Privacy_Accessibility'})
export function readDesktopPermissions({platform,systemPreferences,environment={},backendReady=false}){
 const media=kind=>{try{return systemPreferences.getMediaAccessStatus(kind)}catch{return 'unknown'}}
 let accessibility='unsupported',screen='unsupported',microphone='unsupported'
 if(platform==='darwin'){
  microphone=media('microphone');screen=media('screen')
  try{accessibility=systemPreferences.isTrustedAccessibilityClient(false)?'granted':'denied'}catch{accessibility='unknown'}
 }else if(platform==='win32'){microphone=media('microphone');screen=accessibility='not_required'}
 const selected=(environment.EXECUTORS??environment.EXECUTOR??'').split(',').map(s=>s.trim()).includes('computer')
 const computerConfigured=selected&&['COMPUTER_DISPLAY_ID','COMPUTER_BASE_URL','COMPUTER_MODEL','COMPUTER_MODEL_FAMILY','COMPUTER_API_KEY'].every(key=>Boolean(environment[key]))
 return {platform,microphone,screen,accessibility,computerConfigured,computerReady:computerConfigured&&backendReady&&['granted','not_required'].includes(screen)&&['granted','not_required'].includes(accessibility)}
}
export async function requestDesktopPermission(kind,{platform,systemPreferences,shell,desktopCapturer}){
 if(!Object.hasOwn(PANES,kind))throw Error('invalid_permission')
 if(platform==='darwin'){
  if(kind==='microphone'&&systemPreferences.getMediaAccessStatus('microphone')==='not-determined')await systemPreferences.askForMediaAccess('microphone')
  else if(kind==='screen'&&desktopCapturer){
   try{await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1,height:1},fetchWindowIcons:false})}catch{/* Denied capture still offers the privacy pane. */}
   if(systemPreferences.getMediaAccessStatus('screen')!=='granted')await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?'+PANES.screen)
  }
  else if(kind==='accessibility'){systemPreferences.isTrustedAccessibilityClient(true);await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?'+PANES[kind])}
  else await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?'+PANES[kind])
 }else if(platform==='win32'&&kind==='microphone')await shell.openExternal('ms-settings:privacy-microphone')
}
