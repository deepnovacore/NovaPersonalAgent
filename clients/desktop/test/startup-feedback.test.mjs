import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {startupFailureCode, reportStartupFailure} from '../src/main/desktop-startup.mjs'
import {classifyBackendFailure, createBackendSupervisor, createBackendDiagnosticCollector} from '../src/main/backend-supervisor.mjs'
const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

test('settings public projection never opens the keychain or capability files', () => {
  const body = source.slice(source.indexOf('function settingsView()'), source.indexOf('async function loadMemoryBoardExport()'))
  const touched = () => {throw Error('keychain/file access')}
  const context = vm.createContext({capabilityEditorCache:null, runtimeCapabilities:null, settingsWindow:{}, settingsGeneration:1, currentSettings:{},
    secretCodec:{available:touched}, capabilityDocumentRevision:touched, decryptSecretsForSpawn:touched,
    readCapabilityDocument:touched, resolveSecretConfiguration:()=>({secretsPresent:{},secretSources:{}}),process:{env:{}},developmentEnv:{},
    secretsPresent:()=>({}), publicSettings:()=>({}), codexStatus:{},frontendUsage:{snapshot:()=>({})},VISION_MODELS:[],backendStatus:{state:'stopped'},
    settingsApplyStatus:'idle',settingsRecoveryAvailable:false,managedWorkspacesView:()=>({}),microphoneStatus:'unknown',wakeWord:null,desktopConfig:null,
    hasPlaintextSecret:()=>false,keyringAvailable:null,startup:{stage:'configuration',code:null}})
  vm.runInContext(body, context)
  assert.equal(context.settingsView().keyringAvailable, null)
})

test('unreadable stored credentials never become silent omissions', () => {
  const body = source.slice(source.indexOf('function decryptSecretsForSpawn('), source.indexOf('async function prepareDesktopConfiguration('))
  for (const reason of ['denied','cancelled','corrupt']) {
    const context=vm.createContext({secretsPresent:()=>({modelApiKey:true}),SECRET_KEYS:['modelApiKey'],readSecret:()=>null,
      secretValueIsSafe:()=>true,classifyBackendFailure,resolveSecretConfiguration:()=>({secrets:{}}),process:{env:{}},developmentEnv:{},console})
    vm.runInContext(body,context)
    assert.throws(()=>context.decryptSecretsForSpawn({},{}), error=>error.code==='credential_access_failed',reason)
  }
})

test('credential and state failures are bounded terminal states, with explicit retry', async () => {
  for(const code of ['credential_access_failed','state_permissions','state_busy','state_lock_failed','personal_store_locked','workspace_not_found','assembly_failed']) {
    let attempts=0, schedules=0
    const supervisor=createBackendSupervisor({start:async()=>{attempts++;throw classifyBackendFailure(code)},stopBackend:async()=>{},onStatus:()=>{},schedule:()=>{schedules++;return 1}})
    await supervisor.start();assert.equal(supervisor.status().diagnostic,code);assert.equal(schedules,0)
    await supervisor.retry();assert.equal(attempts,2)
    if(code!=='credential_access_failed') {const collector=createBackendDiagnosticCollector();collector.push(`[runtime-diagnostic] ${code}\n`);assert.equal(collector.failure().code,code)}
  }
})

test('startup filesystem errors expose categories, never raw paths', () => {
  assert.equal(startupFailureCode({code:'workspace_not_found',message:'/private/token'}),'workspace_not_found')
  for(const code of ['EACCES','EPERM','EROFS'])assert.equal(startupFailureCode({code,message:'/private/token'}),'state_permissions')
})

test('credential notice owns one 10 second timer and clears it on completion', async () => {
  const {createStartupNotice}=await import('../src/renderer/startup-notice.mjs')
  const timers=new Map(), rendered=[];let id=0
  const notice=createStartupNotice({render:value=>rendered.push(value),schedule:(fn,ms)=>{assert.equal(ms,10000);timers.set(++id,fn);return id},cancel:id=>timers.delete(id)})
  notice.update({stage:'credentials'});notice.update({stage:'credentials'})
  assert.equal(timers.size,1);assert.match(rendered.at(-1),/系统授权/)
  const callback=[...timers.values()][0];callback();assert.match(rendered.at(-1),/仍在等待/)
  notice.update({stage:'ready'});assert.equal(timers.size,0);assert.equal(rendered.at(-1),'')
})

test('credential operations paint before access, serialize, latch failure and allow explicit retry', async () => {
  const body=source.slice(source.indexOf('async function accessCredentials('),source.indexOf('function refreshCapabilityEditor('))
  const calls=[];let release
  const context=vm.createContext({credentialQueue:Promise.resolve(),credentialFailure:null,keyringAvailable:null,startup:{stage:'backend'},
    secretCodec:{available:()=>{calls.push('codec');return true}},paintStartup:async()=>{calls.push('paint')},
    publishStartup:stage=>calls.push(stage),backendStatus:{state:'stopped'},startupFailureCode,classifyBackendFailure})
  vm.runInContext(body,context)
  const first=context.accessCredentials(async()=>{calls.push('first');await new Promise(resolve=>release=resolve);throw classifyBackendFailure('credential_access_failed')})
  const second=context.accessCredentials(()=>calls.push('second'))
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['paint','codec','first'])
  release();await assert.rejects(first);await assert.rejects(second)
  assert.equal(calls.includes('second'),false)
  await context.accessCredentials(()=>calls.push('retry'),{retry:true});assert.equal(calls.at(-2),'retry')
  context.secretCodec.available=()=>{throw Error('private keychain error')}
  await assert.rejects(context.accessCredentials(()=>{}, {retry:true}),error=>error.code==='credential_access_failed')
})

test('retry validates settings sender, serializes refresh, and never reconstructs shell', async () => {
  const {createLifecycleCoordinator}=await import('../src/main/desktop-startup.mjs')
  const {coordinateBackendRetry}=await import('../src/main/workspace-actions.mjs')
  const start=source.indexOf("  ipcMain.handle('nova:backend:retry'")
  const body=source.slice(start,source.indexOf('\n  })',start)+5)
  let handler, release;const events=[],sender={}
  const context=vm.createContext({ipcMain:{handle:(_name,fn)=>handler=fn},settingsWindow:{webContents:sender},settingsRecoveryAvailable:false,
    settingsView:()=>({}),coordinateBackendRetry,lifecycleCoordinator:createLifecycleCoordinator(),credentialFailure:null,configurationReady:false,
    refreshDesktopConfiguration:async()=>{events.push('configuration');await new Promise(resolve=>release=resolve)},
    managedWorkspaceBackendRecovery:{retry:async()=>{events.push('backend');return {status:'retried'}}},publishStartup:()=>{},reportStartupFailure})
  vm.runInContext(body,context)
  await assert.rejects(handler({sender:{}}));await assert.rejects(handler({sender},1))
  const first=handler({sender});assert.equal((await handler({sender})).operationStatus,'busy')
  assert.deepEqual(events,['configuration']);release();assert.equal((await first).operationStatus,'retried');assert.deepEqual(events,['configuration','backend'])
  context.refreshDesktopConfiguration=async()=>{throw {code:'EACCES'}}
  assert.equal((await handler({sender})).operationStatus,'failed');assert.equal(events.length,2)
})

test('paint fence publishes before acknowledgment and blocks codec work when renderer does not paint', async () => {
  const body=source.slice(source.indexOf('async function paintStartup('),source.indexOf('async function accessCredentials('))
  const calls=[];let acknowledge,timeout
  const context=vm.createContext({publishStartup:phase=>calls.push(phase),requestPresentation:mode=>calls.push(mode),
    mainWindow:{isDestroyed:()=>false,showInactive:()=>calls.push('show'),webContents:{executeJavaScript:()=>new Promise(resolve=>acknowledge=resolve)}},
    setTimeout:fn=>{timeout=fn;return 1},clearTimeout:()=>{}})
  vm.runInContext(body,context)
  let painted=false;const pending=context.paintStartup('credentials').then(()=>{painted=true})
  assert.deepEqual(calls,['credentials','workbench','show']);assert.equal(painted,false)
  acknowledge(true);await pending;assert.equal(painted,true)
  const unpainted=context.paintStartup('credentials');acknowledge(false);await assert.rejects(unpainted,/startup_paint_unconfirmed/)
  const failed=context.paintStartup('credentials');timeout();await assert.rejects(failed,/startup_paint_timeout/)
})

test('explicit missing or invalid workspaces fail before mutation; state permission errors survive', async () => {
  const {prepareDesktopStartup}=await import('../src/main/desktop-startup.mjs')
  const {posix}=await import('node:path')
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const root=await mkdtemp(posix.join(tmpdir(),'nova-startup-path-'))
  try {
    const file=posix.join(root,'file');await writeFile(file,'fixture')
    let mutations=0
    const base={environment:{},home:root,platform:'linux',arch:'x64',pathApi:posix,canonicalizePath:value=>value,canonicalizeExecutable:()=>null,
      mkdir:async()=>{mutations++},inspectCodex:()=>null}
    for(const [workspace,code]of [[posix.join(root,'missing'),'workspace_not_found'],[file,'workspace_invalid']]) {
      await assert.rejects(prepareDesktopStartup({...base,settings:{codexWorkspace:workspace}}),error=>error.code===code)
    }
    assert.equal(mutations,0)
    for(const code of ['EACCES','EROFS'])await assert.rejects(prepareDesktopStartup({...base,settings:{},mkdir:async()=>{throw {code}}}),error=>startupFailureCode(error)==='state_permissions')
  } finally {await rm(root,{recursive:true,force:true})}
})

test('a second launch shows the primary workbench; settings is queued until protocol is ready', () => {
  const start=source.indexOf("  app.on('second-instance'")
  const body=source.slice(start,source.indexOf('\n  })',start)+5)
  const calls=[];let handler
  const context=vm.createContext({wakeWord:null,app:{on:(_name,fn)=>handler=fn},requestPresentation:mode=>calls.push(mode),
    mainWindow:{show:()=>calls.push('show'),focus:()=>calls.push('focus')},shouldOpenSettings:argv=>argv.includes('--settings'),activeLaunchId:null,
    openSettingsRequested:false,openSettingsWindow:id=>calls.push(id)})
  vm.runInContext(body,context)
  handler(null,[]);assert.deepEqual(calls,['workbench','show','focus'])
  handler(null,['--settings']);assert.equal(context.openSettingsRequested,true)
  context.activeLaunchId='launch';handler(null,['--settings']);assert.equal(calls.at(-1),'launch')
  assert.match(source,/else if \(!app.requestSingleInstanceLock\(\)\) \{\s*app.quit\(\)/)
})

test('opening settings to inspect credentials cannot erase a retained startup failure', async () => {
  const body=source.slice(source.indexOf('async function accessCredentials('),source.indexOf('async function refreshSettingsCapabilities('))
  const context=vm.createContext({credentialQueue:Promise.resolve(),credentialFailure:null,keyringAvailable:null,startup:{stage:'failed',code:'workspace_not_found'},
    secretCodec:{available:()=>true},backendStatus:{state:'stopped'},paintStartup:async()=>{},publishStartup:(stage,code)=>{context.startup={stage,code}},startupFailureCode,classifyBackendFailure})
  vm.runInContext(body,context)
  await context.accessCredentials(()=>({}))
  assert.equal(context.startup.stage,'failed');assert.equal(context.startup.code,'workspace_not_found')
})
