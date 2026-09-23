/** Launches the package's NORMAL main entry with a controller-attested original profile. */
import {spawn,execFileSync} from 'node:child_process'
import {existsSync,lstatSync,realpathSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

export function assertOriginalProfilePaths(actual,expected){
 const canonical=path=>existsSync(path)?realpathSync(path):resolve(path)
 if(canonical(actual.userData)!==canonical(expected.userData))throw Error('acceptance_wrong_user_data')
 if(canonical(actual.blackboardPath)!==canonical(expected.blackboardPath))throw Error('acceptance_wrong_blackboard')
}
export function assertNoProfileLock(held){if(held)throw Error('acceptance_profile_locked')}
export function assertProvider(identity,allowed){if(!allowed.includes(identity))throw Error('acceptance_provider_not_authorized')}
export function countOnlyReport(input){
 const count=key=>{const value=input[key];if(!Number.isSafeInteger(value)||value<0)throw Error('acceptance_invalid_count');return value}
 if(!/^[a-f0-9]{40}$/u.test(input.build_commit)||!/^[a-f0-9]{64}$/u.test(input.profile_hash))throw Error('acceptance_invalid_identity')
 return {profile_kind:'original',native_main:true,build_commit:input.build_commit,original_profile_path_hash:input.profile_hash,pre_sources:count('pre_sources'),post_sources:count('post_sources'),eligible_candidates:count('eligible_candidates'),model_calls:count('model_calls'),dom_cards:{todos:count('todos'),ideas:count('ideas')},source_to_card:{rendered:count('todos')+count('ideas')},remaining_queue:count('remaining_queue'),screenshots:input.screenshots.map(path=>String(path))}
}
const existsIncludingDangling=path=>{try{lstatSync(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export function preflightLocks(manifest){
 const owned=[manifest.originalBlackboardPath,manifest.originalBlackboardPath+'.personal.json.owner.sqlite',manifest.originalBlackboardPath+'.personal.json.sources.json.owner.sqlite']
 try{assertNoProfileLock(execFileSync('lsof',['-t','--',...owned],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().length>0)}catch(error){if(error.status!==1)throw error}
 for(const path of [resolve(manifest.originalUserData,'SingletonLock'),manifest.originalBlackboardPath+'.personal.json.lock',manifest.originalBlackboardPath+'.personal.json.sources.json.lock'])assertNoProfileLock(existsIncludingDangling(path))
}
async function launch(manifestPath){
 if(!manifestPath)throw Error('usage: workbench-native-live-acceptance.mjs /absolute/manifest.json')
 let manifest=JSON.parse(readFileSync(manifestPath,'utf8'))
 const repository=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'))
 if(realpathSync(manifest.repository)!==repository)throw Error('acceptance_wrong_repository')
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim()
 if(commit!==manifest.buildCommit)throw Error('acceptance_wrong_build_commit')
 if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repository,encoding:'utf8'}).trim())throw Error('acceptance_dirty_build')
 preflightLocks(manifest)
 const report=resolve(manifest.outputDirectory,'counts.ndjson')
 if(existsSync(report))throw Error('acceptance_fresh_output_required')
 const runtime=await import(pathToFileURL(resolve(repository,'runtime/dist/src/desktop/workbench-acceptance.js')).href)
 const environment={...process.env,NOVA_WORKBENCH_ACCEPTANCE_MANIFEST:resolve(manifestPath),NOVA_WORKBENCH_ACCEPTANCE_REPORT:report,NOVA_AUDIO_AGENT_BLACKBOARD_PATH:manifest.originalBlackboardPath}
 manifest=runtime.loadAcceptanceManifest(environment)
 const electron=(await import('electron')).default
 const child=spawn(electron,[resolve(repository,'clients/desktop'),`--user-data-dir=${manifest.originalUserData}`],{cwd:repository,env:environment,stdio:['ignore','ignore','ignore']})
 const timer=setTimeout(()=>child.kill('SIGTERM'),(manifest.runCapSeconds+90)*1000)
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 clearTimeout(timer)
 if(code!==0)throw Error('acceptance_native_exit_failed')
 const capturePath=resolve(manifest.outputDirectory,'capture.json')
 if(!existsSync(capturePath)||!existsSync(report))throw Error('acceptance_evidence_incomplete')
 const samples=readFileSync(report,'utf8').trim().split('\n').map(line=>JSON.parse(line))
 const source=samples.filter(row=>row.kind==='source_state'),context=samples.filter(row=>row.kind==='context_state')
 if(!source.length||!context.length)throw Error('acceptance_runtime_counts_missing')
 if(samples.filter(row=>row.kind==='egress_blocked').length>samples.filter(row=>row.kind==='gate_installed').length)throw Error('acceptance_unexpected_egress')
 const last=source.at(-1).counts,capture=JSON.parse(readFileSync(capturePath,'utf8'))
 const result=countOnlyReport({build_commit:commit,profile_hash:createHash('sha256').update(realpathSync(manifest.originalUserData)).digest('hex'),pre_sources:source[0].counts.sources,post_sources:last.sources,eligible_candidates:context.at(-1).counts.eligible_candidates,model_calls:samples.filter(row=>row.kind==='context_model').length,todos:capture.dom_cards.todos,ideas:capture.dom_cards.ideas,remaining_queue:last.remaining_queue,screenshots:capture.screenshots})
 writeFileSync(resolve(manifest.outputDirectory,'report.json'),JSON.stringify({...result,termination:'run_cap',quiescence_verified:false,source_counts:{pre:source[0].counts,post:last},outbound_model_calls:samples.filter(row=>row.kind==='model_call').length,blocked_outbound:samples.filter(row=>row.kind==='egress_blocked').length,gate_probes:samples.filter(row=>row.kind==='gate_installed').length,disabled_modules:['news','proactive','connectors','phone','external_mcp','coding','voice_activation']},null,2)+'\n',{mode:0o600})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))launch(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1})
