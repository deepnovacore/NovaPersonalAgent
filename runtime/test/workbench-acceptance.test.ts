import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {assertOriginalProfilePaths,loadAcceptanceManifest} from '../src/desktop/workbench-acceptance.js'

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'nova-acceptance-'))
 for(const name of ['electron','runtime','repo','output','other'])mkdirSync(join(root,name))
 const blackboard=join(root,'runtime/blackboard.sqlite');writeFileSync(blackboard,'')
 writeFileSync(blackboard+'.personal.json.sources.json',JSON.stringify({sources:[{view:{state:'connected'},processing_consent:{extraction_provider:'known',embedding_provider:'known'}}]}))
 const manifest={version:1,originalUserData:join(root,'electron'),originalBlackboardPath:blackboard,repository:join(root,'repo'),outputDirectory:join(root,'output'),buildCommit:'a'.repeat(40),providers:[{identity:'known',origin:'https://provider.invalid',models:['model']}],allowedIdentities:['known'],runCapSeconds:10}
 const manifestPath=join(root,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest))
 const env={...process.env,NOVA_WORKBENCH_ACCEPTANCE_MANIFEST:manifestPath,NOVA_WORKBENCH_ACCEPTANCE_REPORT:join(root,'output/counts.ndjson'),NOVA_AUDIO_AGENT_BLACKBOARD_PATH:blackboard}
 return {root,manifest,manifestPath,env,close:()=>rmSync(root,{recursive:true,force:true})}
}
test('canonical Electron and blackboard boundaries are independently enforced',()=>{
 const f=fixture();try{
 const expected={userData:f.manifest.originalUserData,blackboardPath:f.manifest.originalBlackboardPath}
 assert.doesNotThrow(()=>assertOriginalProfilePaths(expected,expected))
 assert.throws(()=>assertOriginalProfilePaths({...expected,userData:join(f.root,'other')},expected),/wrong_user_data/)
 assert.throws(()=>assertOriginalProfilePaths({...expected,blackboardPath:join(f.root,'manifest.json')},expected),/wrong_blackboard/)
 }finally{f.close()}
})
test('report output cannot be inside original profile or repository',()=>{
 const f=fixture();try{
 assert.ok(loadAcceptanceManifest(f.env))
 writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,outputDirectory:f.manifest.originalUserData}))
 assert.throws(()=>loadAcceptanceManifest(f.env),/output_inside/)
 }finally{f.close()}
})
test('real fetch/socket/http transports fail closed before network; persisted grants cannot be widened',()=>{
 const f=fixture();try{
 const moduleUrl=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const code=`import assert from 'node:assert/strict';import net from 'node:net';import https from 'node:https';import {request as undiciRequest} from 'undici';import {installAcceptanceGate,assertAcceptanceGrant} from ${JSON.stringify(moduleUrl)};
 net.Socket.prototype.connect=function(){return this};
 globalThis.fetch=async()=>{net.connect({host:'provider.invalid',port:443});return new Response('{}')};
 installAcceptanceGate();
 assert.equal((await fetch('https://provider.invalid',{method:'POST',body:JSON.stringify({model:'model'})})).status,200);
 await assert.rejects(fetch('https://unknown.invalid',{method:'POST',body:'{}'}),/unknown_outbound/);
 await assert.rejects(fetch('https://provider.invalid',{method:'POST',body:JSON.stringify({model:'unknown'})}),/unknown_model/);
 assert.throws(()=>net.connect({host:'provider.invalid',port:443}),/unknown_socket/);
 assert.throws(()=>https.request('https://provider.invalid'),/unapproved_http_transport/);
 await assert.rejects(undiciRequest('https://provider.invalid'),/unapproved_dispatcher/);
 assert.throws(()=>assertAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},[{extraction_provider:'old',embedding_provider:'known'}]),/grant_mismatch/);
 assert.throws(()=>assertAcceptanceGrant({extraction_provider:'known',embedding_provider:null},[]),/embedding_provider_disabled/);
 assertAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},[{extraction_provider:'known',embedding_provider:'known'}]);`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 const output=readFileSync(f.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT,'utf8')
 assert.equal(output.includes('provider.invalid'),false);assert.equal(output.includes('known'),false)
 }finally{f.close()}
})
