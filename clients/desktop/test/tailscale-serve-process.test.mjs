import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'

test('loss of the parent pipe closes the owned CLI even when it ignores SIGTERM', {skip:process.platform==='win32'}, async t => {
  const root=await mkdtemp(join(tmpdir(),'nova-serve-owner-')),path=join(root,'child.pid')
  const guard=spawn(process.execPath,[fileURLToPath(new URL('../src/main/tailscale-serve-process.mjs',import.meta.url)),process.execPath,'-e',
    'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',path],{stdio:['pipe','ignore','pipe']})
  const ended=once(guard,'exit')
  let pid
  t.after(async()=>{guard.kill('SIGTERM');if(pid){try{process.kill(pid,'SIGKILL')}catch{}}await rm(root,{recursive:true,force:true})})
  for(let n=0;n<200&&!pid;n++){
    try{pid=Number(await readFile(path,'utf8'))}catch{await wait(10)}
  }
  assert.ok(pid,'owned CLI started')
  guard.stdin.end()
  await Promise.race([ended,wait(4000).then(()=>{throw Error('owned CLI survived parent EOF')})])
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
})
