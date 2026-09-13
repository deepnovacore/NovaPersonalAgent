import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  RealtimeDesktopService,
  startDesktopActivityHeartbeat,
} from '../src/desktop/desktop-session.js'

test('client-owned provider listens before waiting for phone and stops while unattached', async () => {
  const order: string[] = []
  const stop = new AbortController()
  const never = new Promise<void>(() => { /* Deliberately parked until owner cancellation. */ })
  const owner = new RealtimeDesktopService({
    listenBeforeRealtime: true,
    realtime: {service: {waitStopped: () => never}, start: () => {
      order.push('provider'); stop.abort(); return never
    }, stop: () => { order.push('stop'); return Promise.resolve() }},
    desktop: {server: {
      start: () => { order.push('listen'); return Promise.resolve({host: '127.0.0.1', port: 19876, token: 'a'.repeat(32)}) },
      close: () => { order.push('close'); return Promise.resolve() },
    }},
    readyEndpoint: '', stop,
    announce: () => { order.push('announce'); return Promise.resolve() },
    cleanupGraceMs: 20,
  })
  await owner.run()
  assert.deepEqual(order.slice(0, 3), ['listen', 'announce', 'provider'])
  assert.equal(order.filter(x => x === 'listen').length, 1)
  assert.ok(order.includes('stop')); assert.ok(order.includes('close'))
})

test('desktop owner rejects an invalid wrapper grace before touching resources', () => {
  const untouched = (): never => { throw new Error('resource was touched') }
  assert.throws(() => new RealtimeDesktopService({
    realtime: {
      service: {waitStopped: untouched},
      start: untouched,
      stop: untouched,
    },
    desktop: {server: {start: untouched, close: untouched}},
    readyEndpoint: '127.0.0.1:51515',
    stop: new AbortController(),
    announce: untouched,
    cleanupGraceMs: 0,
  }), /desktop cleanup grace must be positive and finite/u)
})



test('activity heartbeat isolates failures, covers every idle axis, unrefs and stops on abort', t => {
  const originalInterval = globalThis.setInterval
  let tick: () => void = () => { throw new Error('timer not installed') }
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback
    return originalInterval(callback, 60_000)
  })
  const clear = t.mock.method(globalThis, 'clearInterval')
  const session = {foregroundIdle: true, floor: {state: 'idle'}, snapshot: () => ({active_delegates: [] as unknown[]})}
  const service = {session, executorState: 'idle'}
  const stop = new AbortController()
  const seen: boolean[] = []
  let publishThrows = false
  const timer = startDesktopActivityHeartbeat(service as never, idle => {
    if (publishThrows) throw new Error('transport failed')
    seen.push(idle)
  }, stop.signal)
  t.after(() => stop.abort())
  assert.equal(timer.hasRef(), false)
  tick(); assert.equal(seen.at(-1), true)
  session.foregroundIdle = false; tick(); assert.equal(seen.at(-1), false); session.foregroundIdle = true
  session.floor.state = 'speaking'; tick(); assert.equal(seen.at(-1), false); session.floor.state = 'idle'
  session.snapshot = () => ({active_delegates: [{}]}); tick(); assert.equal(seen.at(-1), false)
  session.snapshot = () => ({active_delegates: []})
  service.executorState = 'busy'; tick(); assert.equal(seen.at(-1), false); service.executorState = 'idle'
  Object.defineProperty(service, 'session', {configurable: true, get() { throw new Error('session unavailable') }})
  assert.doesNotThrow(tick); assert.equal(seen.at(-1), false)
  Object.defineProperty(service, 'session', {value: session})
  publishThrows = true; assert.doesNotThrow(tick)
  publishThrows = false; tick(); assert.equal(seen.at(-1), true)
  stop.abort(); assert.equal(clear.mock.callCount(), 1)
  const before = seen.length
  tick(); assert.equal(seen.length, before)
  const aborted = startDesktopActivityHeartbeat(service as never, () => { throw new Error('must not publish') }, stop.signal)
  assert.equal(aborted.hasRef(), false)
  assert.equal(clear.mock.callCount(), 2)
})
