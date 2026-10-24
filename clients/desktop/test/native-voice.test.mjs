import assert from 'node:assert/strict'
import test from 'node:test'
import {applySettingsUpdate, normalizeSettings, publicSettings, readSecret} from '../src/main/settings-store.mjs'
import {backendLaunchSpec} from '../src/main/backend.mjs'
const fields={minicpmRealtimeUrl:'ws://127.0.0.1:18580/v1/realtime',personaplexRealtimeUrl:'wss://voice.example/v1/realtime'}
function launch(settings,secrets,parentEnv={}) { return backendLaunchSpec({nodeEntry:'/tmp/runtime.mjs',nodeResourcesPath:'/tmp',workspace:'/tmp',token:'a'.repeat(32),readyEndpoint:'127.0.0.1:12345',parentEnv:{MEMORY_CONNECTION:'disabled',...parentEnv},settings,decryptedSecrets:secrets}).env }
for(const provider of ['minicpm-o','personaplex'])test(`${provider} settings survive projection and map only the selected endpoint credential`,()=>{
 const prefix=provider==='minicpm-o'?'minicpm':'personaplex'
 const settings=normalizeSettings({pipelineMode:'integrated',integratedProvider:provider,...fields})
 assert.equal(settings.integratedProvider,provider)
 assert.equal(publicSettings(settings)[prefix+'RealtimeUrl'],fields[prefix+'RealtimeUrl'])
 const env=launch(settings,{minicpmRealtimeApiKey:'mini-secret',personaplexRealtimeApiKey:'persona-secret'},{NATIVE_REALTIME_API_KEY:'stale'})
 assert.equal(env.NATIVE_REALTIME_URL,fields[prefix+'RealtimeUrl'])
 assert.equal(env.NATIVE_REALTIME_API_KEY,provider==='minicpm-o'?'mini-secret':'persona-secret')
 assert.equal(env.NATIVE_REALTIME_VOICE,provider==='minicpm-o'?'':'NATF2')
 assert.ok(!Object.values(env).includes(provider==='minicpm-o'?'persona-secret':'mini-secret'))
 assert.equal(launch(settings,{}, {NATIVE_REALTIME_API_KEY:'stale'}).NATIVE_REALTIME_API_KEY,'')
})
test('native endpoint changes clear only the corresponding saved secret and reject unsafe addresses',()=>{
 const initial=applySettingsUpdate(normalizeSettings({...fields}),{secrets:{minicpmRealtimeApiKey:'mini-secret',personaplexRealtimeApiKey:'persona-secret'}})
 const changed=applySettingsUpdate(initial,{personaplexRealtimeUrl:'wss://new.example/v1/realtime'})
 assert.equal(readSecret(changed,'personaplexRealtimeApiKey'),'')
 assert.equal(readSecret(changed,'minicpmRealtimeApiKey'),'mini-secret')
 assert.ok(!JSON.stringify(publicSettings(changed)).includes('mini-secret'))
 for(const url of ['ws://remote.example/v1/realtime','wss://user:secret@example.com/v1/realtime','wss://example.com/?token=secret','ws://127.1/v1/realtime'])assert.throws(()=>applySettingsUpdate(initial,{minicpmRealtimeUrl:url}),{code:'invalid_settings_commit'})
})
test('native capability probe uses the saved provider endpoint and never returns its credential',async()=>{
 const {probeNativeVoice}=await import('../src/main/native-voice-service.mjs')
 const settings=normalizeSettings({...fields})
 let request
 const result=await probeNativeVoice('personaplex',settings,{personaplexRealtimeApiKey:'private-token'},async(url,options)=>{
  request={url,options};return new Response(JSON.stringify({native_full_duplex:true,input_audio_format:{rate:24000},output_audio_format:{rate:24000},voices:['NATF2','NATM1']}))
 })
 assert.equal(request.url,'https://voice.example/v1/realtime/capabilities')
 assert.equal(request.options.headers.Authorization,'Bearer private-token')
 assert.equal(request.options.redirect,'error')
 assert.deepEqual(result.voices,['NATF2','NATM1'])
 assert.ok(!JSON.stringify(result).includes('private-token'))
 await assert.rejects(probeNativeVoice('personaplex',settings,{},async()=>new Response(JSON.stringify({native_full_duplex:false}))),/native_service_incompatible/)
})

test('native capability probe binds its endpoint and credential to one queued settings snapshot',async()=>{
 const {readFile}=await import('node:fs/promises')
 const {runInNewContext}=await import('node:vm')
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const handlerSource=source.slice(source.indexOf("ipcMain.handle('nova:settings:native-voice'"),source.indexOf("ipcMain.handle('nova:settings:get'"))
 const sender={},previous={personaplexRealtimeUrl:'wss://old.example/v1/realtime',key:'old-key'}
 let handler,request
 const context={settingsWindow:{webContents:sender},currentSettings:previous,secretCodec:{},
  decryptSecretsForSpawn:settings=>({personaplexRealtimeApiKey:settings.key}),
  accessCredentials:async operation=>{const result=operation();context.currentSettings={personaplexRealtimeUrl:'wss://new.example/v1/realtime',key:''};return result},
  probeNativeVoice:async(provider,settings,secrets)=>{request={provider,url:settings.personaplexRealtimeUrl,key:secrets.personaplexRealtimeApiKey};return {}},
  ipcMain:{handle(_channel,fn){handler=fn}},
 }
 runInNewContext(handlerSource,context)
 await assert.rejects(handler({sender:{}},'personaplex'),/settings request rejected/)
 assert.equal(request,undefined)
 await handler({sender},'personaplex')
 assert.deepEqual(request,{provider:'personaplex',url:previous.personaplexRealtimeUrl,key:'old-key'})
})
