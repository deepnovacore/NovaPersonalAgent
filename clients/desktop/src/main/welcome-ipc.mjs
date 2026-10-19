import {readFile,stat} from 'node:fs/promises'
import {createWelcomeStore,validateWelcomePatch} from './welcome-store.mjs'
import {readDesktopPermissions,requestDesktopPermission} from './desktop-permissions.mjs'
/** Only the two application-owned main frames can read or edit this local profile. */
export function installWelcomeIpc({ipcMain,app,dialog,nativeImage,systemPreferences,shell,desktopCapturer,windows,environment,backendReady}){
 const store=createWelcomeStore(app.getPath('userData')+'/welcome-profile.json')
 let defaultImage
 const avatar=()=>defaultImage??=readFile(new URL('./default-avatar.png',import.meta.url)).then(bytes=>'data:image/png;base64,'+bytes.toString('base64'))
 const authorize=event=>{
  const window=windows().find(w=>w&&!w.isDestroyed()&&event.sender===w.webContents)
  if(!window||event.senderFrame!==event.sender.mainFrame)throw Error('welcome_access_denied')
  return window
 }
 const permissions=()=>readDesktopPermissions({platform:process.platform,systemPreferences,environment:environment(),backendReady:backendReady()})
 const view=async()=>({profile:await store.get(),defaultAvatar:await avatar(),permissions:permissions()})
 const publish=async()=>{const value=await view();for(const w of windows())if(w&&!w.isDestroyed())w.webContents.send('nova:welcome:changed',value);return value}
 ipcMain.handle('nova:welcome:get',event=>{authorize(event);return view()})
 ipcMain.handle('nova:welcome:save',async(event,patch)=>{authorize(event);validateWelcomePatch(patch);if(Object.hasOwn(patch,'avatar'))throw Error('use_avatar_picker');await store.update(patch);return publish()})
 ipcMain.handle('nova:welcome:avatar',async(event,reset=false)=>{
  const window=authorize(event)
  if(typeof reset!=='boolean')throw Error('invalid_avatar_action')
  if(reset){await store.update({avatar:null});return publish()}
  const result=await dialog.showOpenDialog(window,{title:'选择头像',properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]})
  if(result.canceled||!result.filePaths[0])return view()
  const file=result.filePaths[0],info=await stat(file)
  if(!info.isFile()||info.size>8*1024*1024)throw Error('avatar_too_large')
  const bytes=await readFile(file);if(bytes.length>8*1024*1024)throw Error('avatar_too_large')
  const image=nativeImage.createFromBuffer(bytes),size=image.getSize()
  if(image.isEmpty()||!size.width||!size.height||size.width*size.height>40_000_000)throw Error('invalid_avatar')
  // Preserve aspect ratio; the view crops with object-fit. Decode and re-encode to discard metadata and active formats.
  const resized=image.resize(size.width>=size.height?{width:512}:{height:512})
  await store.update({avatar:'data:image/png;base64,'+resized.toPNG().toString('base64')});return publish()
 })
 ipcMain.handle('nova:welcome:permission',async(event,kind)=>{authorize(event);await requestDesktopPermission(kind,{platform:process.platform,systemPreferences,shell,desktopCapturer});return view()})
 return {get:()=>store.get()}
}
