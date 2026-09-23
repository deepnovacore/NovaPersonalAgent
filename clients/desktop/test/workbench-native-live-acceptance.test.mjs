import test from 'node:test'
import assert from 'node:assert/strict'
import {assertOriginalProfilePaths, assertNoProfileLock, countOnlyReport, assertProvider} from '../scripts/workbench-native-live-acceptance.mjs'
const original={userData:'/tmp/daily-electron',blackboardPath:'/tmp/daily-runtime/blackboard.sqlite'}
test('separate original Electron and runtime identities, never a profile copy',()=>{
 assert.doesNotThrow(()=>assertOriginalProfilePaths(original,original))
 assert.throws(()=>assertOriginalProfilePaths({...original,userData:'/tmp/copy'},original),/user_data/)
 assert.throws(()=>assertOriginalProfilePaths({...original,blackboardPath:'/tmp/copy/blackboard.sqlite'},original),/blackboard/)
})
test('held profile lock is rejected',()=>assert.throws(()=>assertNoProfileLock(true),/profile_locked/))
test('provider identity must be explicitly authorized',()=>{
 assert.throws(()=>assertProvider('unknown',['known']),/provider_not_authorized/)
 assert.doesNotThrow(()=>assertProvider('known',['known']))
})
test('count-only report cannot copy private fields',()=>{
 const report=countOnlyReport({build_commit:'a'.repeat(40),profile_hash:'b'.repeat(64),pre_sources:1,post_sources:2,eligible_candidates:3,model_calls:4,todos:5,ideas:6,remaining_queue:7,screenshots:['/tmp/evidence/todos.png'],privateExcerpt:'PRIVATE EXCERPT'})
 assert.equal(report.profile_kind,'original');assert.equal(report.native_main,true)
 assert.equal(report.source_to_card.rendered,report.dom_cards.todos+report.dom_cards.ideas)
 assert.equal(JSON.stringify(report).includes('PRIVATE EXCERPT'),false)
})

test('harness cannot replace the profile, delete context, or construct a window',async()=>{
 const {readFile}=await import('node:fs/promises')
 for(const path of ['../scripts/workbench-native-live-acceptance.mjs','../src/main/workbench-native-acceptance.mjs']){
  const source=await readFile(new URL(path,import.meta.url),'utf8')
  assert.doesNotMatch(source,/copyFile|cpSync|rmSync|unlink|setPath|new BrowserWindow/u)
 }
})

test('a held Electron singleton is rejected using a synthetic profile directory',async()=>{
 const {mkdtempSync,mkdirSync,symlinkSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const {preflightLocks}=await import('../scripts/workbench-native-live-acceptance.mjs')
 const root=mkdtempSync(join(tmpdir(),'native-lock-test-'))
 try{
  mkdirSync(join(root,'electron'))
  symlinkSync('synthetic-owner',join(root,'electron/SingletonLock'))
  assert.throws(()=>preflightLocks({originalUserData:join(root,'electron'),originalBlackboardPath:join(root,'blackboard.sqlite')}),/profile_locked/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
