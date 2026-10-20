import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PosixCodexProcessOwnerFactory,takeUnconfirmedCodexProcessOwner,loadWindowsGuardianFactoryFromResources,type CodexProcessOwnerFactory,type OwnedCodexProcess} from '../executors/native-process.js'
import type {JsonValue} from '../core/events.js'
import {environmentContract} from '../config/environment-contract.js'
import type {Readable} from 'node:stream'

export interface LocalShellProcess {platform:'darwin'|'win32';pid:number}
export interface LocalShellOptions {readonly factory?:CodexProcessOwnerFactory;readonly resourcesPath?:string;readonly environment?:NodeJS.ProcessEnv;readonly platform?:NodeJS.Platform;readonly temporaryRoot?:string;readonly onStarted?:(process:LocalShellProcess)=>Promise<void>}
/** Inspection only. A reused PID stays conservatively occupied; recovery never signals an unrelated process. */
export function localShellProcessGone(owner:LocalShellProcess):boolean{
 if(owner.platform!==process.platform)return false
 try{process.kill(owner.platform==='darwin'?-owner.pid:owner.pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
}
/** Keep user development configuration; never forward Nova's credentials or process controls. */
export function localShellEnvironment(source:NodeJS.ProcessEnv=process.env):Record<string,string>{
 const result:Record<string,string>={}
 const privateNames=new Set(environmentContract.filter(entry=>entry.secret||entry.owner==='host_private'&&!['HOME','DEVELOPER_DIR'].includes(entry.name)).map(entry=>entry.name.toUpperCase()))
 for(const [name,value] of Object.entries(source))if(value!==undefined&&!privateNames.has(name.toUpperCase())&&!/^(?:NOVA_|CODEX_|CASCADE_|CASCAD(?:ED|ING)_|QWEN_|ARK_|DEEPSEEK_|DASHSCOPE_|VOLCENGINE_|OPENAI_|GEMINI_|TAVILY_|SELF_HOSTED_|SUPPORT_MODEL|FAST_MODEL|PLANNER_MODEL|PERSONAL_|MEM0_|ELECTRON_|REALTIME_|DESKTOP_|SERVER_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/iu.test(name))result[name]=value
 return result
}
function drain(stream:Readable):Promise<boolean>{
 if(stream.readableEnded)return Promise.resolve(true)
 return new Promise(resolve=>{
  const done=()=>{clearTimeout(timer);stream.off('end',end);stream.off('close',close);stream.off('error',close)},end=()=>{done();resolve(true)},close=()=>{done();resolve(stream.readableEnded)}
  const timer=setTimeout(()=>{done();resolve(false)},2000)
  stream.once('end',end);stream.once('close',close);stream.once('error',close)
  if(stream.destroyed)close()
 })
}
export async function executeLocalShell(input:{command:string;cwd:string;timeout:number},signal:AbortSignal,options:LocalShellOptions={}):Promise<JsonValue>{
 const platform=options.platform??process.platform
 if(platform!=='win32'&&platform!=='darwin')throw Error('local_tools_platform_unsupported')
 signal.throwIfAborted();if(!(await stat(input.cwd)).isDirectory())throw Error('invalid_cwd')
 const resources=options.resourcesPath??process.env.CODEX_RESOURCES_PATH
 const factory=options.factory??(platform==='darwin'?new PosixCodexProcessOwnerFactory():resources?loadWindowsGuardianFactoryFromResources({resourcesPath:resources,platform,arch:process.arch}):null)
 if(!factory)throw Error('windows_process_guardian_required')
 let temporary:string|undefined,child:OwnedCodexProcess|undefined
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),retained=0,truncated=false,status='completed',exitCode:number|null=null,cleanupConfirmed=true,outputIncomplete=false
 const environment=localShellEnvironment(options.environment),controller=new AbortController()
 let timer:ReturnType<typeof setTimeout>|undefined,stopPromise:Promise<void>|undefined
 const stopTree=()=>{
  const owner=child;if(!owner)return Promise.resolve()
  return stopPromise??=(async()=>{try{await owner.terminateTree();if(!await owner.waitTreeGone(500)){await owner.killTree();if(!await owner.waitTreeGone(2500))cleanupConfirmed=false}}catch{cleanupConfirmed=false}})()
 }
 let stopped!:(code:null)=>void
 const interrupted=new Promise<null>(resolve=>{stopped=resolve})
 const interrupt=(reason:string)=>{status=reason;controller.abort();void stopTree().finally(()=>stopped(null))}
 const cancel=()=>interrupt('cancelled')
 signal.addEventListener('abort',cancel,{once:true})
 try{
  let binary='/bin/zsh',argv=['-f','-c','IFS= read -r _nova_start || exit 125\n[ "$_nova_start" = "nova-start" ] || exit 125\n'+input.command]
  if(platform==='win32'){
   temporary=await mkdtemp(join(options.temporaryRoot??tmpdir(),'nova-shell-'))
   const script=join(temporary,'command.ps1')
   // -File avoids command-line re-escaping and PowerShell 5's ANSI script default.
   await writeFile(script,'\ufeff'+[
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    '$global:LASTEXITCODE = 0',
    'if ([Console]::ReadLine() -ne "nova-start") { exit 125 }',
    'try {',input.command,
    'if (-not $?) { exit 1 }',
    'exit $global:LASTEXITCODE',
    '} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }',
   ].join('\r\n'),'utf8')
   binary=join(environment.SystemRoot??environment.SYSTEMROOT??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
   argv=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script]
  }
  signal.throwIfAborted()
  child=await factory.spawn({binary,argv,cwd:input.cwd,environment,detached:true,shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true,terminateDescendantsOnExit:true},{signal:controller.signal,expiresAtMs:Date.now()+10000})
  const capture=(stream:'stdout'|'stderr',data:Buffer|string)=>{const bytes=Buffer.isBuffer(data)?data:Buffer.from(data),remaining=Math.max(0,65536-retained),keep=bytes.subarray(0,remaining);retained+=keep.length;truncated ||= keep.length<bytes.length;if(stream==='stdout')stdout=Buffer.concat([stdout,keep]);else stderr=Buffer.concat([stderr,keep])}
  child.stdout.on('data',(data:Buffer)=>capture('stdout',data));child.stderr.on('data',(data:Buffer)=>capture('stderr',data));child.stdin.on('error',()=>{ /* teardown can close stdin first */ })
  // The shell waits at a stdin gate until its identity and execution intent have reached disk.
  await options.onStarted?.({platform,pid:child.pid});signal.throwIfAborted()
  await new Promise<void>((resolve,reject)=>child!.stdin.write('nova-start\n',error=>error?reject(error):resolve()))
  await child.closeStdin()
  timer=setTimeout(()=>interrupt('timed_out'),input.timeout*1000)
  if(signal.aborted)cancel()
  exitCode=await Promise.race([child.exit,interrupted])
  if(timer){clearTimeout(timer);timer=undefined}
  if(status==='completed'&&exitCode!==0)status=exitCode===null?'outcome_unknown':'failed'
  // A successful leader may leave grandchildren alive. They remain owned and must be stopped.
  await stopTree()
  const drained=await Promise.all([drain(child.stdout),drain(child.stderr)])
  outputIncomplete=drained.some(value=>!value)
 }catch(error){
  const unconfirmed=takeUnconfirmedCodexProcessOwner(error)
  if(unconfirmed){child=unconfirmed;cleanupConfirmed=false;await stopTree()}
  if(child){status='outcome_unknown';await stopTree()}else if(signal.aborted)status='cancelled';else throw error
 }finally{
  if(timer)clearTimeout(timer);signal.removeEventListener('abort',cancel)
  await stopPromise
  if(child)await child.dispose().catch(()=>{cleanupConfirmed=false})
  if(temporary)await rm(temporary,{recursive:true,force:true}).catch(()=>{ /* retain a script if the OS still owns it */ })
 }
 if(!cleanupConfirmed)status='outcome_unknown'
 return {stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),exit_code:exitCode,status,truncated,output_incomplete:outputIncomplete,cleanup_confirmed:cleanupConfirmed}
}
