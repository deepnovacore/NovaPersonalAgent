import test from 'node:test'
import assert from 'node:assert/strict'
import {realpath} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

test('desktop-owned phone entry drains on parent shutdown before exiting', async () => {
  const {spawn} = await import('node:child_process')
  const target = pathToFileURL(await realpath(new URL('../../../runtime/dist/src/desktop/phone-desktop-entry.js', import.meta.url))).href
  const replacement = `import {writeSync} from 'node:fs'; export async function runServerEntry({stop, onDiagnostic}) {
    onDiagnostic('[server-ready] loopback');
    await new Promise(resolve => stop.signal.addEventListener('abort', resolve, {once: true}));
    writeSync(1, 'phone-drained'); return 0;
  }`
  const hook = `export async function resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(target)} && specifier === '../server-entry.js') return {url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(replacement)}), shortCircuit: true};
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; import {EventEmitter} from 'node:events';
    process.parentPort = Object.assign(new EventEmitter(), {postMessage(frame) {
      if (frame.type === 'nova.phone.ready') {process.send('ready');queueMicrotask(() => process.parentPort.emit('message', {data: {type: 'nova.shutdown'}}));}
    }});
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']})
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', text => {stdout += text})
  child.stderr.setEncoding('utf8').on('data', text => {stderr += text})
  // Importing the full runtime can take longer than shutdown on a cold Windows machine.
  let phase = 'startup'
  let timer = setTimeout(() => child.kill(), 120000)
  child.on('message', message => {
    if (message !== 'ready') return
    phase = 'shutdown'
    clearTimeout(timer)
    timer = setTimeout(() => child.kill(), 10000)
  })
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(status, 0, `phone entry ${phase}: ${stderr}`)
    assert.equal(stdout, 'phone-drained')
  } finally {clearTimeout(timer)}
})
