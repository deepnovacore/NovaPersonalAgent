import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ExperienceSpaces} from './experience-spaces.mjs'
export function installExperienceIpc({ipcMain,app,windows,codec,loadRuntime,fetcher,complete}){
 const allowed=event=>windows().some(window=>window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame)
 const service=new ExperienceSpaces({directory:join(app.getPath('userData'),'novacore-experience-v1'),codec,loadRuntime,fetcher,complete,
  loadAssets:async()=>{const module=app.isPackaged?await import(pathToFileURL(join(process.resourcesPath,'experience-assets.mjs')).href):await import('../../../../scripts/lib/experience-assets.mjs');return module.loadExperience(app.isPackaged?join(process.resourcesPath,'experience'):process.env.NOVACORE_EXPERIENCE_DIR??join(app.getAppPath(),'experience'),{required:false})},
  changed:value=>{for(const window of windows())if(window&&!window.isDestroyed())window.webContents.send('nova:experience:changed',value)},
 })
 for(const method of ['list','select','redeem','send'])ipcMain.handle('nova:experience:'+method,async(event,payload)=>{if(!allowed(event))throw Error('experience_access_denied');try{return await service[method](payload)}catch(error){const code=typeof error?.message==='string'&&/^experience_[a-z_]+$/.test(error.message)?error.message:'experience_unavailable';throw Error(code)}})
 return service
}
