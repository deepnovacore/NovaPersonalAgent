const {contextBridge,ipcRenderer} = require('electron')
contextBridge.exposeInMainWorld('computerOverlay',Object.freeze({
  language:process.argv.includes('--nova-language=en')?'en':'zh-CN',
  snapshot:()=>ipcRenderer.invoke('nova:computer-overlay:get'),
  stop:()=>ipcRenderer.invoke('nova:computer-overlay:stop'),
  onChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('nova:computer-overlay:changed',listener);return ()=>ipcRenderer.removeListener('nova:computer-overlay:changed',listener)},
}))
