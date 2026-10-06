import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, writeFile, rm, access} from 'node:fs/promises'
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
