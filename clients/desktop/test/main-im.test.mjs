import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('settings IM bridge only forwards closed Feishu commands from the settings window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:feishu'"),source.indexOf("  ipcMain.handle('nova:knowledge:action'"))
 const sender={},calls=[];let receive
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration','backendStatus',block)(
  {handle:(_,fn)=>{receive=fn}},{webContents:sender},{request:async(method,params)=>{calls.push({method,params});return {state:'disconnected'}}},1,{state:'connected'})
 await assert.rejects(receive({sender:{}},{method:'feishu.status',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'memory.evidence',params:{evidence_id:'private'}}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'feishu.status',params:{},extra:true}),/rejected/)
 assert.deepEqual(await receive({sender},{method:'feishu.status',params:{}}),{state:'disconnected'})
 assert.deepEqual(calls,[{method:'feishu.status',params:{}}])
})
