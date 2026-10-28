import {spawnSync} from 'node:child_process'
import {readdir} from 'node:fs/promises'
import {resolve} from 'node:path'
const root=resolve(import.meta.dirname,'..')
const tests=(await readdir(resolve(root,'test'))).filter(name=>/^react-.*\.test\.(mjs|tsx|ts)$/.test(name)).sort()
let failed=0
for(const file of tests){
 // Direct node:test execution ensures named cases execute in managed runtimes,
 // some of which intercept `node --test` and return only an empty file-level pass.
 const result=spawnSync(process.execPath,['--import','tsx',resolve(root,'test',file)],{cwd:root,stdio:'inherit',env:process.env})
 if(result.status!==0)failed++
}
console.log(`${tests.length} React test files; ${failed} failed`)
process.exitCode=failed?1:0
