import assert from 'node:assert/strict'
import {test} from 'node:test'
import {logicalSwipeDistance, runMobileIos, type MobileIosConfig} from '../src/executors/mobile-ios.js'

test('AutoGLM physical swipe distance converts once to logical coordinates', () => {
  assert.equal(logicalSwipeDistance(600, 3), 200)
  assert.equal(logicalSwipeDistance(200, 1), 200)
  assert.throws(() => logicalSwipeDistance(600, 0))
  assert.throws(() => logicalSwipeDistance(Infinity, 3))
})

test('mobile runner rejects unverified physical devices and pre-cancelled runs before approval', async () => {
  const config: MobileIosConfig = {deviceId: 'unverified', deviceType: 'ios', wdaUrl: 'http://127.0.0.1:8100',
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'stub', modelFamily: 'auto-glm', apiKey: 'stub',
    maxSteps: 3, budgetMs: 1000, lockRoot: '/tmp'}
  const approve = (): Promise<boolean> => { assert.fail('must not request approval') }
  assert.deepEqual(await runMobileIos(config, 'tap', {signal: new AbortController().signal, approve, progress: () => undefined}),
    {code: 'invalid_configuration', steps: 0})
  assert.deepEqual(await runMobileIos(config, 'tap', {signal: AbortSignal.abort(), approve, progress: () => undefined}),
    {code: 'cancelled', steps: 0})
})

test('uncertain device write overrides cancellation and timeout', async () => {
  const {mobileWriteFailure} = await import('../src/executors/mobile-ios.js')
  for (const stopped of [undefined, 'cancelled', 'timeout']) {
    assert.equal(mobileWriteFailure(new Error('cleanup_unknown'), true, stopped), 'cleanup_unknown')
    assert.equal(mobileWriteFailure(new Error('network failed'), false, stopped), 'cleanup_unknown')
  }
  assert.equal(mobileWriteFailure(new Error('needs_user_action'), true), 'needs_user_action')
  assert.equal(mobileWriteFailure(new Error('action_failed'), true, 'cancelled'), 'cancelled')
})

test('physical iOS identity requires an exact USB iproxy UDID and WDA port mapping', async () => {
  const {validIosUsbForwarder} = await import('../src/executors/mobile-ios.js')
  const udid = '00000000-1111222233334444'
  assert.equal(validIosUsbForwarder('/opt/homebrew/bin/iproxy', `iproxy -u ${udid} 8101:8100`, udid, 8101), true)
  assert.equal(validIosUsbForwarder('iproxy', `iproxy --udid ${udid} --local --source 127.0.0.1 8101:8100`, udid, 8101), true)
  for (const args of [`iproxy 8101:8100`, `iproxy -u other 8101:8100`, `iproxy -u ${udid} --network 8101:8100`,
    `iproxy -u ${udid} 8101:9000`, `iproxy -u ${udid} -s 0.0.0.0 8101:8100`, `iproxy -u ${udid} -u other 8101:8100`])
    assert.equal(validIosUsbForwarder('iproxy', args, udid, 8101), false)
})
