import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {scopedAcpProcessFactory} from '../src/executors/acp/process-owner.js'
import {PosixCodexProcessOwnerFactory} from '../src/executors/codex/process-owner.js'

test('ACP scope survives multiline environment and leaves an unrelated process alive', {skip:process.platform==='win32'}, async () => {
  const cwd=await mkdtemp(join(tmpdir(),'nova-acp-scope-'))
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true})
  const factory=scopedAcpProcessFactory(new PosixCodexProcessOwnerFactory())
  const owner=await factory.spawn({binary:process.execPath,argv:['-e',`
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    require('node:fs').writeFileSync('child-pid',String(child.pid));
    setInterval(()=>{},1000);
  `],cwd,environment:{PATH:process.env.PATH??'',HOME:cwd,NOVA_TEST_MULTILINE:'one\ntwo'},shell:false,detached:true,
    stdio:['pipe','pipe','pipe'],windowsHide:true},{signal:new AbortController().signal,expiresAtMs:Date.now()+10000})
  let childPid=0
  try {
    const expires=Date.now()+5000
    while(Date.now()<expires) {
      try {childPid=Number(await readFile(join(cwd,'child-pid'),'utf8'));break} catch {await new Promise(resolve=>setTimeout(resolve,20))}
    }
    assert.ok(childPid>0)
    await owner.killTree()
    assert.equal(await owner.waitTreeGone(5000),true)
    assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'})
    assert.equal(process.kill(unrelated.pid!,0),true)
  } finally {
    await owner.killTree();await owner.dispose()
    if(childPid>0) {try{process.kill(-childPid,'SIGKILL')}catch{/* test group gone */}}
    unrelated.kill('SIGKILL');await rm(cwd,{recursive:true,force:true})
  }
})
