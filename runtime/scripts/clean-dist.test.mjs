import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,lstatSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

test('clean removes generated files without replacing an external output link',()=>{
  const root=mkdtempSync(join(tmpdir(),'nova-clean-dist-'))
  try{
    const external=join(root,'external');mkdirSync(external);writeFileSync(join(external,'old.js'),'old')
    symlinkSync(external,join(root,'dist'),process.platform==='win32'?'junction':'dir')
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./clean-dist.mjs',import.meta.url))],{cwd:root,encoding:'utf8'})
    assert.equal(result.status,0,result.stderr)
    assert(lstatSync(join(root,'dist')).isSymbolicLink())
    assert.deepEqual(readdirSync(external),[])
  }finally{rmSync(root,{recursive:true,force:true})}
})
