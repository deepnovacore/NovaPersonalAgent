import {test, afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {rotatedCredential, rotateCredential, resetCredentialRotations} from '../src/config/credential-rotation.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {installDesktopControl} from '../src/desktop/desktop-control.js'

afterEach(() => resetCredentialRotations())

test('a rotated key is followed by every client built with an earlier key of the chain', () => {
  assert.equal(rotatedCredential('old'), 'old')
  assert.equal(rotateCredential('old', 'mid'), true)
  assert.equal(rotateCredential('mid', 'new'), true)
  assert.equal(rotatedCredential('old'), 'new');assert.equal(rotatedCredential('mid'), 'new');assert.equal(rotatedCredential('new'), 'new')
  assert.equal(rotateCredential('new', 'old'), true, 'rolling back is a rotation too')
  assert.equal(rotatedCredential('old'), 'old');assert.equal(rotatedCredential('mid'), 'old')
  assert.equal(rotatedCredential(''), '', 'an absent key is never invented')
})

test('unsafe or empty values are refused', () => {
  for (const [from, to] of [['', 'x'], ['x', ''], ['x', 'bad\nvalue'], [1, 'x'], ['x', 'y'.repeat(5000)]] as const) assert.equal(rotateCredential(from, to), false)
  assert.equal(rotatedCredential('x'), 'x')
})

test('a gateway built with the old key sends the new one on its next request', async () => {
  const seen: string[] = []
  const fetch = (async (_url: unknown, init: {headers: Record<string, string>}) => {
    seen.push(init.headers.authorization ?? '')
    return new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: 'ok'}}], usage: {prompt_tokens: 1, completion_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}})
  }) as unknown as typeof globalThis.fetch
  const gateway = new OpenAIModelGateway({baseUrl: 'https://example.invalid/v1', apiKey: 'old-key', clock: {now: () => 0, monotonic: () => 0, sleep: async () => undefined} as never, fetch})
  const request = {usage: {feature: 'test', operation: 'x'}, model: 'm', prompt: 'p', system: 's', signal: new AbortController().signal} as never
  await gateway.complete(request)
  rotateCredential('old-key', 'new-key')
  await gateway.complete(request)
  assert.deepEqual(seen, ['Bearer old-key', 'Bearer new-key'])
})

test('the desktop control port applies a rotation and refuses malformed requests without echoing a value', async () => {
  const sent: any[] = []
  const handlers: ((event: unknown) => void)[] = []
  const port = {postMessage: (message: unknown) => sent.push(message), on: (_event: string, handler: (event: unknown) => void) => handlers.push(handler), off: () => undefined}
  const stop = new AbortController()
  const control = installDesktopControl({parentPort: port as never, signal: stop.signal, status: () => undefined})
  const call = async (id: string, params: unknown) => { handlers[0]!({data: {type: 'nova.control.request', id, method: 'credentials.rotate', params}}); await new Promise(resolve => setImmediate(resolve)); return sent.find(m => m.id === id) }
  const ok = await call('a', {rotations: [{from: 'secret-old', to: 'secret-new'}]})
  assert.deepEqual(ok, {type: 'nova.control.reply', id: 'a', result: {applied: 1}})
  assert.equal(rotatedCredential('secret-old'), 'secret-new')
  for (const [id, params] of [['b', {rotations: []}], ['c', {rotations: [{from: 'x'}]}], ['d', {rotations: [{from: 'x', to: 'bad\n'}]}], ['e', {other: 1}]] as const) {
    const reply = await call(id, params)
    assert.equal(reply.error, 'unavailable')
  }
  assert.ok(!JSON.stringify(sent).includes('secret-new'))
  control.dispose();stop.abort()
})
