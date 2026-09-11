import test from 'node:test'
import assert from 'node:assert/strict'
import {CameraDevicePool} from '../src/renderer/camera.mjs'

function hardware() {
  const tracks = []
  const requests = []
  return {tracks, requests, devices: {
    enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'builtin'}, {kind: 'videoinput', deviceId: 'usb'}],
    getUserMedia: async request => {
      requests.push(request)
      const track = {readyState: 'live', stops: 0, stop() { this.stops++; this.readyState = 'ended' }}
      tracks.push(track)
      return {getVideoTracks: () => [track], getTracks: () => [track]}
    },
  }}
}
class Capture { constructor(track) { this.track = track } }

test('default conversation and selected monitor share a camera until the last lease closes', async () => {
  const h = hardware(), pool = new CameraDevicePool(h.devices, Capture)
  const main = await pool.acquire('conversation-1')
  const monitor = await pool.acquire('monitor-1', 'builtin')
  assert.equal(main, monitor)
  assert.equal(h.requests.length, 1)
  pool.release('conversation-1')
  assert.equal(h.tracks[0].stops, 0)
  assert.equal(pool.has('monitor-1'), true)
  pool.release('monitor-1')
  assert.equal(h.tracks[0].stops, 1)
  pool.dispose()
  assert.equal(h.tracks[0].stops, 1)
})

test('USB selection is exact, disconnected devices never fall back to builtin', async () => {
  const h = hardware(), pool = new CameraDevicePool(h.devices, Capture)
  await pool.acquire('monitor-1', 'usb')
  assert.equal(h.requests[0].video.deviceId.exact, 'usb')
  h.tracks[0].readyState = 'ended'
  await assert.rejects(pool.acquire('monitor-2', 'usb'), /disconnected/)
  await assert.rejects(pool.acquire('monitor-3', 'missing'), /unavailable/)
  assert.equal(h.requests.length, 1)
  pool.dispose()
})

test('late camera permission grant after cancellation releases its stream', async () => {
  const h = hardware()
  let grant
  h.devices.getUserMedia = () => new Promise(resolve => { grant = resolve })
  const pool = new CameraDevicePool(h.devices, Capture)
  const opening = pool.acquire('conversation-1')
  await new Promise(resolve => setImmediate(resolve))
  pool.release('conversation-1')
  let stops = 0
  grant({getTracks: () => [{stop: () => stops++}]})
  await assert.rejects(opening, /closed/)
  assert.equal(stops, 1)
  assert.equal(pool.has('conversation-1'), false)
})

test('renderer accepts task-bound capture wire and rejects incomplete device bindings', async () => {
  const {parseCameraCapture} = await import('../src/renderer/camera.mjs')
  const request = {type:'camera.capture',source:'local',request_id:'camera-1',session_id:'monitor-1',device_id:'usb'}
  assert.deepEqual(parseCameraCapture(JSON.stringify(request)),request)
  assert.equal(parseCameraCapture(JSON.stringify({...request,session_id:undefined})),null)
  assert.equal(parseCameraCapture(JSON.stringify({...request,device_id:undefined})),null)
})
