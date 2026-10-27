import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {installWelcomeIpc} from '../src/main/welcome-ipc.mjs'

test('Computer Use preflight receives the current display count without capturing the screen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-displays-')),handlers=new Map(),mainFrame={},webContents={mainFrame},window={webContents,isDestroyed:()=>false}
 let count=2
 try{
  installWelcomeIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},app:{getPath:()=>root},screen:{getAllDisplays:()=>Array.from({length:count},(_,id)=>({id}))},systemPreferences:{getMediaAccessStatus:()=> 'granted',isTrustedAccessibilityClient:()=>true},windows:()=>[window],environment:()=>({}),backendReady:()=>true})
  const read=()=>handlers.get('nova:welcome:get')({sender:webContents,senderFrame:mainFrame})
  assert.equal((await read()).permissions.displayCount,2)
  count=1;assert.equal((await read()).permissions.displayCount,1)
 }finally{await rm(root,{recursive:true,force:true})}
})
