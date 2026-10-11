import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp, rm, stat, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {HostApprovalController} from '../src/core/approval.js'
import {RealClock} from '../src/core/clock.js'
import type {ExecutorDispatchContext} from '../src/core/causal-runtime.js'
import type {AgentRuntimeDispatchPort} from '../src/executors/agent-controller.js'
import {ComputerExecutor, loadComputerConfig} from '../src/executors/computer.js'
import type {runComputer as RunComputer} from '../src/executors/computer.js'
import {deviceLockPath} from '../src/executors/device-lock.js'

const env = {COMPUTER_DISPLAY_ID: '1', COMPUTER_BASE_URL: 'http://127.0.0.1:8000/v1', COMPUTER_MODEL: 'scripted',
  COMPUTER_MODEL_FAMILY: 'auto-glm', COMPUTER_API_KEY: 'local'}
const user = {instruction: 'tap center', originalUserText: 'tap center', origin_ref: 'conversation:1',
  sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true}

test('computer configuration requires an explicit display and a verified model family', () => {
  assert.equal(loadComputerConfig(env).displayId, '1')
  for (const invalid of [{COMPUTER_DISPLAY_ID: ''}, {COMPUTER_MODEL_FAMILY: 'unverified'},
    {COMPUTER_BASE_URL: 'http://remote.example'}, {COMPUTER_MAX_STEPS: 'NaN'}, {COMPUTER_CLICK_HOLD_MS: '0'}, {COMPUTER_CLICK_HOLD_MS: '1001'}]) assert.throws(() => loadComputerConfig({...env, ...invalid}))
})

for (const code of ['model_finished', 'declined', 'screen_changed'] as const) test(`GUI handoff never claims completion or no start after effects: ${code}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-gui-outcome-'))
  const clock = new RealClock()
  const executor = new ComputerExecutor({...loadComputerConfig(env), lockRoot: root},
    new HostApprovalController({clock, idFactory: randomUUID}), () => Promise.resolve({code, steps: 1}))
  t.after(async () => {await executor.close(); await rm(root, {recursive: true, force: true})})
  let request: Readonly<Record<string, unknown>> = {}
  await executor.controller({dispatch: value => {request = value.request; return {accepted: true, delegate_id: 'result'}}}).dispatch(user)
  const result = await executor.dispatch('run', request, {clock, signal: new AbortController().signal, progress: () => undefined,
    delegate: {delegate_id: 'result', executor: 'computer', op: 'run', request: {}, origin_ref: 'conversation:1',
      deadline: clock.now() + 5, dispatched_at: clock.now(), routing_class: 'user_awaited'}})
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.content.verified, false)
})

for (const scenario of ['decline', 'cancel', 'unknown'] as const) test(`computer controller/host lifecycle: ${scenario}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-computer-'))
  const config = {...loadComputerConfig(env), lockRoot: root}
  const clock = new RealClock()
  const approvals = new HostApprovalController({clock, idFactory: randomUUID})
  let sent = 0
  const executor = new ComputerExecutor(config, approvals, async (_config, _instruction, hooks) => {
    if (!await hooks.approve('Tap', {x: 100, y: 150})) return {code: 'declined', steps: 0}
    sent++
    return {code: 'cleanup_unknown', steps: 1}
  })
  t.after(async () => {await executor.close(); await rm(root, {recursive: true, force: true})})
  const captured: Parameters<AgentRuntimeDispatchPort['dispatch']>[0][] = []
  const controller = executor.controller({dispatch: request => {captured.push(request); return {accepted: true, delegate_id: 'computer-1'}}})
  assert.equal((await controller.dispatch(user)).code, 'delegated')
  assert.equal(captured[0]!.channel, 'computer')
  assert.equal(executor.manifest.model_visibility, 'hidden')
  const context: ExecutorDispatchContext = {clock, signal: new AbortController().signal, progress: () => undefined,
    delegate: {delegate_id: 'computer-1', executor: 'computer', op: 'run', request: {}, origin_ref: 'conversation:1',
      deadline: clock.now() + 5, dispatched_at: clock.now(), routing_class: 'user_awaited'}}
  const active = executor.dispatch('run', captured[0]!.request, context)
  for (let i = 0; i < 100 && !approvals.pending; i++) await delay(5)
  assert.equal(approvals.view.executorIdentity?.executor, 'computer')
  assert.equal((await controller.dispatch(user)).code, 'busy')
  const cancellation = scenario === 'cancel' ? controller.cancel(user) : undefined
  if (scenario !== 'cancel') approvals.acceptDecision({approvalId: approvals.view.pending_approval_id!, decision: scenario === 'decline' ? 'decline' : 'accept'})
  const result = await active
  await cancellation
  assert.equal(result.content.verified, false)
  assert.equal(result.content.code, scenario === 'unknown' ? 'cleanup_unknown' : scenario === 'cancel' ? 'cancelled' : 'declined')
  assert.equal(sent, scenario === 'unknown' ? 1 : 0)
  if (scenario === 'unknown') {
    assert.equal((await stat(deviceLockPath(root, 'desktop', 'local-input'))).isDirectory(), true)
    const contender = new ComputerExecutor({...config, displayId: '2'}, approvals, () => {assert.fail('must remain quarantined')})
    t.after(() => contender.close())
    let request: Readonly<Record<string, unknown>> = {}
    await contender.controller({dispatch: value => {request = value.request; return {accepted: true, delegate_id: 'second'}}}).dispatch(user)
    assert.equal((await contender.dispatch('run', request, context)).content.code, 'device_busy')
  }
})

test('background Safari binds explicit PID and window ID together, never silently ignores half a target', () => {
  if (process.platform !== 'darwin') {
    assert.throws(() => loadComputerConfig({...env, COMPUTER_MAC_WINDOW_PID: '12345', COMPUTER_MAC_WINDOW_ID: '678'}), /invalid_computer_configuration/u)
    return
  }
  const configured = loadComputerConfig({...env, COMPUTER_MAC_WINDOW_PID: '12345', COMPUTER_MAC_WINDOW_ID: '678'})
  assert.deepEqual((configured as unknown as {macWindow?: unknown}).macWindow, {pid: 12345, windowId: 678})
  for (const target of [
    {COMPUTER_MAC_WINDOW_PID: '12345'}, {COMPUTER_MAC_WINDOW_ID: '678'},
    {COMPUTER_MAC_WINDOW_PID: '0', COMPUTER_MAC_WINDOW_ID: '678'},
    {COMPUTER_MAC_WINDOW_PID: '12345', COMPUTER_MAC_WINDOW_ID: '1;open'},
  ]) assert.throws(() => loadComputerConfig({...env, ...target}), /invalid_computer_configuration/u)
})

test('blank optional window settings preserve the existing display mode', () => {
  const configured = loadComputerConfig({...env, COMPUTER_MAC_WINDOW_PID: '', COMPUTER_MAC_WINDOW_ID: ''})
  assert.equal(configured.macWindow, undefined)
})

test('Connect never moves the pointer after approved task authority expires', {skip: !['darwin', 'win32'].includes(process.platform)}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-connect-fence-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const backendUrl = pathToFileURL(join(root, 'backend.mjs')).href
  const deviceUrl = pathToFileURL(join(root, 'device.mjs')).href
  const realDevice = new URL('../src/executors/computer-device.js', import.meta.url).href
  await writeFile(join(root, 'backend.mjs'), `export let connects=0, closes=0;export async function startComputerBackend(){return {pid:1,listDisplays:async()=>[{id:'1'}],connect:async()=>{connects++},close:async()=>{closes++;return true},device:{size:async()=>({width:800,height:600})}}}`)
  await writeFile(join(root, 'device.mjs'), `export {guardComputerDevice,guiApproval,validComputerDisplayId} from ${JSON.stringify(realDevice)};export async function computerForeground(){return {target:'fixture',width:800,height:600}}`)
  const sourceUrl = new URL('../src/executors/computer.js', import.meta.url)
  const source = (await readFile(sourceUrl, 'utf8')).replace(/from ['"](\.\.?\/[^'"]+)['"]/gu, (_match, path: string) => `from ${JSON.stringify(path === './computer-backend.js' ? backendUrl : path === './computer-device.js' ? deviceUrl : new URL(path, sourceUrl).href)}`)
  await writeFile(join(root, 'computer.mjs'), source)
  const {runComputer} = await import(pathToFileURL(join(root, 'computer.mjs')).href) as {runComputer: typeof RunComputer}
  let checked = 0
  await runComputer(loadComputerConfig(env), 'tap center', {signal: new AbortController().signal, approve: () => Promise.resolve(true), progress: () => undefined, beforeWrite: () => {checked++; throw Error('superseded')}})
  const backend = await import(backendUrl) as {connects: number; closes: number}
  assert.equal(checked, 1)
  assert.equal(backend.connects, 0)
  assert.equal(backend.closes, 1)
})
