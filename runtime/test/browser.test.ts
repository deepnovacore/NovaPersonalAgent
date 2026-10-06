import assert from 'node:assert/strict'
import {test} from 'node:test'
import {join} from 'node:path'
import {loadBrowserConfig} from '../src/executors/browser.js'
import {validBrowserUrl} from '../src/executors/browser-device.js'

test('browser target is explicit and rejects credentials, nonlocal HTTP and file access', () => {
  assert.equal(validBrowserUrl('https://example.com/path'), true)
  assert.equal(validBrowserUrl('http://127.0.0.1:18765'), true)
  for (const url of ['file:///etc/passwd', 'http://example.com', 'https://user:pass@example.com', 'javascript:alert(1)'])
    assert.equal(validBrowserUrl(url), false)
  assert.throws(() => loadBrowserConfig({}), /invalid_browser_configuration/u)
  assert.throws(() => loadBrowserConfig({BROWSER_ENGINE: 'Safari'}), /invalid_browser_configuration/u)
})

test('browser controller forwards the host task grant and cancels only its matching work', async t => {
  const {BrowserExecutor} = await import('../src/executors/browser.js')
  const {HostApprovalController} = await import('../src/core/approval.js')
  const {RealClock} = await import('../src/core/clock.js')
  const {TaskService} = await import('../src/personal-agent/tasks.js')
  const {mkdtemp, realpath, rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os'); const {randomUUID} = await import('node:crypto')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'browser-grant-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const tasks = new TaskService(join(root, 'tasks.json')); await tasks.open()
  const task = await tasks.delegate('req', {execution_route: 'browser', conversation_id: 'c', goal: 'Confirm', acceptance: [], origin_ref: 'user:1'})
  const grant = tasks.continuationContext({task_id: task.id, control_revision: 0, goal_revision: 0})
  const clock = new RealClock(), approvals = new HostApprovalController({clock, idFactory: randomUUID})
  const executor = new BrowserExecutor({...loadBrowserConfig({BROWSER_URL: 'http://127.0.0.1', BROWSER_BASE_URL: 'http://127.0.0.1/v1', BROWSER_API_KEY: 'local', BROWSER_MODEL: 'test', BROWSER_MODEL_FAMILY: 'qwen3-vl'}), lockRoot: root}, approvals,
    (_config, _instruction, options) => new Promise(resolve => {options.signal.addEventListener('abort', () => resolve({code: 'cancelled', steps: 0}), {once: true})}))
  t.after(() => executor.close())
  let request: Readonly<Record<string, unknown>> = {}, forwarded: unknown
  const controller = executor.controller({dispatch: value => {request = value.request; forwarded = value.taskContext; return {accepted: true, delegate_id: 'work'}}})
  const user = {taskContext: grant, instruction: 'Confirm', originalUserText: 'Confirm', origin_ref: grant.origin_ref, sessionEpoch: 1, acceptedUserInputRevision: 0, stillWanted: grant.stillWanted}
  await controller.dispatch(user); assert.equal(forwarded, grant)
  const running = executor.dispatch('run', request, {clock, signal: new AbortController().signal, progress: () => undefined,
    delegate: {delegate_id: 'work', executor: 'browser', op: 'run', request: {}, origin_ref: grant.origin_ref, dispatched_at: clock.now(), deadline: clock.now() + 3, routing_class: 'user_awaited'}})
  executor.cancelWork('different-work')
  executor.cancelWork('work')
  assert.equal((await running).outcome, 'cancelled')
})
