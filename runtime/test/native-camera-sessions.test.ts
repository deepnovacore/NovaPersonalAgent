import test from 'node:test'
import assert from 'node:assert/strict'
import {ChromiumFrameSource} from '../src/executors/chromium-frame-source.js'
import {captureConversationFrame} from '../src/camera-session.js'
import {supportsVision} from '../src/vision-capability.js'
import {VirtualClock} from '../src/clock.js'
import type {CameraCaptureRequest} from '../src/desktop.js'

test('only verified model and adapter pairs enable conversation images', () => {
  assert.equal(supportsVision('qwen', 'qwen3-vl-plus'), true)
  assert.equal(supportsVision('ark', 'doubao-seed-2-0-pro-260215'), true)
  for (const model of ['qwen-audio-3.0-realtime', 'qwen-flash', 'unknown-vl']) assert.equal(supportsVision('qwen', model), false)
  assert.equal(supportsVision('other', 'qwen3-vl-plus'), false)
})

test('conversation capture is default-device, turn-scoped and always releases', async () => {
  const requests: CameraCaptureRequest[] = [], released: string[] = []
  const source = new ChromiumFrameSource({source: 'local', clock: new VirtualClock(), transport: {
    requestCameraPermission: () => Promise.resolve('granted'),
    captureCamera: request => { requests.push(request); return Promise.resolve({payload: new Uint8Array([255,216,255,217]), media_type: 'image/jpeg', width:1280,height:720}) },
    releaseCamera: id => {released.push(id); return Promise.resolve()},
  }})
  await captureConversationFrame(source, new AbortController().signal)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.deviceId, '')
  assert.match(requests[0]?.sessionId ?? '', /^conversation-/)
  assert.deepEqual(released, [requests[0]?.sessionId])
})

test('stopping a session aborts hung capture and parent close releases remaining children', async () => {
  const released: string[] = []
  const source = new ChromiumFrameSource({source: 'local', clock: new VirtualClock(), transport: {
    captureCamera: () => new Promise(() => undefined),
    releaseCamera: id => {released.push(id); return Promise.resolve()},
  }})
  const first = await source.openSession('usb', new AbortController().signal)
  const second = await source.openSession('', new AbortController().signal, 'conversation')
  await first.start(); await second.start()
  const capture = first.snapshot()
  await new Promise(resolve => setImmediate(resolve))
  const failed = assert.rejects(capture)
  await first.stop(); await failed
  assert.equal(released.length, 1)
  await source.stop()
  assert.equal(released.length, 2)
})
