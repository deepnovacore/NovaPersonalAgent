import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {canonicalJson,startHash,ephemeralFromSeed,deriveCallKeys,sealFrame,openFrame,FrameReceiver,FrameSender,VoiceCryptoError,FRAME_CONTROL,FRAME_AUDIO,encodeAudio,decodeAudio,encodeControl,decodeControl} from '../src/space-host/voice-crypto.js'

// Shared with clients/flutter/test/space_voice_crypto_test.dart.
const vectors = JSON.parse(readFileSync(new URL('../../../tests/fixtures/space-voice/v1/vectors.json', import.meta.url), 'utf8')) as {
  handshake: {start: Record<string, unknown>; space: string; epoch: number; client: string; host: string; canonical: string; start_hash: string;
    client_seed: string; host_seed: string; client_public: string; host_public: string; content_key: string; session: string; codec: string;
    frame_ms: number; k_up: string; k_down: string; former_content_key: string; former_k_up: string}
  invalid_public_keys: {name: string; value: string}[]
  frames: {name: string; direction: 'up' | 'down'; type: number; seq: string; plaintext: string; frame: string}[]
  negatives: {name: string; direction: 'up' | 'down'; frame: string; error: string}[]
  replay: {sequence: string[]; accepted: boolean[]}
}
const h = vectors.handshake
const hex = (value: string) => Buffer.from(value, 'hex')
const client = ephemeralFromSeed(hex(h.client_seed)), host = ephemeralFromSeed(hex(h.host_seed))
const params = {startHash: hex(h.start_hash), ephC: h.client_public, ephH: h.host_public, session: h.session, codec: h.codec, frameMs: h.frame_ms}

test('canonical start hash binds the exact intent, Space, epoch and both devices', () => {
  assert.equal(canonicalJson(h.start), h.canonical)
  assert.equal(startHash({start: h.start, space: h.space, epoch: h.epoch, client: h.client, host: h.host}).toString('hex'), h.start_hash)
  assert.notEqual(startHash({start: h.start, space: h.space, epoch: h.epoch + 1, client: h.client, host: h.host}).toString('hex'), h.start_hash)
  assert.notEqual(startHash({start: {...h.start, op_id: 'other'}, space: h.space, epoch: h.epoch, client: h.client, host: h.host}).toString('hex'), h.start_hash)
  assert.throws(() => canonicalJson({x: 1.5}), /canonical_number/)
})

test('both sides derive identical per-direction keys; a former content key derives different ones', () => {
  assert.equal(client.publicKey, h.client_public); assert.equal(host.publicKey, h.host_public)
  const a = deriveCallKeys({own: client, peer: h.host_public, contentKey: hex(h.content_key), ...params})
  const b = deriveCallKeys({own: host, peer: h.client_public, contentKey: hex(h.content_key), ...params})
  assert.equal(a.up.toString('hex'), h.k_up); assert.equal(a.down.toString('hex'), h.k_down)
  assert.deepEqual(a, b)
  assert.equal(deriveCallKeys({own: client, peer: h.host_public, contentKey: hex(h.former_content_key), ...params}).up.toString('hex'), h.former_k_up)
  assert.notEqual(h.former_k_up, h.k_up)
  for (const changed of [{codec: 'opus'}, {frameMs: 20}, {session: 'session-other-other-other-x'}, {ephC: h.host_public}])
    assert.notEqual(deriveCallKeys({own: client, peer: h.host_public, contentKey: hex(h.content_key), ...params, ...changed}).up.toString('hex'), h.k_up)
  for (const bad of vectors.invalid_public_keys)
    assert.throws(() => deriveCallKeys({own: client, peer: bad.value, contentKey: hex(h.content_key), ...params}), /invalid_shared_secret/, bad.name)
})

test('frames seal and open byte-exactly; negative vectors fail with their codes', () => {
  const key = (direction: 'up' | 'down') => hex(direction === 'up' ? h.k_up : h.k_down)
  for (const f of vectors.frames) {
    assert.equal(sealFrame(key(f.direction), f.type, BigInt(f.seq), hex(f.plaintext)).toString('hex'), f.frame, f.name)
    const opened = openFrame(key(f.direction), hex(f.frame))
    assert.equal(opened.type, f.type); assert.equal(opened.seq, BigInt(f.seq)); assert.equal(opened.plaintext.toString('hex'), f.plaintext)
  }
  for (const n of vectors.negatives)
    assert.throws(() => openFrame(key(n.direction), hex(n.frame)), (error: unknown) => error instanceof VoiceCryptoError && error.code === n.error, n.name)
})

test('receive state is per direction, advances only after authentication, and ends after repeated failures', () => {
  const sender = new FrameSender(hex(h.k_up)), receiver = new FrameReceiver(hex(h.k_up))
  const frames = vectors.replay.sequence.map(seq => sealFrame(hex(h.k_up), FRAME_CONTROL, BigInt(seq), encodeControl({type: 'x'})))
  assert.deepEqual(frames.map(frame => receiver.open(frame) !== null), vectors.replay.accepted)
  // A forged frame at a fresh seq does not advance the window: the genuine frame is still accepted afterwards.
  const genuine = sealFrame(hex(h.k_up), FRAME_CONTROL, 500n, encodeControl({type: 'y'}))
  const forged = Buffer.from(genuine); forged[forged.length - 1]! ^= 1
  assert.throws(() => receiver.open(forged), /auth_failed/)
  assert.notEqual(receiver.open(genuine), null)
  const strict = new FrameReceiver(hex(h.k_up), 2)
  assert.throws(() => strict.open(forged), /auth_failed/); assert.throws(() => strict.open(forged), /auth_failed/)
  assert.throws(() => strict.open(forged), /voice_crypto_failed/)
  // One counter across all frame types.
  sender.seal(FRAME_CONTROL, encodeControl({type: 'ready'})); sender.seal(FRAME_AUDIO, encodeAudio({gen: 1, nativeSeq: 0, sampleOffset: 0, pcm: new Uint8Array(4)}))
  assert.equal(sender.next, 2n)
})

test('audio and control payloads round-trip with fixed layouts', () => {
  const audio = decodeAudio(encodeAudio({gen: 7, nativeSeq: 3, sampleOffset: 2880, pcm: new Uint8Array([1, 2, 3, 4])}))
  assert.deepEqual({...audio, pcm: [...audio.pcm]}, {gen: 7, nativeSeq: 3, sampleOffset: 2880, pcm: [1, 2, 3, 4]})
  assert.throws(() => decodeAudio(new Uint8Array(11)), /invalid_plaintext/)
  assert.deepEqual(decodeControl(encodeControl({type: 'ready', a: 1})), {type: 'ready', a: 1})
  assert.throws(() => decodeControl(Buffer.from('[1]')), /invalid_control/)
})
