import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
const builder=fileURLToPath(new URL('./linux/ios/build_runtime.py',import.meta.url))
const packaging=fileURLToPath(new URL('./linux/ios/package_runtime.sh',import.meta.url))
test('local native builds reject implicit or external output roots before writing',()=>{
 for(const root of ['relative-output','/Volumes/never-write-nova-test']){
  const r=spawnSync('python3',[builder,'--output-root',root],{encoding:'utf8'})
  assert.notEqual(r.status,0);assert.match(r.stderr,/explicit isolated directory on internal storage/)
 }
 assert.equal(spawnSync('/bin/sh',['-n',packaging]).status,0)
})
test('packaging accepts an explicit internal root and preserves its source resources',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-ios-package-'))
 try{
  await mkdir(join(root,'native/build-iphoneos'),{recursive:true})
  await mkdir(join(root,'native/resources/NovaAlpine/data'),{recursive:true})
  for(const name of ['libish.a','libish_emu.a','libfakefs.a'])await writeFile(join(root,'native/build-iphoneos',name),'fixture')
  await writeFile(join(root,'native/resources/NovaAlpine/meta.db'),'fixture')
  const r=spawnSync('/bin/sh',[packaging],{env:{...process.env,NOVA_CI_RUNNER_TEMP:'0',NOVA_LINUX_ROOT:join(root,'native'),PLATFORM_NAME:'iphoneos',TARGET_BUILD_DIR:join(root,'out'),UNLOCALIZED_RESOURCES_FOLDER_PATH:'Fixture.app'},encoding:'utf8'})
  assert.equal(r.status,0,r.stderr)
  assert.equal(await readFile(join(root,'out/Fixture.app/NovaAlpine/meta.db'),'utf8'),'fixture')
  assert.equal(await readFile(join(root,'native/resources/NovaAlpine/meta.db'),'utf8'),'fixture')
 }finally{await rm(root,{recursive:true,force:true})}
})
