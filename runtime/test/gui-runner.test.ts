import assert from 'node:assert/strict'
import {test} from 'node:test'
import {runGui} from '../src/executors/gui-runner.js'

const config = {baseUrl: 'http://127.0.0.1:1/v1', model: 'scripted', modelFamily: 'auto-glm',
  apiKey: 'local', maxSteps: 3, budgetMs: 1000, settleMs: 0}
const device = {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
  screenshotBase64: (): Promise<string> => {assert.fail('must not capture')}, actionSpace: () => []}

test('shared GUI runner refuses pre-cancelled runs before capturing or requesting a model', async () => {
  assert.equal(await runGui('tap', device, {...config, signal: AbortSignal.abort(), context: '',
    planning: () => assert.fail('must not plan'), progress: () => undefined, steps: () => 0}), 'cancelled')
})

test('shared GUI runner rejects unverified model families before capturing', async () => {
  assert.equal(await runGui('tap', device, {...config, modelFamily: 'unverified', signal: new AbortController().signal,
    context: '', planning: () => assert.fail('must not plan'), progress: () => undefined, steps: () => 0}), 'invalid_configuration')
})

test('shared planner scales 2x screenshots once and reports Finished without verification', async t => {
  const {createServer} = await import('node:http')
  const {default: sharp} = await import('sharp')
  const {z} = await import('@midscene/core')
  const {actionTapParamSchema} = await import('@midscene/core/device')
  const {guardComputerDevice} = await import('../src/executors/computer-device.js')
  const png = await sharp({create: {width: 400, height: 600, channels: 3, background: 'white'}}).png().toBuffer()
  let requests = 0, taps = 0
  const server = createServer((req, res) => {void (async () => {
    let body = ''; for await (const part of req) body += String(part)
    assert.match(body, /image_url/u)
    requests++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({choices: [{index: 0, message: {role: 'assistant',
      content: requests === 1 ? 'do(action="Tap", element=[500,500])' : 'finish(message="done")'}, finish_reason: 'stop'}]}))
  })().catch(error => res.destroy(error as Error))})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {server.closeAllConnections(); server.close()})
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const signal = new AbortController().signal
  const raw = {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
    screenshotBase64: () => Promise.resolve(`data:image/png;base64,${png.toString('base64')}`),
    actionSpace: () => [{name: 'Tap', paramSchema: actionTapParamSchema, call: (params: unknown) => {
      assert.deepEqual(z.object({locate: z.object({center: z.tuple([z.number(), z.number()])})}).parse(params).locate.center, [100, 150]); taps++; return Promise.resolve()
    }}]}
  const guarded = await guardComputerDevice(raw, () => Promise.resolve({displayId: '1', width: 200, height: 300, target: 'fixed-window'}),
    {displayId: '1', signal, maxSteps: 3, budgetMs: 10_000, approve: () => Promise.resolve(true), progress: () => undefined})
  const code = await runGui('tap center', guarded.device, {...config, budgetMs: 10_000, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    signal, context: 'Tap only.', steps: guarded.steps, planning: guarded.planning, progress: () => undefined})
  assert.equal(code, 'model_finished')
  assert.equal(taps, 1)
  assert.equal(requests, 2)
})

test('AutoGLM Type uses the focused-field schema, without implicit click or clearing', async () => {
  const {startComputerBackend} = await import('../src/executors/computer-backend.js')
  const backend = await startComputerBackend('1', new AbortController().signal)
  try {
    const input = backend.device.actionSpace().find(action => action.name === 'Input')!
    assert.ok(input.paramSchema?.safeParse({value: '中文'}).success)
    assert.equal(input.paramSchema?.safeParse({value: '中文', locate: {center: [100, 150]}}).success, false)
    assert.equal(input.paramSchema?.safeParse({value: '中文', mode: 'clear'}).success, false)
  } finally {await backend.close()}
})

test('fixed SDK Qwen3-VL family is accepted for desktop live validation', async () => {
  const {validGuiConfig} = await import('../src/executors/gui-runner.js')
  assert.equal(validGuiConfig({...config, modelFamily: 'qwen3-vl'}, 'tap'), true)
})

test('Qwen standard planner completion is reported without an AutoGLM Finished action', async t => {
  const {createServer} = await import('node:http')
  const {default: sharp} = await import('sharp')
  const png = await sharp({create: {width: 200, height: 300, channels: 3, background: 'white'}}).png().toBuffer()
  const server = createServer((req, res) => {
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({choices: [{index: 0, message: {role: 'assistant', content: '<complete success="true">done</complete>'}, finish_reason: 'stop'}]}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {server.closeAllConnections(); server.close()})
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const code = await runGui('observe', {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
    screenshotBase64: () => Promise.resolve(`data:image/png;base64,${png.toString('base64')}`),
    actionSpace: () => [{name: 'Tap', call: () => {assert.fail('must not write')}}]},
    {...config, modelFamily: 'qwen3-vl', baseUrl: `http://127.0.0.1:${address.port}/v1`, budgetMs: 10_000,
      signal: new AbortController().signal, context: '', planning: () => undefined, progress: () => undefined, steps: () => 0})
  assert.equal(code, 'model_finished')
})

test('GUI runner obtains a fresh read-only screen observation after model completion', async t => {
  const {createServer} = await import('node:http')
  const {default: sharp} = await import('sharp')
  const png = await sharp({create: {width: 200, height: 300, channels: 3, background: 'white'}}).png().toBuffer()
  let calls = 0, captures = 0, readback = ''
  const server = createServer((req, res) => {req.resume(); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: ++calls === 1 ? '<complete success="true">done</complete>' : '<observation>Confirmation shows Nova</observation><data-json>{"StatementIsTruthy":true}</data-json>'}, finish_reason: 'stop'}]}))})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {server.closeAllConnections(); server.close()})
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const code = await runGui('confirm Nova', {interfaceType: 'computer', size: () => Promise.resolve({width: 200, height: 300}),
    screenshotBase64: () => {captures++; return Promise.resolve(`data:image/png;base64,${png.toString('base64')}`)}, actionSpace: () => []},
    {...config, modelFamily: 'qwen3-vl', budgetMs: 10_000, baseUrl: `http://127.0.0.1:${address.port}/v1`,
      signal: new AbortController().signal, context: '', planning: () => undefined, progress: () => undefined, steps: () => 0,
      capture: value => {readback = value}})
  assert.equal(code, 'model_finished'); assert.match(readback, /^data:image\/png;base64,/u); assert.ok(captures >= 2)
})
