import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('native GUI rejects malformed targets before touching any application', {skip:process.platform!=='darwin'}, t => {
  const root=mkdtempSync(join(tmpdir(),'nova-gui-native-test-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const binary=join(root,'macos_gui')
  const build=spawnSync('/usr/bin/swiftc',['-parse-as-library','-module-cache-path',join(root,'cache'),fileURLToPath(new URL('../native/macos_gui.swift',import.meta.url)),'-o',binary],{encoding:'utf8',timeout:60000})
  assert.equal(build.status,0,build.stderr)
  for(const input of [JSON.stringify({op:'applicationTarget',application:''}), JSON.stringify({op:'applicationTarget',application:42}), '{', JSON.stringify({pid:0,windowId:1,op:'Input',value:'must not be sent'}),
    JSON.stringify({pid:1.5,windowId:1,op:'Tap',x:0,y:0}), JSON.stringify({pid:2147483648,windowId:1,op:'target'}),
    JSON.stringify({pid:1,windowId:4294967296,op:'target'}), ' '.repeat(65537)]) {
    const result=spawnSync(binary,[],{input,encoding:'utf8',timeout:10000})
    assert.equal(result.status,1,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),{error:'invalid_configuration'})
  }
})
