import test from 'node:test'
import assert from 'node:assert/strict'
import {realpath} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

test('desktop-owned phone entry drains on parent shutdown before exiting', async () => {
  const {spawnSync} = await import('node:child_process')
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
      if (frame.type === 'nova.phone.ready') queueMicrotask(() => process.parentPort.emit('message', {data: {type: 'nova.shutdown'}}));
    }});
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'phone-drained')
})
