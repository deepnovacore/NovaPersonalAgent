import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {resolveWindowsAcpLaunch, verifyWindowsCodebuddyRecovery} from '../src/executors/acp/windows-launch.js'
import {acpBackend} from '../src/executors/acp/backends.js'

function fixture(id: 'codebuddy'|'pi'|'deepseek'|'opencode') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova acp windows ')))
  const backend=acpBackend(id)
  const prefix=join(root,'npm'), node=join(root,'node.exe')
  mkdirSync(prefix,{recursive:true}); writeFileSync(node,'fixture native executable')
  writeFileSync(join(prefix,backend.command+'.cmd'),'fixture npm launcher')
  const packageRoot=join(prefix,'node_modules',backend.packageName)
  const bin={codebuddy:'bin/codebuddy',pi:'dist/index.js',deepseek:'lib/bin.js',opencode:'bin/opencode.exe'}[id]
  const entry=join(packageRoot,bin)
  mkdirSync(join(entry,'..'),{recursive:true});writeFileSync(entry,'fixture entry')
  writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:backend.packageName,version:backend.packageVersion,bin:{[backend.command]:bin}}))
  return {root,prefix,node,packageRoot,entry,backend,env:{PATH:root+';'+prefix},cleanup:()=>rmSync(root,{recursive:true,force:true})}
}

test('Windows resolves fixed npm entries through native Node without a shell, preserving argv',()=>{
  for(const id of ['codebuddy','pi','deepseek','opencode'] as const){
    const f=fixture(id)
    try{
      const result=resolveWindowsAcpLaunch(f.backend,undefined,['argument with spaces','& literal'],f.env)
      assert.deepEqual(result,{command:id==='opencode'?f.entry:f.node,args:id==='opencode'?['argument with spaces','& literal']:[f.entry,'argument with spaces','& literal']})
      assert.deepEqual(resolveWindowsAcpLaunch(f.backend,join(f.prefix,f.backend.command+'.cmd'),[],f.env),{command:id==='opencode'?f.entry:f.node,args:id==='opencode'?[]:[f.entry]})
    }finally{f.cleanup()}
  }
})

test('Windows discovers the standard per-user npm prefix and refuses unverified package or escaping entries',()=>{
  const f=fixture('codebuddy')
  try{
    assert.equal(resolveWindowsAcpLaunch(f.backend,undefined,[],{PATH:f.root,APPDATA:f.root}).command,f.node)
    writeFileSync(join(f.packageRoot,'package.json'),JSON.stringify({name:'other-package',version:f.backend.packageVersion,bin:{codebuddy:'bin/codebuddy'}}))
    assert.throws(()=>resolveWindowsAcpLaunch(f.backend,undefined,[],f.env))
    writeFileSync(join(f.packageRoot,'package.json'),JSON.stringify({name:f.backend.packageName,version:f.backend.packageVersion,bin:{codebuddy:'../../injected.js'}}))
    assert.throws(()=>resolveWindowsAcpLaunch(f.backend,undefined,[],f.env))
    writeFileSync(join(f.packageRoot,'package.json'),JSON.stringify({name:f.backend.packageName,version:f.backend.packageVersion,bin:{codebuddy:'bin/codebuddy'}}))
    rmSync(join(f.packageRoot,'bin'),{recursive:true});const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'codebuddy'),'escaped entry')
    symlinkSync(outside,join(f.packageRoot,'bin'),process.platform==='win32'?'junction':'dir')
    assert.throws(()=>resolveWindowsAcpLaunch(f.backend,undefined,[],f.env))
  }finally{f.cleanup()}
})

test('Windows keeps explicit native executables, refuses script overrides and requires Node for npm JavaScript',()=>{
 const f=fixture('pi')
 try{
   assert.deepEqual(resolveWindowsAcpLaunch(f.backend,f.node,['--mode'],f.env),{command:f.node,args:['--mode']})
   assert.throws(()=>resolveWindowsAcpLaunch(f.backend,join(f.root,'arbitrary.bat'),[],f.env))
   rmSync(f.node);assert.throws(()=>resolveWindowsAcpLaunch(f.backend,undefined,[],f.env))
 }finally{f.cleanup()}
})

test('Windows CodeBuddy refuses a missing or replaced compatibility bundle rather than reviving failed requests',()=>{
 const f=fixture('codebuddy')
 try{
  assert.throws(()=>verifyWindowsCodebuddyRecovery(f.entry))
  mkdirSync(join(f.packageRoot,'dist'));writeFileSync(join(f.packageRoot,'dist/codebuddy-headless.js'),'upstream package restored')
  assert.throws(()=>verifyWindowsCodebuddyRecovery(f.entry),/Reapply/u)
  assert.throws(()=>verifyWindowsCodebuddyRecovery(f.node),/verified npm/u)
 }finally{f.cleanup()}
})
