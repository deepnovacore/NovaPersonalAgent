import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {stageReleaseApplication} from '../scripts/stage-release-app.mjs'

test('staging reuses the nearest matching ancestor for cyclic peer dependencies', async () => {
 const root=await mkdtemp(join(tmpdir(),'nova-stage-'))
 async function pkg(path,name,version,dependencies={},peerDependencies={}) {
  await mkdir(path,{recursive:true})
  await writeFile(join(path,'package.json'),JSON.stringify({name,version,dependencies,peerDependencies,main:'index.cjs'}))
  await writeFile(join(path,'index.cjs'),`module.exports=${JSON.stringify(version)}\n`)
 }
 try{
  await pkg(root,'test-app','1',{'pg':'1','pg-pool':'1','mem0ai':'1'})
  for(const path of ['src','LICENSES'])await mkdir(join(root,path))
  await writeFile(join(root,'THIRD_PARTY_NOTICES.md'),'fixture')
  await pkg(join(root,'node_modules/pg'),'pg','1',{'pg-pool':'1'})
  await pkg(join(root,'node_modules/pg-pool'),'pg-pool','1',{}, {'pg':'*'})
  await pkg(join(root,'node_modules/mem0ai'),'mem0ai','1',{'pg':'2'})
  await pkg(join(root,'node_modules/mem0ai/node_modules/pg'),'pg','2',{'pg-pool':'2'})
  await pkg(join(root,'node_modules/mem0ai/node_modules/pg-pool'),'pg-pool','2',{}, {'pg':'*'})
  const staged=await stageReleaseApplication({packageRoot:root})
  const outer=createRequire(join(staged,'package.json'))
  const inner=createRequire(join(staged,'node_modules/mem0ai/package.json'))
  assert.equal(outer('pg'),'1');assert.equal(inner('pg'),'2')
  const innerPg=createRequire(inner.resolve('pg'))
  assert.equal(innerPg('pg-pool'),'2')
  const innerPool=createRequire(innerPg.resolve('pg-pool'))
  assert.equal(innerPool.resolve('pg'),inner.resolve('pg'))
  await assert.rejects(access(join(staged,'node_modules/mem0ai/node_modules/pg/node_modules/pg-pool/node_modules/pg')))
  assert.equal(JSON.parse(await readFile(join(staged,'node_modules/pg/package.json'),'utf8')).version,'1')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('staged Host can load relay client and excludes relay sources and deployment files', async () => {
 const root=await mkdtemp(join(tmpdir(),'nova-stage-space-'))
 try {
  const relay=join(root,'node_modules/@nova-personal-agent/relay')
  await mkdir(join(relay,'dist/src'),{recursive:true})
  await mkdir(join(relay,'src'))
  for(const dir of ['src','LICENSES'])await mkdir(join(root,dir))
  await writeFile(join(root,'THIRD_PARTY_NOTICES.md'),'fixture')
  await writeFile(join(root,'package.json'),JSON.stringify({name:'host-fixture',dependencies:{'@nova-personal-agent/relay':'1'}}))
  await writeFile(join(relay,'package.json'),JSON.stringify({name:'@nova-personal-agent/relay',version:'1',exports:{'./client':'./dist/src/client.cjs'}}))
  await writeFile(join(relay,'dist/src/client.cjs'),'exports.RelayClient = class RelayClient {}')
  await writeFile(join(relay,'src/client.ts'),'development source')
  await writeFile(join(relay,'.env'),'deployment fixture')
  const staged=await stageReleaseApplication({packageRoot:root})
  assert.equal(typeof createRequire(join(staged,'package.json'))('@nova-personal-agent/relay/client').RelayClient,'function')
  for(const file of ['src/client.ts','.env'])await assert.rejects(access(join(staged,'node_modules/@nova-personal-agent/relay',file)))
 } finally { await rm(root,{recursive:true,force:true}) }
})
