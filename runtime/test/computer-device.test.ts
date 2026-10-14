import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {DeviceAction} from '@midscene/core'
import {guardComputerDevice} from '../src/executors/computer-device.js'

for (const scenario of ['allowed', 'declined', 'cancelled', 'target_changed', 'geometry_changed', 'unknown_write', 'invalid_coordinate'] as const) {
  test(`computer action guard: ${scenario}`, async () => {
    let target = 'app:window1', width = 200, writes = 0
    const controller = new AbortController()
    const raw = {interfaceType: 'computer', size: () => Promise.resolve({width, height: 300}),
      screenshotBase64: () => Promise.resolve('data:image/png;base64,unused'),
      actionSpace: () => [{name: 'Tap', call: () => {writes++; return scenario === 'unknown_write' ? Promise.reject(new Error('lost receipt')) : Promise.resolve()}}]}
    const guarded = await guardComputerDevice(raw, () => Promise.resolve({displayId: '1', width, height: 300, target}), {
      displayId: '1', signal: controller.signal, maxSteps: 3, budgetMs: 1000,
      approve: () => {
        if (scenario === 'target_changed') target = 'app:window2'
        if (scenario === 'geometry_changed') width = 201
        if (scenario === 'cancelled') controller.abort()
        return Promise.resolve(scenario !== 'declined')
      }, progress: () => undefined,
    })
    await guarded.device.screenshotBase64()
    guarded.planning()
    const action = guarded.device.actionSpace().find(value => value.name === 'Tap')!
    const call = async () => {await action.call({locate: {center: [scenario === 'invalid_coordinate' ? NaN : 100, 150]}})}
    if (scenario === 'allowed') {await call(); assert.equal(guarded.steps(), 1)}
    else await assert.rejects(call, new RegExp(({declined: 'declined', cancelled: 'cancelled', target_changed: 'screen_changed',
      geometry_changed: 'screen_changed', unknown_write: 'cleanup_unknown', invalid_coordinate: 'needs_user_action'})[scenario]))
    assert.equal(writes, scenario === 'allowed' || scenario === 'unknown_write' ? 1 : 0)
  })
}

test('unknown write is terminal even if Midscene catches the error and retries', async () => {
  let writes = 0, approvals = 0
  const raw = {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
    screenshotBase64: () => Promise.resolve('image'), actionSpace: () => [{name: 'Tap', call: () => {
      writes++; return Promise.reject(new Error('lost receipt'))
    }}]}
  const guarded = await guardComputerDevice(raw, () => Promise.resolve({displayId: '1', width: 200, height: 300, target: 'same'}),
    {displayId: '1', signal: new AbortController().signal, maxSteps: 3, budgetMs: 1000,
      approve: () => {approvals++; return Promise.resolve(true)}, progress: () => undefined})
  await guarded.device.screenshotBase64(); guarded.planning()
  const action = guarded.device.actionSpace()[0]!
  await assert.rejects(async () => {await action.call({locate: {center: [100, 150]}})}, /cleanup_unknown/u)
  await assert.rejects(async () => {await action.call({locate: {center: [100, 150]}})}, /cleanup_unknown/u)
  await assert.rejects(() => guarded.device.screenshotBase64(), /cleanup_unknown/u)
  assert.equal(writes, 1); assert.equal(approvals, 1)
  assert.equal(guarded.failure(), 'cleanup_unknown')
})

test('AutoGLM screenshot scroll distance is scaled to logical units once', async () => {
  let distance: unknown
  const raw = {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
    screenshotBase64: () => Promise.resolve('image'), actionSpace: () => [{name: 'Scroll', call: (params: unknown) => {
      distance = (params as {distance: unknown}).distance; return Promise.resolve()
    }}]}
  const guarded = await guardComputerDevice(raw, () => Promise.resolve({displayId: '1', width: 200, height: 300, target: 'same'}),
    {displayId: '1', signal: new AbortController().signal, maxSteps: 3, budgetMs: 1000, screenshotScrollDistance: true,
      approve: () => Promise.resolve(true), progress: () => undefined})
  await guarded.device.screenshotBase64(); guarded.planning()
  await guarded.device.actionSpace()[0]!.call({scrollType: 'singleAction', distance: 600, direction: 'down'},
    {uiContext: {shrunkShotToLogicalRatio: 3}} as Parameters<DeviceAction['call']>[1])
  assert.equal(distance, 200)
})

test('display IDs follow the SDK platform identity rather than treating Windows display names as Mac indexes', async () => {
  const {validComputerDisplayId} = await import('../src/executors/computer-device.js')
  assert.equal(validComputerDisplayId('0', 'darwin'), true)
  assert.equal(validComputerDisplayId('\\\\.\\DISPLAY1', 'win32'), true)
  assert.equal(validComputerDisplayId('0', 'win32'), false)
  assert.equal(validComputerDisplayId('\\\\.\\DISPLAY1', 'darwin'), false)
  assert.equal(validComputerDisplayId('\\\\.\\DISPLAY1;whoami', 'win32'), false)
})

test('planner sees only bounded single scrolls, so it cannot request untilBottom that the guard refuses', async () => {
  const {actionScrollParamSchema} = await import('@midscene/core/device')
  const raw = {interfaceType: 'browser', size: () => Promise.resolve({width: 200, height: 300}), screenshotBase64: () => Promise.resolve('frame'),
    actionSpace: () => [{name: 'Scroll', paramSchema: actionScrollParamSchema, call: () => Promise.resolve()}]}
  const guarded = await guardComputerDevice(raw, () => Promise.resolve({displayId: '1', width: 200, height: 300, target: 'page'}),
    {displayId: '1', signal: new AbortController().signal, maxSteps: 3, budgetMs: 1000, approve: () => Promise.resolve(true), progress: () => undefined})
  const schema = guarded.device.actionSpace()[0]!.paramSchema!
  assert.equal(schema.safeParse({scrollType: 'untilBottom', direction: 'down'}).success, false)
  assert.equal(schema.safeParse({scrollType: 'singleAction', direction: 'down', distance: 301}).success, false)
  assert.equal(schema.safeParse({scrollType: 'singleAction', direction: 'down', distance: 200}).success, true)
})
