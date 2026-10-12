/** Starts the normal native desktop entry. UI verification is performed through CUA. */
import {mkdir,writeFile,open} from 'node:fs/promises'
import {spawn,execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DEFAULT_SETTINGS} from '../src/main/settings-store.mjs'
export async function launchScheduledDesktop(directory){
 const output=resolve(directory),root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),profile=join(output,'profile')
 await mkdir(profile,{recursive:true,mode:0o700})
 const capabilities=join(output,'capabilities.json')
 await writeFile(capabilities,JSON.stringify({version:1,modules:{search:{enabled:false},coding:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}}))
 await writeFile(join(profile,'ambient-orb-settings.json'),JSON.stringify({...DEFAULT_SETTINGS,capabilitiesConfigPath:capabilities,startupView:'workbench',lastPresentation:'workbench',language:'zh-CN',cascadedLlmProvider:'deepseek',modelBaseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',startListeningOnLaunch:false,phoneConnectionEnabled:false}),{mode:0o600})
 const require=createRequire(join(root,'clients/desktop/package.json')),electron=require('electron'),environment={...process.env,BLACKBOARD_PATH:join(output,'blackboard.sqlite'),MEMORY_CONNECTION:'disabled',CAPABILITIES_CONFIG:capabilities,DEV_START_MUTED:'1',REALTIME_TELEMETRY:'',COMPOSIO_API_KEY:'',CODEX_MANAGED_ROOT:join(output,'workspaces'),CODEX_PROJECT_STATE_ROOT:join(output,'projects')}
 delete environment.ELECTRON_RUN_AS_NODE
 const log=await open(join(output,'native.log'),'w',0o600)
 const child=spawn(electron,[join(root,'clients/desktop'),`--user-data-dir=${profile}`],{cwd:root,env:environment,stdio:['ignore',log.fd,log.fd]});await log.close()
 const report={native_main:true,profile_kind:'isolated_synthetic',build_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),working_tree_dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',started_at:new Date().toISOString(),pid:child.pid,status:'awaiting_native_ui_acceptance',screenshots:[],checks:[]}
 await writeFile(join(output,'launch.json'),JSON.stringify(report,null,2),{mode:0o600});console.log('Native desktop launched; CUA evidence required:',output)
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill('SIGTERM'))
 await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const i=process.argv.indexOf('--output');if(i<0)throw Error('--output directory required');await launchScheduledDesktop(process.argv[i+1])
}
