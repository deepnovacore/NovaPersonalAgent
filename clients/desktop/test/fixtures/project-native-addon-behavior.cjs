'use strict'
const assert = require('node:assert/strict')
const {closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync} = require('node:fs')
const {tmpdir} = require('node:os')
const {join} = require('node:path')
const {spawn} = require('node:child_process')
const addonPath = process.argv[2]
if (addonPath === undefined) process.exit(0)
const addon = require(addonPath)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
if (process.argv[3] === 'hold') {
  const descriptor = openSync(process.argv[4], 'r+')
  const held = addon.acquire(descriptor)
  assert.equal(held.status, 'acquired')
  closeSync(descriptor)
  process.stdout.write('locked\n')
  setInterval(() => {}, 1_000)
} else {
  void (async () => {
    const container = realpathSync(mkdtempSync(join(tmpdir(), 'nova-native-lock-')))
    const lockFile = join(container, 'owner.lock')
    writeFileSync(lockFile, '', {mode: 0o600})
    let lockChild = null
    try {
      const child = spawn(process.execPath, [__filename, addonPath, 'hold', lockFile], {
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      lockChild = child
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { output += chunk })
      const deadline = Date.now() + 5_000
      while (!output.includes('locked') && Date.now() < deadline) await delay(10)
      assert.match(output, /locked/)

      const contender = openSync(lockFile, 'r+')
      assert.deepEqual(addon.acquire(contender), {status: 'busy'})
      const lockChildExit = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL')
      await lockChildExit
      lockChild = null
      let acquired = addon.acquire(contender)
      for (let attempt = 0; acquired.status === 'busy' && attempt < 100; attempt += 1) {
        await delay(10)
        acquired = addon.acquire(contender)
      }
      assert.equal(acquired.status, 'acquired')
      closeSync(contender)

      const second = openSync(lockFile, 'r+')
      assert.deepEqual(addon.acquire(second), {status: 'busy'})
      acquired.release()
      const released = addon.acquire(second)
      assert.equal(released.status, 'acquired')
      released.release()
      closeSync(second)
    } finally {
      if (lockChild !== null && lockChild.exitCode === null) {
        const exited = new Promise(resolve => lockChild.once('exit', resolve))
        lockChild.kill('SIGKILL')
        await Promise.race([exited, delay(1_000)])
      }
      rmSync(container, {recursive: true, force: true})
    }
    process.stdout.write('project native behavior passed\n')
  })().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
