import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp, writeFile, rm, access, mkdir, chmod, realpath, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {startComputerBackend} from '../src/executors/computer-backend.js'

for (const write of [false, true]) test(`blocked SDK process is bounded, write=${write}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-block-'))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, "require('node:readline').createInterface({input:process.stdin}).on('line', () => {for (;;) {}})")
  const backend = await startComputerBackend('1', new AbortController().signal, 150, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  const started = Date.now()
  await assert.rejects(() => write ? backend.connect() : backend.device.screenshotBase64(),
    write ? /cleanup_unknown/u : /action_failed/u)
  assert.ok(Date.now() - started < 5000)
})

test('read-only screenshot wait exits on cancel even when SDK blocks synchronously', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-cancel-'))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, "require('node:readline').createInterface({input:process.stdin}).on('line', () => {for (;;) {}})")
  const controller = new AbortController()
  const backend = await startComputerBackend('1', controller.signal, 10_000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  const capturing = backend.device.screenshotBase64()
  controller.abort()
  await assert.rejects(() => capturing, /cancelled/u)
})

test('backend close confirms process termination before desktop ownership can be released', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-close-'))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, "require('node:readline').createInterface({input:process.stdin}).on('line', () => {for (;;) {}})")
  const backend = await startComputerBackend('1', new AbortController().signal, 150, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  assert.equal(await backend.close(), true)
  assert.throws(() => process.kill(backend.pid, 0))
})

test('confirmed worker cleanup removes its private screenshot directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-private-'))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, "require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'screen.png'),'private');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,ok:true,value:[{id:process.env.TMPDIR}]})+'\\n')})")
  const backend = await startComputerBackend('1', new AbortController().signal, 10000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  const temporary = (await backend.listDisplays())[0]!.id
  await access(join(temporary, 'screen.png'))
  assert.equal(await backend.close(), true)
  await assert.rejects(access(temporary))
})

test('window metadata remains inside owned RPC and is validated before the guard consumes it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-window-'))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,ok:true,value:{target:'pid:start:window:bounds:key',width:800,height:600}})+'\\n')})")
  const backend = await startComputerBackend('0', new AbortController().signal, 10000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  assert.deepEqual(await backend.windowTarget(), {target: 'pid:start:window:bounds:key', width: 800, height: 600})
})


test('native window binding cannot silently change between target and connect', {skip: process.platform !== 'darwin'}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-window-binding-')))
  await mkdir(join(root, 'native'))
  const helper = '#!/usr/bin/env node\nlet body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{const r=JSON.parse(body);console.log(JSON.stringify({target:r.op==="connect"?"changed":"approved",width:800,height:600,keyWindowMatches:true}))})'
  await writeFile(join(root, 'native/macos_gui'), helper); await chmod(join(root, 'native/macos_gui'), 0o755)
  await writeFile(join(root, 'native-resources-v1.json'), JSON.stringify({schema_version:1,target:'darwin-'+process.arch,resources:[{logical_id:'macos_gui',relative_path:'native/macos_gui',kind:'executable',platform:'darwin',architecture:process.arch,byte_size:Buffer.byteLength(helper),sha256:createHash('sha256').update(helper).digest('hex'),build_contract_version:1}]}))
  const backend = await startComputerBackend('0', new AbortController().signal, 10000, undefined, root, 100, {pid:12345,windowId:678})
  t.after(async () => {await backend.close(); await rm(root, {recursive:true,force:true})})
  assert.equal((await backend.windowTarget()).target, 'approved')
  await assert.rejects(backend.connect(), /cleanup_unknown/u)
  assert.equal(await backend.close(), true)
})


test('background Tap restores focus outside a killed worker group before releasing ownership', {skip:process.platform !== 'darwin'}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-focus-recovery-')))
  await mkdir(join(root, 'native'))
  const restored = join(root, 'restored')
  const helper = `#!/usr/bin/env node\nlet b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.op==="Tap"){process.kill(process.ppid,"SIGKILL");setInterval(()=>{},1000);return}if(r.op==="focusRestore"){require("node:fs").writeFileSync(${JSON.stringify(restored)},"restored");console.log(JSON.stringify({restored:true}));return}console.log(JSON.stringify(r.op==="focusSnapshot"?{focus:{pid:222,windowId:333,started:100},targetStarted:200}:{target:"approved",width:800,height:600,keyWindowMatches:true}))})`
  await writeFile(join(root, 'native/macos_gui'),helper);await chmod(join(root, 'native/macos_gui'),0o755)
  await writeFile(join(root, 'native-resources-v1.json'),JSON.stringify({schema_version:1,target:'darwin-'+process.arch,resources:[{logical_id:'macos_gui',relative_path:'native/macos_gui',kind:'executable',platform:'darwin',architecture:process.arch,byte_size:Buffer.byteLength(helper),sha256:createHash('sha256').update(helper).digest('hex'),build_contract_version:1}]}))
  const backend=await startComputerBackend('0',new AbortController().signal,10000,undefined,root,100,{pid:12345,windowId:678})
  t.after(async()=>{await backend.close();await rm(root,{recursive:true,force:true})})
  await backend.windowTarget();await backend.connect()
  await assert.rejects(async () => {await backend.device.actionSpace().find(a=>a.name==='Tap')!.call({locate:{center:[10,10]}})},/cleanup_unknown/u)
  assert.equal(await backend.close(),true)
  assert.equal(await readFile(restored,'utf8'),'restored')
})

for (const actionName of ['Tap', 'KeyboardPress']) for (const cleanupFails of [false, true]) test(`killed display ${actionName} releases input after tree exit; cleanup failure=${cleanupFails}`, {skip: process.platform === 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-pointer-recovery-'))
  const worker = join(root, 'worker.cjs'), state = join(root, 'pointer')
  await writeFile(worker, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.op===${JSON.stringify(actionName)}){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));process.exit(3)}if(m.op==='releaseInput'){const pid=Number(fs.readFileSync(${JSON.stringify(state)},'utf8'));let alive=true;try{process.kill(pid,0)}catch{alive=false}if(alive)process.exit(4);if(!${cleanupFails})fs.writeFileSync(${JSON.stringify(state)},'released');process.stdout.write(JSON.stringify({id:m.id,ok:!${cleanupFails}})+'\\n')}})`)
  const backend = await startComputerBackend('1', new AbortController().signal, 3000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  await assert.rejects(async () => {await backend.device.actionSpace().find(action => action.name === actionName)!.call(actionName === 'Tap' ? {locate: {center: [10, 10]}} : {keyName: 'Ctrl+A'})}, /cleanup_unknown/u)
  assert.equal(await backend.close(), !cleanupFails)
  assert.equal((await readFile(state, 'utf8')) === 'released', !cleanupFails)
})

test('display Input uses sequential Unicode typing without replacing the clipboard', {skip: process.platform === 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-input-'))
  const worker = join(root, 'worker.mjs'), typed = join(root, 'typed')
  await writeFile(worker, `import {ComputerDevice} from ${JSON.stringify(import.meta.resolve('@midscene/computer'))};import {writeFileSync} from 'node:fs';ComputerDevice.prototype.typeViaClipboard=async()=>writeFileSync(${JSON.stringify(typed)},'clipboard');ComputerDevice.prototype.typeStringWithDelay=async text=>writeFileSync(${JSON.stringify(typed)},text);await import(${JSON.stringify(new URL('../src/executors/computer-worker.js', import.meta.url).href)})`)
  const backend = await startComputerBackend('1', new AbortController().signal, 10000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  await backend.device.actionSpace().find(action => action.name === 'Input')!.call({value: '中文🙂'})
  assert.equal(await readFile(typed, 'utf8'), '中文🙂')
})

test('cleanup releases only the interrupted shortcut keys using the pinned SDK aliases', {skip: process.platform === 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-keyboard-recovery-'))
  const worker = join(root, 'worker.mjs'), released = join(root, 'keys')
  await writeFile(worker, `import {createRequire} from 'node:module';import {appendFileSync} from 'node:fs';const native=createRequire(${JSON.stringify(import.meta.url)})(\`@computer-use/libnut-\${process.platform}\`);native.keyToggle=(key,state)=>appendFileSync(${JSON.stringify(released)},JSON.stringify({key,state})+'\\n');await import(${JSON.stringify(new URL('../src/executors/computer-worker.js', import.meta.url).href)})`)
  const backend = await startComputerBackend('1', new AbortController().signal, 10000, pathToFileURL(worker))
  t.after(async () => {await backend.close(); await rm(root, {recursive: true, force: true})})
  await backend.releaseInput(false, 'Ctrl+Shift+A')
  assert.deepEqual((await readFile(released, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown), [{key: 'a', state: 'up'}, {key: 'shift', state: 'up'}, {key: 'control', state: 'up'}])
})
