import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('settings IM bridge only forwards closed Feishu commands from the settings window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:feishu'"),source.indexOf("  ipcMain.handle('nova:settings:personal'"))
 const sender={},calls=[];let receive
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration','backendStatus',block)(
  {handle:(_,fn)=>{receive=fn}},{webContents:sender},{request:async(method,params)=>{calls.push({method,params});return {state:'disconnected'}}},1,{state:'connected'})
 await assert.rejects(receive({sender:{}},{method:'feishu.status',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'memory.evidence',params:{evidence_id:'private'}}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'feishu.status',params:{},extra:true}),/rejected/)
 assert.deepEqual(await receive({sender},{method:'feishu.status',params:{}}),{state:'disconnected'})
 for(const consent of [false,true])await receive({sender},{method:'feishu.consent',params:{consent}})
 assert.deepEqual(calls,[{method:'feishu.status',params:{}},{method:'feishu.consent',params:{consent:false}},{method:'feishu.consent',params:{consent:true}}])
})

test('settings connections bridge only forwards sources, connectors and discovery methods from the settings window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:personal'"),source.indexOf("  ipcMain.handle('nova:knowledge:action'"))
 const sender={},calls=[];let receive
 const control={request:async(method,params)=>{calls.push({method,params});return {sources:[]}}}
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration',block)({handle:(_,fn)=>{receive=fn}},{webContents:sender},control,1)
 await assert.rejects(receive({sender:{}},{method:'state',params:{}}),/rejected/)
 for(const method of ['memory.list','memory.evidence','feed.action','conversations.select','life.mutate','news.refresh','understanding.action','feishu.status'])await assert.rejects(receive({sender},{method,params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:{},extra:true}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:null}),/rejected/)
 await assert.rejects(receive({sender},{method:'sources.add',params:{path:'x'.repeat(17000),consent:true}}),/rejected/)
 assert.deepEqual(await receive({sender},{method:'state',params:{}}),{sources:[]})
 await receive({sender},{method:'discovery.configure',params:{enabled:false}})
 for(const method of ['sources.priority.add','sources.priority.remove'])await receive({sender},{method,params:{path:'/Users/me/Documents'}})
 assert.deepEqual(calls,[{method:'state',params:{}},{method:'discovery.configure',params:{enabled:false}},
  {method:'sources.priority.add',params:{path:'/Users/me/Documents'}},{method:'sources.priority.remove',params:{path:'/Users/me/Documents'}}])
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration',block)({handle:(_,fn)=>{receive=fn}},{webContents:sender},null,1)
 await assert.rejects(receive({sender},{method:'state',params:{}}),/unavailable/)
})

test('directory and connector authorization IPC accept both windows and reject others', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const mainWindow={webContents:{}},settingsWindow={webContents:{}},opened=[],dialogs=[]
 const connector=source.slice(source.indexOf("  ipcMain.handle('nova:personal:connector-authorization'"),source.indexOf("  ipcMain.handle('nova:personal:shared-ideas'"))
 let handler;new Function('ipcMain','mainWindow','settingsWindow','shell','connectorAuthorizationUrl',connector)({handle:(_,fn)=>{handler=fn}},mainWindow,settingsWindow,{openExternal:async url=>opened.push(url)},url=>url)
 await assert.rejects(handler({sender:{}},'https://x'),/rejected/)
 await handler({sender:mainWindow.webContents},'https://a');await handler({sender:settingsWindow.webContents},'https://b');assert.deepEqual(opened,['https://a','https://b'])
 const directory=source.slice(source.indexOf("  ipcMain.handle('nova:personal:directory'"),source.indexOf("  ipcMain.handle('nova:personal:build-directory'"))
 new Function('ipcMain','mainWindow','settingsWindow','dialog',directory)({handle:(_,fn)=>{handler=fn}},mainWindow,settingsWindow,{showOpenDialog:async(owner)=>{dialogs.push(owner);return {canceled:false,filePaths:['/p']}}})
 await assert.rejects(handler({sender:{}}),/rejected/)
 assert.equal(await handler({sender:mainWindow.webContents}),'/p');assert.equal(await handler({sender:settingsWindow.webContents}),'/p')
 assert.deepEqual(dialogs,[mainWindow,settingsWindow],'the dialog is parented to the requesting window')
})

test('Build directory IPC is translated and accepts only the workbench window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:personal:build-directory'"),source.indexOf('  const bindPresentationClose ='))
 const mainWindow={webContents:{}},settingsWindow={webContents:{}},dialogs=[]
 let handler
 new Function('ipcMain','mainWindow','dialog','t',block)({handle:(_,fn)=>{handler=fn}},mainWindow,{showOpenDialog:async(owner,options)=>{dialogs.push({owner,options});return {canceled:false,filePaths:['/project']}}},text=>'translated:'+text)
 await assert.rejects(handler({sender:{}}),/rejected/)
 await assert.rejects(handler({sender:settingsWindow.webContents}),/rejected/)
 assert.equal(await handler({sender:mainWindow.webContents}),'/project')
 assert.deepEqual(dialogs,[{owner:mainWindow,options:{title:'translated:选择本地 Build 项目目录',properties:['openDirectory']}}])
})

test('news settings IPC permits only configuration from the owned settings frame',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8'),block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:personal'"),source.indexOf("  ipcMain.handle('nova:knowledge:action'"));
 const sender={},calls=[];let receive;new Function('ipcMain','settingsWindow','backendControl','settingsGeneration',block)({handle:(_,fn)=>receive=fn},{webContents:sender},{request:async(method,params)=>{calls.push([method,params]);return {ok:true}}},1);
 const params={enabled:true,explore:false,interests:['科学'],expected_version:8};await assert.rejects(receive({sender:{}},{method:'news.configure',params}),/rejected/);await receive({sender},{method:'news.configure',params});
 await assert.rejects(receive({sender},{method:'news.refresh',params:{}}),/rejected/);assert.deepEqual(calls,[['news.configure',params]])
})

test('Host Space creation IPC is bound to the settings main frame, a fixed userData path and main-only persistence',async t=>{
 const {createSpaceCreateHandler}=await import('../src/main/space-create.mjs')
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path')
 const userData=await mkdtemp(join(tmpdir(),'nova-space-ipc-'));t.after(()=>rm(userData,{recursive:true,force:true}))
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const start=source.indexOf("  ipcMain.handle('nova:space:create'"),block=source.slice(start,source.indexOf('\n  }))',start)+6)
 assert.ok(start>0)
 const token='operator-bootstrap-token-0123456789abcdef',sender={mainFrame:'main'},inits=[],writes=[];let receive,current={}
 const runtime={initializeHostSpace:async options=>{inits.push(options);return {}},resumeHostSpaceRegistration:async()=>({}),readHostSpaceConfig:()=>({})}
 new Function('ipcMain','settingsWindow','createSpaceCreateHandler','resolve','app','process','currentSettings','existsSync','loadSpaceHostRuntime','accessCredentials','settingsWriter',block)(
  {handle:(_,fn)=>receive=fn},{webContents:sender},createSpaceCreateHandler,resolve,{getPath:name=>name==='userData'?userData:'/wrong'},{env:{}},current,()=>false,async()=>runtime,operation=>operation(),async(patch,prepare,options)=>{writes.push([patch,prepare,options])})
 await assert.rejects(receive({sender:{},senderFrame:'main'},{relayUrl:'https://relay.example',bootstrapToken:token}),/rejected/)
 await assert.rejects(receive({sender,senderFrame:'child'},{relayUrl:'https://relay.example',bootstrapToken:token}),/rejected/)
 assert.deepEqual(await receive({sender,senderFrame:'main'},{relayUrl:'https://relay.example',bootstrapToken:token}),{ok:true})
 assert.equal(inits[0].configPath,join(userData,'space','config.json'));assert.equal(inits[0].personalPath,join(userData,'space','personal.json'))
 assert.deepEqual(writes,[[{spaceHostConfigPath:join(userData,'space','config.json')},undefined,{preserveSecrets:true}]])
 assert.ok(!JSON.stringify(writes).includes(token))
 let envReceive;new Function('ipcMain','settingsWindow','createSpaceCreateHandler','resolve','app','process','currentSettings','existsSync','loadSpaceHostRuntime','accessCredentials','settingsWriter',block)(
  {handle:(_,fn)=>envReceive=fn},{webContents:sender},createSpaceCreateHandler,resolve,{getPath:()=>userData},{env:{NOVA_SPACE_HOST_CONFIG:'/operator/config.json'}},{},()=>false,async()=>runtime,operation=>operation(),async()=>{})
 assert.deepEqual(await envReceive({sender,senderFrame:'main'},{relayUrl:'https://relay.example',bootstrapToken:token}),{ok:false,error:'space_already_created'})
})
