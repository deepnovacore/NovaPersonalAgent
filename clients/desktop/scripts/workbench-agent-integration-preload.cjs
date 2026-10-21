const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('workbenchAcceptance',{
 send:frame=>ipcRenderer.send('acceptance:frame',frame),
 directory:()=>ipcRenderer.invoke('acceptance:directory'),
 onFrame:listener=>ipcRenderer.on('acceptance:frame',(_event,frame)=>listener(frame)),
 ready:()=>ipcRenderer.send('acceptance:ready'),
})
