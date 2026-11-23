/* eslint-disable @typescript-eslint/require-await -- fakes implement async interfaces synchronously */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {realpath,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AudioOwnerArbiter} from '../src/space-host/audio-owner.js'
import {authorizeVoice,SpaceVoiceController,VOICE_MAX_AUDIO_FRAME_BYTES,type SpaceVoiceHostPort,type VoiceAccept,type VoiceMediaSocket,type VoicePolicy} from '../src/space-host/voice.js'
import {decodeAudio,decodeControl,deriveCallKeys,encodeAudio,encodeControl,FRAME_AUDIO,FRAME_CONTROL,FrameReceiver,FrameSender,generateEphemeral,startHash,type Ephemeral} from '../src/space-host/voice-crypto.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {realtimeCapabilities} from '../src/realtime/capabilities.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {chmod} from 'node:fs/promises'
import './helpers/space-host-sync-open.js'

const CONTENT_KEY = randomBytes(32)
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < deadline, `timed out waiting for ${label}`); await tick(5) }
}

/** Fake provider and Host voice port: records every call in order. */
function fakeHost(options: {chat?: (id: string) => void} = {}) {
  const events: string[] = [], audio: number[] = [], receipts: string[] = []
  const arbiter = new AudioOwnerArbiter()
  let remote: string | null = null, voiceId: string | null = null
  const port: SpaceVoiceHostPort = {
    arbiter,
    requireChat: options.chat ?? (id => { if (id !== 'chat:main') throw Error('conversation_read_only') }),
    voiceConversationId: () => voiceId,
    startVoice: async id => { events.push(`start:${id}`); voiceId = id },
    stopVoice: async id => { events.push(`stop:${id}`); voiceId = null },
    sendAudio: async (_id, pcm) => { audio.push(pcm.length) },
    receipts: () => ({
      playbackStarted: (u, e) => { receipts.push(`started:${u}:${e}`); return true },
      playbackDone: (u, e, ms) => { receipts.push(`done:${u}:${e}:${ms}`); return true },
      playbackStopped: async (u, e, ms) => { receipts.push(`stopped:${u}:${e}:${ms}`); return true },
      playbackCleared: (u, e, ms) => { receipts.push(`cleared:${u}:${e}:${ms}`); return true },
    }),
    setRemoteVoice: id => { remote = id; events.push(`remote:${id}`) },
  }
  return {port, events, audio, receipts, arbiter, remote: () => remote, setVoiceId: (id: string | null) => { voiceId = id }}
}
/** In-memory relay: one Host socket per connect; the test drives the phone end. */
function fakeMedia(capability: {codecs: string[]; maxKbpsPerDirection: number; maxFrameBytes?: number} | null = {codecs: ['pcm16'], maxKbpsPerDirection: 512, maxFrameBytes: 4096}) {
  const state: {reserved: string[]; toPhone: Uint8Array[]; hostFrame?: (f: Uint8Array) => void; hostClose?: (r: string) => void; closed: boolean} = {reserved: [], toPhone: [], closed: false}
  return {
    state,
    media: {
      capabilities: async () => ({media: capability}),
      reserve: async (session: string) => { state.reserved.push(session) },
      connect: async (): Promise<VoiceMediaSocket> => ({
        send: async frame => { if (state.closed) throw Error('closed'); state.toPhone.push(Uint8Array.from(frame)) },
        onFrame: listener => { state.hostFrame = listener },
        onClose: listener => { state.hostClose = listener },
        close: () => { state.closed = true },
      }),
    },
  }
}
function controller(host: ReturnType<typeof fakeHost>, media = fakeMedia(), extra: Partial<ConstructorParameters<typeof SpaceVoiceController>[0]> = {}) {
  const notes: Record<string, unknown>[] = []
  let policy: VoicePolicy = 'owner', owner: string | undefined = 'phone'
  const c = new SpaceVoiceController({space: 'space-1', epoch: 2, hostDevice: 'host-1', contentKey: CONTENT_KEY, policy: () => policy, owner: () => owner,
    host: host.port, media: media.media, notify: async (to, body) => { notes.push({to, ...body}) }, joinTimeoutMs: 1000, keepaliveMs: 50, idleMs: 400, tickMs: 5, ...extra})
  return {c, media, notes, setPolicy: (p: VoicePolicy) => { policy = p }, setOwner: (o: string | undefined) => { owner = o }}
}
function startIntent(eph: Ephemeral, extra: {op?: string; offers?: unknown; voice_mode?: string; conversation?: string} = {}) {
  const now = Date.now()
  return {v: 1, type: 'intent', kind: 'voice.start', op_id: extra.op ?? 'op-1', created_at: now, expires_at: now + 15000,
    input: {conversation_id: extra.conversation ?? 'chat:main', voice_mode: extra.voice_mode ?? 'chat', eph: eph.publicKey, nonce: randomBytes(32).toString('base64url'),
      offers: extra.offers ?? {codecs: ['pcm16'], frame_ms: [40]}, deadline: now + 15000}}
}
/** Phone simulator built only from the shared crypto primitives. */
function phone(raw: Record<string, unknown>, eph: Ephemeral, accept: VoiceAccept, device = 'phone') {
  const hash = startHash({start: raw, space: 'space-1', epoch: 2, client: device, host: 'host-1'})
  assert.equal(hash.toString('base64url'), accept.start_hash)
  const keys = deriveCallKeys({own: eph, peer: accept.eph, contentKey: CONTENT_KEY, startHash: hash, ephC: eph.publicKey, ephH: accept.eph, session: accept.session, codec: 'pcm16', frameMs: 40})
  return {hash, sender: new FrameSender(keys.up), receiver: new FrameReceiver(keys.down)}
}
function decodeAll(p: ReturnType<typeof phone>, frames: Uint8Array[]) {
  return frames.map(f => p.receiver.open(f)!).filter(Boolean).map(o => o.type === FRAME_AUDIO ? {audio: decodeAudio(o.plaintext)} : o.type === FRAME_CONTROL ? {control: decodeControl(o.plaintext)} : {keepalive: true})
}
async function connected(extra: Partial<ConstructorParameters<typeof SpaceVoiceController>[0]> = {}) {
  const host = fakeHost(), ctl = controller(host, fakeMedia(), extra), eph = generateEphemeral(), raw = startIntent(eph)
  await ctl.c.refreshCapability()
  const {call, accept} = await ctl.c.begin('phone', raw)
  const sim = phone(raw, eph, accept)
  await call.prepare()
  await until(() => ctl.media.state.hostFrame !== undefined, 'join')
  return {host, ctl, call, accept, sim}
}

test('authorization matrix: policy and owner rules, chat-only conversations, chat voice mode', () => {
  const chat = (id: string) => { if (id !== 'chat:main') throw Error('conversation_read_only') }
  const cases: [VoicePolicy, string | undefined, string, string, string | undefined, string | null][] = [
    ['off', 'phone', 'phone', 'chat:main', 'chat', 'voice_disabled'],
    ['owner', undefined, 'phone', 'chat:main', 'chat', 'owner_unassigned'],
    ['owner', 'phone', 'other', 'chat:main', 'chat', 'owner_required'],
    ['owner', 'phone', 'phone', 'chat:main', 'chat', null],
    ['owner', 'phone', 'phone', 'chat:main', undefined, null],
    ['owner', 'phone', 'phone', 'build:x', 'chat', 'conversation_read_only'],
    ['owner', 'phone', 'phone', 'chat:main', 'build', 'voice_mode_unavailable'],
    ['members', undefined, 'other', 'chat:main', 'chat', null],
    ['members', 'phone', 'other', 'plan:x', 'chat', 'conversation_read_only'],
    ['members', 'phone', 'other', 'chat:main', 'delegate', 'voice_mode_unavailable'],
  ]
  for (const [policy, owner, sender, conversationId, voiceMode, expected] of cases) {
    const run = () => authorizeVoice({policy, owner, sender, conversationId, voiceMode, requireChat: chat})
    if (expected === null) assert.doesNotThrow(run, `${policy}/${owner}/${sender}`)
    else assert.throws(run, new RegExp(expected), `${policy}/${owner}/${sender}/${conversationId}/${voiceMode}`)
  }
})

test('start refusals: codec, deadline, relay media, busy owner and capability per caller', async () => {
  const host = fakeHost(), noMedia = controller(host, fakeMedia(null)), eph = generateEphemeral()
  await assert.rejects(() => noMedia.c.begin('phone', startIntent(eph)), /relay_media_unavailable/)
  assert.equal(noMedia.c.available('phone'), false)
  const ctl = controller(host); await ctl.c.refreshCapability()
  assert.equal(ctl.c.available('phone'), true); assert.equal(ctl.c.available('other'), false)
  ctl.setOwner(undefined); assert.equal(ctl.c.available('phone'), false); ctl.setOwner('phone')
  await assert.rejects(() => ctl.c.begin('phone', startIntent(eph, {offers: {codecs: ['opus'], frame_ms: [40]}})), /codec_unavailable/)
  const long = {...startIntent(eph), expires_at: Date.now() + 60_000}
  await assert.rejects(() => ctl.c.begin('phone', long), /voice_deadline_required/)
  await assert.rejects(() => ctl.c.begin('phone', {...startIntent(eph), input: {bogus: true}}), /invalid_voice_start/)
  const desktop = host.arbiter.claim('desktop')
  await assert.rejects(() => ctl.c.begin('phone', startIntent(eph)), /voice_active/)
  host.arbiter.release(desktop); host.setVoiceId('chat:main')
  await assert.rejects(() => ctl.c.begin('phone', startIntent(eph)), /voice_active/)
})

test('no provider work before an authenticated ready; uplink, re-chunked downlink, terminal, clear and receipts', async () => {
  const {host, ctl, call, sim} = await connected({idleMs: 5000})
  assert.equal(host.events.length, 0)
  assert.equal(host.arbiter.spaceDevice, 'phone')
  // A wrong start hash is a protocol error; use the right one.
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'ready', start_hash: sim.hash.toString('base64url')})))
  await until(() => call.state === 'active', 'active')
  assert.deepEqual(host.events, ['remote:chat:main', 'start:chat:main'])
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_AUDIO, encodeAudio({gen: 0, nativeSeq: 0, sampleOffset: 0, pcm: new Uint8Array(1280)})))
  await until(() => host.audio.length === 1, 'uplink'); assert.deepEqual(host.audio, [1280])
  ctl.c.sink.onAudioFrame({utterance_id: 'u1', generation_epoch: 4, sequence: 0, pcm: new Uint8Array(5000)})
  ctl.c.sink.onAudioTerminal('u1', 4)
  await until(() => ctl.media.state.toPhone.length >= 6, 'downlink')
  const received = decodeAll(sim, ctl.media.state.toPhone)
  assert.equal(received[0]!.control?.type, 'ready')
  assert.deepEqual(received[1]!.control, {type: 'playback.start', gen: 0, utterance_id: 'u1', generation_epoch: 4})
  const audio = received.filter(r => r.audio).map(r => r.audio!)
  assert.deepEqual(audio.map(a => [a.nativeSeq, a.sampleOffset, a.pcm.length]), [[0, 0, 1920], [1, 960, 1920], [2, 1920, 1160]])
  // Terminal names its end position, so a Client can tell whether it holds the whole utterance.
  assert.deepEqual(received.at(-1)!.control, {type: 'playback.terminal', utterance_id: 'u1', generation_epoch: 4, last_native_seq: 2, end_offset: 2500})
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'playback.started', utterance_id: 'u1', generation_epoch: 4})))
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'playback.stopped', utterance_id: 'u1', generation_epoch: 4, played_ms: 80, reason: 'loss'})))
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'playback.done', utterance_id: 'unknown', generation_epoch: 4, played_ms: 1})))
  await until(() => host.receipts.length === 2, 'receipts')
  assert.deepEqual(host.receipts, ['started:u1:4', 'stopped:u1:4:80'])
  // A clear after playback.start was written drops queued audio and is sent at once; the Client reports it.
  ctl.media.state.toPhone.length = 0
  ctl.c.sink.onAudioFrame({utterance_id: 'u2', generation_epoch: 5, sequence: 0, pcm: new Uint8Array(48 * 3000)})
  await until(() => decodeAll(sim, ctl.media.state.toPhone).some(r => r.control?.type === 'playback.start'), 'u2 start')
  ctl.c.sink.onAudioClear('u2', 5)
  assert.equal(call.queuedAudioMs, 0)
  await until(() => decodeAll(sim, ctl.media.state.toPhone).some(r => r.control?.type === 'playback.clear'), 'clear')
  assert.ok(!host.receipts.some(r => r.startsWith('cleared:u2')))
  await call.end('stopped')
})

test('downlink pacing keeps the lead bounded and the rate at most 1.25x realtime', async () => {
  const {ctl, call, sim} = await connected({leadMs: 200, paceFactor: 1.25, idleMs: 5000})
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'ready', start_hash: sim.hash.toString('base64url')})))
  await until(() => call.state === 'active')
  const started = Date.now()
  ctl.c.sink.onAudioFrame({utterance_id: 'u', generation_epoch: 1, sequence: 0, pcm: new Uint8Array(48 * 2000)})
  await tick(20)
  const sentMs = () => decodeAll(sim, ctl.media.state.toPhone.splice(0)).filter(r => r.audio).reduce((n, r) => n + r.audio!.pcm.length / 48, 0)
  let total = sentMs()
  assert.ok(total <= 200 + 40, `initial burst ${total} ms exceeds the lead`)
  await tick(400)
  total += sentMs()
  const elapsed = Date.now() - started
  assert.ok(total <= 200 + 40 + elapsed * 1.25, `sent ${total} ms of audio in ${elapsed} ms`)
  await call.end('stopped')
})

test('lease fencing: a stale release cannot free a newer call; desktop takeover fences then cleans up', async () => {
  const {host, ctl, call, sim, accept} = await connected()
  ctl.media.state.hostFrame!(sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'ready', start_hash: sim.hash.toString('base64url')})))
  await until(() => call.state === 'active')
  assert.equal(host.arbiter.release(call.lease! - 1), false)
  assert.equal(host.arbiter.spaceDevice, 'phone')
  assert.equal(await ctl.c.stop('phone', 'not-this-call'), false)
  await host.arbiter.takeOver('taken_over')
  assert.equal(call.state, 'ended')
  assert.equal(host.arbiter.current, null)
  assert.deepEqual(host.events.slice(-2), ['stop:chat:main', 'remote:null'])
  assert.deepEqual(ctl.notes.at(-1), {to: 'phone', type: 'voice.ended', op_id: 'op-1', session: accept.session, reason: 'taken_over'})
  const local = host.arbiter.claim('desktop'); assert.ok(local > 0)
})

test('revocation or epoch rotation, policy change, idle and join timeout all end calls fence-first', async () => {
  for (const [name, act, reason] of [
    ['epoch rotation', async (c: Awaited<ReturnType<typeof connected>>) => { await c.ctl.c.closeAll('epoch_rotated') }, 'epoch_rotated'],
    ['policy change', async (c: Awaited<ReturnType<typeof connected>>) => { c.ctl.setPolicy('off'); await c.ctl.c.policyChanged() }, 'policy_changed'],
    ['owner change', async (c: Awaited<ReturnType<typeof connected>>) => { c.ctl.setOwner('other'); await c.ctl.c.policyChanged() }, 'policy_changed'],
    ['idle', async (c: Awaited<ReturnType<typeof connected>>) => { await until(() => c.call.state === 'ended', 'idle end') }, 'idle'],
  ] as const) {
    const c = await connected()
    c.ctl.media.state.hostFrame!(c.sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'ready', start_hash: c.sim.hash.toString('base64url')})))
    await until(() => c.call.state === 'active')
    let stateAtStop = ''
    const stop = c.host.port.stopVoice.bind(c.host.port)
    c.host.port.stopVoice = async id => { stateAtStop = c.call.state; await stop(id) }
    await act(c)
    await until(() => c.call.state === 'ended')
    assert.equal(stateAtStop, 'ending', name)
    assert.equal(c.ctl.notes.at(-1)?.reason, reason, name)
    assert.equal(c.host.arbiter.current, null, name)
    assert.equal(c.ctl.media.state.closed, true, name)
  }
  const late = await connected({joinTimeoutMs: 50})
  await until(() => late.call.state === 'ended', 'join timeout')
  assert.equal(late.ctl.notes.at(-1)?.reason, 'join_timeout')
  assert.equal(late.host.events.length, 0) // never started the provider
})

test('two phones on the same conversation: exactly one call, the other gets voice_active', async () => {
  const host = fakeHost(), ctl = controller(host); ctl.setPolicy('members'); await ctl.c.refreshCapability()
  const first = await ctl.c.begin('phone', startIntent(generateEphemeral(), {op: 'a'}))
  await assert.rejects(() => ctl.c.begin('phone2', startIntent(generateEphemeral(), {op: 'b'})), /voice_active/)
  // The same device's second start replaces only its own call.
  const second = await ctl.c.begin('phone', startIntent(generateEphemeral(), {op: 'c'}))
  assert.equal(first.call.state, 'ended'); assert.equal(host.arbiter.spaceDevice, 'phone')
  await second.call.end('stopped')
})

test('SpaceHost journals voice.start by (sender, op_id), streams the accept, advertises capability per caller', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-voice-'))
  const sent: Record<string, unknown>[] = [], streamed: Record<string, unknown>[] = []
  const transport: SpaceHostTransport = {start: () => Promise.resolve(() => undefined), send: (_to, body) => { sent.push(body); return Promise.resolve() },
    stream: (_to, body) => { streamed.push(body); return Promise.resolve() }, clients: () => ['phone', 'other']}
  const personal = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  personal.enableSpaceVoice()
  const real = personal.spaceVoicePort()!
  const fake = fakeHost({chat: id => real.requireChat(id)})
  const ctl = controller(fake)
  const space = new SpaceHost({path: join(dir, 'space.json'), space: 'space-1', host: personal, transport, owner: () => 'phone', voice: ctl.c})
  try {
    await personal.open({deferBackground: true}); await space.open(); await ctl.c.refreshCapability()
    assert.deepEqual(space.snapshot('phone').host_capabilities, ['voice.v1'])
    assert.deepEqual(space.snapshot('other').host_capabilities, [])
    const raw = startIntent(generateEphemeral())
    await space.receive('phone', raw); await space.receive('phone', raw)
    const receipts = sent.filter(row => row.type === 'receipt' && row.op_id === 'op-1')
    assert.equal(receipts.length, 2); assert.equal(receipts[0]!.status, 'accepted')
    assert.deepEqual(receipts[0]!.voice, receipts[1]!.voice)
    assert.equal(streamed.filter(row => row.type === 'voice.accept').length, 1)
    await space.receive('other', {...startIntent(generateEphemeral()), op_id: 'op-2'})
    assert.equal(sent.find(row => row.op_id === 'op-2')?.error, 'owner_required')
    await space.receive('phone', {v: 1, type: 'intent', kind: 'voice.stop', op_id: 'stop-1', created_at: Date.now(), input: {op_id: 'op-1'}})
    await until(() => fake.arbiter.current === null, 'stopped')
    await space.receive('phone', {...startIntent(generateEphemeral(), {conversation: 'missing'}), op_id: 'op-3'})
    assert.equal(sent.find(row => row.op_id === 'op-3')?.error, 'conversation_not_found')
  } finally { await space.close(); await personal.close(); await rm(dir, {recursive: true, force: true}) }
})

const ready = (c: {ctl: ReturnType<typeof controller>; sim: ReturnType<typeof phone>}) =>
  c.ctl.media.state.hostFrame!(c.sim.sender.seal(FRAME_CONTROL, encodeControl({type: 'ready', start_hash: c.sim.hash.toString('base64url')})))

test('a clear before playback.start left the Host is recorded by the Host as cleared at 0 ms and nothing is sent', async () => {
  const {host, ctl, call, sim} = await connected({idleMs: 5000})
  ready({ctl, sim}); await until(() => call.state === 'active', 'active')
  ctl.media.state.toPhone.length = 0
  ctl.c.sink.onAudioFrame({utterance_id: 'u9', generation_epoch: 7, sequence: 0, pcm: new Uint8Array(48 * 1000)})
  ctl.c.sink.onAudioClear('u9', 7) // same tick: playback.start is still queued
  assert.deepEqual(host.receipts, ['cleared:u9:7:0'])
  await tick(30)
  const sent = decodeAll(sim, ctl.media.state.toPhone).filter(r => !r.keepalive)
  assert.deepEqual(sent, [], 'no playback.start, audio or clear for a generation the Client never saw')
  await call.end('stopped')
})

test('the Host sends its ready only after startVoice succeeds; Client audio before it is never needed', async () => {
  const c = await connected({idleMs: 5000})
  let release!: () => void
  const start = c.host.port.startVoice.bind(c.host.port)
  c.host.port.startVoice = async id => { await new Promise<void>(resolve => { release = resolve }); await start(id) }
  ready(c)
  await until(() => release !== undefined, 'startVoice pending')
  await tick(20)
  assert.deepEqual(decodeAll(c.sim, c.ctl.media.state.toPhone), [], 'no ready while the provider is starting')
  assert.equal(c.call.state, 'joining')
  release()
  await until(() => c.call.state === 'active', 'active')
  await until(() => c.ctl.media.state.toPhone.length === 1, 'ready')
  assert.equal(decodeAll(c.sim, c.ctl.media.state.toPhone)[0]!.control?.type, 'ready')
  // The Client sends mic audio only after that ready, and the Host forwards it.
  c.ctl.media.state.hostFrame!(c.sim.sender.seal(FRAME_AUDIO, encodeAudio({gen: 0, nativeSeq: 0, sampleOffset: 0, pcm: new Uint8Array(1280)})))
  await until(() => c.host.audio.length === 1, 'uplink')
  await c.call.end('stopped')
})

test('a failed startVoice sends no ready and ends the call', async () => {
  const c = await connected({idleMs: 5000})
  c.host.port.startVoice = async () => { throw Error('provider_unavailable') }
  ready(c)
  await until(() => c.call.state === 'ended', 'ended')
  assert.ok(!decodeAll(c.sim, c.ctl.media.state.toPhone).some(r => r.control?.type === 'ready'))
  assert.equal(c.call.endReason.value, 'provider_unavailable')
})

test('pcm16 is advertised and admitted only when the relay frame limit fits the largest sealed audio packet', async () => {
  assert.equal(VOICE_MAX_AUDIO_FRAME_BYTES, 12 + 10 + 1920 + 16)
  for (const [max, ok] of [[1024, false], [VOICE_MAX_AUDIO_FRAME_BYTES - 1, false], [VOICE_MAX_AUDIO_FRAME_BYTES, true], [undefined, false]] as const) {
    const host = fakeHost(), small = controller(host, fakeMedia({codecs: ['pcm16'], maxKbpsPerDirection: 512, ...(max === undefined ? {} : {maxFrameBytes: max})}))
    await small.c.refreshCapability()
    assert.equal(small.c.available('phone'), ok, String(max))
    if (!ok) await assert.rejects(() => small.c.begin('phone', startIntent(generateEphemeral())), /relay_media_unavailable/)
  }
})

test('teardown while the provider is still starting stops it once it comes up and leaves no voice owner', async () => {
  const c = await connected({idleMs: 5000})
  let release!: () => void
  const start = c.host.port.startVoice.bind(c.host.port)
  c.host.port.startVoice = async id => { await new Promise<void>(resolve => { release = resolve }); await start(id) }
  ready(c)
  await until(() => release !== undefined, 'startVoice pending')
  const ending = c.call.end('stopped')
  release()
  await ending
  assert.deepEqual(c.host.events, ['remote:chat:main', 'start:chat:main', 'stop:chat:main', 'remote:null'])
  assert.equal(c.host.port.voiceConversationId(), null)
  assert.equal(c.host.arbiter.current, null)
})

test('authorization is re-checked at provider admission: a conversation switched away from chat during the join is refused', async () => {
  let readOnly = false
  const host = fakeHost({chat: id => { if (readOnly || id !== 'chat:main') throw Error('conversation_read_only') }})
  const ctl = controller(host); await ctl.c.refreshCapability()
  const eph = generateEphemeral(), raw = startIntent(eph)
  const {call, accept} = await ctl.c.begin('phone', raw); await call.prepare()
  readOnly = true
  ready({ctl, sim: phone(raw, eph, accept)})
  await until(() => call.state === 'ended')
  assert.equal(ctl.notes.at(-1)?.reason, 'conversation_read_only')
  assert.equal(host.events.filter(e => e.startsWith('start:')).length, 0)
  // Membership and owner changes during the join are refused the same way.
  for (const [mutate, reason] of [[(x: ReturnType<typeof controller>) => x.setOwner('other'), 'owner_required'], [(x: ReturnType<typeof controller>) => x.setPolicy('off'), 'voice_disabled']] as const) {
    const h = fakeHost(), x = controller(h); await x.c.refreshCapability()
    const e = generateEphemeral(), r = startIntent(e), started = await x.c.begin('phone', r); await started.call.prepare()
    mutate(x); ready({ctl: x, sim: phone(r, e, started.accept)})
    await until(() => started.call.state === 'ended'); assert.equal(x.notes.at(-1)?.reason, reason); assert.equal(h.events.length, 0)
  }
  let member = true
  const h = fakeHost(), x = controller(h, fakeMedia(), {member: () => member}); await x.c.refreshCapability()
  const e = generateEphemeral(), r = startIntent(e), started = await x.c.begin('phone', r); await started.call.prepare()
  member = false; ready({ctl: x, sim: phone(r, e, started.accept)})
  await until(() => started.call.state === 'ended'); assert.equal(x.notes.at(-1)?.reason, 'sender_not_paired')
})

test('Host admission refuses chat voice on a conversation that is no longer chat instead of forcing a chat override', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-voice-admission-'))
  const personal = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  try {
    await personal.open({deferBackground: true}); personal.enableSpaceVoice()
    const port = personal.spaceVoicePort()!
    await personal.command({type: 'personal.command', request_id: 'workbench', method: 'presentation.set', params: {mode: 'workbench'}}, {client_id: 'desktop:local'})
    await personal.command({type: 'personal.command', request_id: 'create', method: 'conversations.create', params: {title: 'Topic'}}, {client_id: 'desktop:local'})
    const id = personal.conversationSnapshot().selected_id
    port.requireChat(id)
    const switched = await personal.command({type: 'personal.command', request_id: 'mode', method: 'conversations.mode', params: {id, mode: 'plan'}}, {client_id: 'desktop:local'}) as {ok: boolean; error?: string}
    assert.equal(switched.ok, true, switched.error)
    assert.throws(() => port.requireChat(id), /conversation_read_only/)
    await assert.rejects(port.startVoice(id), /conversation_read_only/)
    assert.equal(port.voiceConversationId(), null)
  } finally { await personal.close(); await rm(dir, {recursive: true, force: true}) }
})

test('a stalled provider: the mic backlog stays bounded, the call ends, and teardown does not wait on sendAudio', async () => {
  const c = await connected({idleMs: 5000, providerStallMs: 150})
  const sent: number[] = []
  c.host.port.sendAudio = (_id, pcm) => { sent.push(pcm.length); return new Promise<void>(() => undefined) }
  ready(c); await until(() => c.call.state === 'active')
  for (let i = 0; i < 60; i++) c.ctl.media.state.hostFrame!(c.sim.sender.seal(FRAME_AUDIO, encodeAudio({gen: 0, nativeSeq: i, sampleOffset: i * 640, pcm: new Uint8Array(1280)})))
  await until(() => sent.length === 1, 'first write')
  assert.ok(c.call.uplinkQueuedMs <= 500, `queued ${c.call.uplinkQueuedMs} ms`)
  const began = Date.now()
  await until(() => c.call.state === 'ended', 'stall end')
  assert.ok(Date.now() - began < 1000)
  assert.equal(c.ctl.notes.at(-1)?.reason, 'provider_stalled')
  assert.deepEqual(c.host.events.slice(-2), ['stop:chat:main', 'remote:null'])
  assert.equal(c.host.arbiter.current, null)
  assert.equal(sent.length, 1)
})

test('terminal overtaking queued audio is detectable: the Client holds the prefix until last_native_seq, else fences', async () => {
  const {ctl, call, sim} = await connected({idleMs: 5000})
  ready({ctl, sim}); await until(() => call.state === 'active')
  ctl.c.sink.onAudioFrame({utterance_id: 'u', generation_epoch: 1, sequence: 0, pcm: new Uint8Array(1920 * 3)})
  ctl.c.sink.onAudioTerminal('u', 1)
  const frames: ReturnType<typeof decodeAll> = []
  await until(() => { frames.push(...decodeAll(sim, ctl.media.state.toPhone.splice(0))); return frames.some(r => r.control?.type === 'playback.terminal') })
  const terminal = frames.find(r => r.control?.type === 'playback.terminal')!.control!
  const audio = frames.filter(r => r.audio).map(r => r.audio!)
  // Simulate the relay delivering terminal before the final packet (control overtakes queued audio).
  const complete = (seen: typeof audio) => seen.length > 0 && seen.every((a, i) => a.nativeSeq === i) &&
    seen.at(-1)!.nativeSeq === terminal.last_native_seq && seen.at(-1)!.sampleOffset + seen.at(-1)!.pcm.length / 2 === terminal.end_offset
  assert.equal(complete(audio.slice(0, 2)), false)
  assert.equal(complete(audio), true)
  await call.end('stopped')
})

test('the accept is published only after the relay session is reserved and the Host leg joined', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-voice-order-'))
  const log: string[] = []
  const transport: SpaceHostTransport = {start: () => Promise.resolve(() => undefined), send: (_to, body) => { log.push(`send:${String(body.type)}:${typeof body.status === 'string' ? body.status : ''}`); return Promise.resolve() },
    stream: (_to, body) => { log.push(`stream:${String(body.type)}`); return Promise.resolve() }, clients: () => ['phone']}
  const personal = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const fake = fakeHost(), media = fakeMedia()
  const reserve = media.media.reserve, connect = media.media.connect
  media.media.reserve = async session => { await tick(20); log.push('reserve'); await reserve(session) }
  media.media.connect = async () => { await tick(20); log.push('connect'); return connect() }
  const ctl = controller(fake, media)
  const space = new SpaceHost({path: join(dir, 'space.json'), space: 'space-1', host: personal, transport, owner: () => 'phone', voice: ctl.c})
  try {
    await personal.open({deferBackground: true}); await space.open(); await ctl.c.refreshCapability()
    await space.receive('phone', startIntent(generateEphemeral())); await space.flush()
    const first = log.findIndex(e => e === 'stream:voice.accept' || e === 'send:receipt:accepted')
    assert.ok(first > log.indexOf('connect') && log.indexOf('connect') > log.indexOf('reserve') && log.includes('reserve'), log.join(','))
    // A relay failure after the lease claim is a refusal: no accepted receipt is ever queued.
    const broken = fakeMedia(); broken.media.connect = () => Promise.reject(Error('relay down'))
    const ctl3 = controller(fakeHost(), broken), sent3: Record<string, unknown>[] = []
    const space3 = new SpaceHost({path: join(dir, 'space3.json'), space: 'space-1', host: personal, transport: {...transport, send: (_to, body) => { sent3.push(body); return Promise.resolve() }}, owner: () => 'phone', voice: ctl3.c})
    try {
      await space3.open(); await ctl3.c.refreshCapability()
      await space3.receive('phone', {...startIntent(generateEphemeral()), op_id: 'broken'}); await space3.flush()
      const receipts = sent3.filter(row => row.type === 'receipt' && row.op_id === 'broken')
      assert.deepEqual(receipts.map(row => [row.status, row.error]), [['rejected', 'relay_media_unavailable']])
    } finally { await space3.close() }
    // A relay that never joins is a refusal, and the owner lease is free again.
    const slow = fakeHost(), stuck = fakeMedia(); stuck.media.connect = () => new Promise(() => undefined)
    const ctl2 = controller(slow, stuck, {joinTimeoutMs: 50}); await ctl2.c.refreshCapability()
    const started = await ctl2.c.begin('phone', startIntent(generateEphemeral()))
    await assert.rejects(started.call.prepare(), /join_timeout/)
    assert.equal(slow.arbiter.current, null)
  } finally { await space.close(); await personal.close(); await rm(dir, {recursive: true, force: true}) }
})

test('a journal write failure after the start releases the owner lease', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-voice-journal-'))
  const transport: SpaceHostTransport = {start: () => Promise.resolve(() => undefined), send: () => Promise.resolve(), stream: () => Promise.resolve(), clients: () => ['phone']}
  const personal = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const spaceDir = join(dir, 'space'); await import('node:fs/promises').then(fs => fs.mkdir(spaceDir, {mode: 0o700}))
  // The journal becomes unwritable only once the start passed authorization and the lease claim.
  const fake = fakeHost(), media = fakeMedia(), reserve = media.media.reserve
  media.media.reserve = async session => { await chmod(spaceDir, 0o500); await reserve(session) }
  const ctl = controller(fake, media)
  const space = new SpaceHost({path: join(spaceDir, 'space.json'), space: 'space-1', host: personal, transport, owner: () => 'phone', voice: ctl.c})
  try {
    await personal.open({deferBackground: true}); await space.open(); await ctl.c.refreshCapability()
    await assert.rejects(space.receive('phone', startIntent(generateEphemeral())), /EACCES/)
    assert.deepEqual(media.state.reserved.length, 1)
    assert.equal(fake.arbiter.current, null)
    assert.equal(ctl.c.call('phone'), undefined)
  } finally { await chmod(spaceDir, 0o700); await space.close(); await personal.close(); await rm(dir, {recursive: true, force: true}) }
})

test('a backgrounded desktop still feeds the Space call conversation microphone through the real runtime path', {timeout: 10000}, async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-voice-background-'))
  const host = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  let frames = 0
  const provider: RealtimeProvider = {capabilities: realtimeCapabilities.cascaded, connect: () => Promise.resolve({epoch: 1, provider_session_id: 'space-voice'}),
    sendAudio: () => { frames++; return Promise.resolve() }, injectHostItem: () => Promise.resolve(), createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    async *events(signal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})) }}
  try {
    await host.open()
    host.setConversationRuntime(conversationRuntimeFactory({host, memory: () => undefined, settings: settingsSchema.parse({executors: [], camera_module_enabled: false, cascade_llm_provider: 'qwen', dashscope_api_key: 'test'}),
      createVoiceProvider: () => provider, searchTransport: {search: () => Promise.reject(Error('unused'))}}), () => undefined)
    host.enableSpaceVoice()
    const port = host.spaceVoicePort()!
    port.setRemoteVoice('chat:main'); await port.startVoice('chat:main')
    await host.command({type: 'personal.command', request_id: 'hide', method: 'presentation.set', params: {mode: 'background'}})
    for (let i = 0; i < 50 && frames === 0; i++) { await port.sendAudio('chat:main', new Uint8Array(640)); await tick(10) }
    assert.ok(frames > 0, 'call-owned microphone frames reach the provider while backgrounded')
    // Without the call exemption the same frames are dropped.
    port.setRemoteVoice(null)
    await assert.rejects(port.sendAudio('chat:main', new Uint8Array(640)), /presentation_hidden/)
    await port.stopVoice('chat:main')
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}) }
})
