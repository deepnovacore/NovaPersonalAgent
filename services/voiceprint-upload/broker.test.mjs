import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer, request} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBroker} from './broker.mjs'

function wav() {
  const b = Buffer.alloc(44 + 16000 * 2 * 5)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40)
  return b
}

test('anonymous uploads enforce audio, durable quotas, bounded downloads and cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voiceprint-test-'))
  const objects = new Map()
  const storage = {put: async (key, data) => objects.set(key, data), get: async key => objects.get(key), delete: async key => objects.delete(key)}
  let now = Date.now(), storageReady = true
  let broker, server
  const start = async () => {
    broker = createBroker({database: join(dir, 'quota.sqlite'), ipSalt: 'test-salt-with-at-least-32-characters', storage,
      publicBase: 'https://voice.example', healthy: () => storageReady, perIp: 2, globalLimit: 3, now: () => now})
    server = createServer(broker.handler)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${server.address().port}`
  }
  const stop = async () => {await new Promise(resolve => server.close(resolve)); broker.close()}
  try {
    let base = await start()
    assert.equal((await fetch(`${base}/healthz`)).status,200)
    storageReady = false
    assert.equal((await fetch(`${base}/healthz`)).status,503)
    storageReady = true
    const upload = (body = wav(), forwarded = '1.2.3.4') => fetch(`${base}/uploads`, {method:'POST', headers:{'Content-Type':'audio/wav','X-Forwarded-For':forwarded}, body})
    assert.equal((await upload(Buffer.from('not audio'))).status, 400)
    let result = await upload()
    assert.equal(result.status, 201)
    const first = await result.json()
    assert.match(first.audioUrl, /^https:\/\/voice.example\/audio\/[a-f0-9]{64}$/)
    const audioPath = new URL(first.audioUrl).pathname
    for (let i = 0; i < 3; i++) assert.equal((await fetch(base + audioPath)).status, 200)
    assert.equal((await fetch(base + audioPath)).status, 429)
    assert.equal((await upload(wav(), '9.8.7.6')).status, 429, 'forged forwarded IP cannot bypass cooldown')
    now += 61000
    assert.equal((await upload()).status, 201)
    await stop(); base = await start(); now += 61000
    assert.equal((await upload(wav(), '4.3.2.1')).status, 429, 'daily quota survives restart')
    assert.equal((await fetch(`${base}/uploads/${'a'.repeat(64)}`, {method:'DELETE'})).status, 204)
    assert.equal(objects.size, 2, 'unknown bearer cannot delete an object')
    assert.equal((await fetch(`${base}/uploads/${first.ticket}`, {method:'DELETE'})).status, 204)
    assert.equal(objects.size, 1)
    assert.equal((await fetch(base + audioPath)).status, 404)
    now += 16 * 60000
    await broker.cleanup()
    assert.equal(objects.size, 0)
  } finally {if (server?.listening) await stop(); await rm(dir, {recursive:true,force:true})}
})

test('stalled anonymous uploads cannot take the audio read slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voiceprint-test-'))
  const objects = new Map()
  const storage = {put: async (key, data) => objects.set(key, data), get: async key => objects.get(key), delete: async key => objects.delete(key)}
  const broker = createBroker({database: join(dir, 'quota.sqlite'), ipSalt: 'test-salt-with-at-least-32-characters', storage,
    publicBase: 'https://voice.example', trustedProxies: ['127.0.0.1', '::ffff:127.0.0.1']})
  const server = createServer(broker.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address(), base = `http://127.0.0.1:${port}`
  const stalled = []
  try {
    const first = await (await fetch(`${base}/uploads`, {method:'POST', headers:{'Content-Type':'audio/wav','X-Real-IP':'10.0.0.1'}, body:wav()})).json()
    for (let i = 2; i <= 4; i++) {
      const pending = request({port, method:'POST', path:'/uploads', headers:{'Content-Type':'audio/wav','Content-Length':wav().length,'X-Real-IP':`10.0.0.${i}`}})
      pending.on('error', () => {})
      pending.write(wav().subarray(0, 1024))
      stalled.push(pending)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    const extra = await fetch(`${base}/uploads`, {method:'POST', headers:{'Content-Type':'audio/wav','X-Real-IP':'10.0.0.9'}, body:wav()})
    assert.equal(extra.status, 503)
    assert.equal((await fetch(base + new URL(first.audioUrl).pathname)).status, 200)
  } finally {
    for (const pending of stalled) pending.destroy()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); broker.close()
    await rm(dir, {recursive:true,force:true})
  }
})
