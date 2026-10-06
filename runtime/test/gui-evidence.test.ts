import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, rm, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {TaskService} from '../src/personal-agent/tasks.js'
import {rememberGuiFrame, resolveGuiFrame} from '../src/executors/gui-evidence.js'
import type {CompleteRequest} from '../src/model/model-gateway.js'
import {GatewayTaskVerifier} from '../src/model/task-verifier.js'

test('work target cannot change, and GUI completion requires the matching work/session/target observation', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-gui-evidence-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const tasks = new TaskService(join(root, 'tasks.json')); await tasks.open()
  const task = await tasks.delegate('request', {conversation_id: 'c', execution_route: 'browser', goal: 'Confirm Nova', acceptance: ['Confirmed Nova is visible'], origin_ref: 'user:1'})
  const fence = {task_id: task.id, control_revision: 0, goal_revision: 0}
  await tasks.bindWork(fence, 'work', 'session', true, 'browser:page-a')
  await assert.rejects(() => tasks.bindWork(fence, 'work', 'session', true, 'browser:page-b'), /work_target_conflict/u)
  const decide = async () => {
    const base = {ref: 'test', task_id: task.id, goal_revision: 0, kind: 'work' as const, work_id: 'work', outcome: 'ok', content: '{}', refs: [], observations: tasks.events(task.id, 0).items.filter(event => event.kind === 'tool'), observations_truncated: false}
    const evidence = [base], ref = base.ref
    const gateway = {stream: async function* () {yield await Promise.resolve({kind: 'text' as const, text: ''})}, complete: (request: CompleteRequest) => {if (base.observations.some(event => (JSON.parse(event.text) as {target?: unknown}).target === 'browser:page-a')) assert.equal(request.images?.length, 1); return Promise.resolve({text: JSON.stringify({kind: 'complete', evidence_refs: [request.images?.[0]?.ref ?? ref], criteria: [{index: 0, evidence_refs: [request.images?.[0]?.ref ?? ref]}]})})}}
    return (await new GatewayTaskVerifier({gateway, model: 'test'}).evaluateTask(tasks.get(task.id), evidence, new AbortController().signal)).kind
  }
  assert.equal(await decide(), 'wait')
  const imageRef = rememberGuiFrame('data:image/png;base64,iVBORw0KGgo=', {work: 'work', session: 'session', target: 'browser:page-a'})
  assert.equal(resolveGuiFrame(imageRef, {work: 'other', session: 'session', target: 'browser:page-a'}), undefined)
  for (const [index, target] of ['browser:page-b', 'browser:page-a'].entries()) {
    await tasks.appendEvent({task_id: task.id, work_id: 'work', session_id: 'session', thread_id: 'session', turn_id: 'turn', item_id: String(index), stage: 'completed', kind: 'tool', refs: [],
      text: JSON.stringify({type: 'guiObservation', status: 'completed', target, steps: 0, image_ref: imageRef, visible_state_matches: true, readback: 'Confirmed Nova is visible'})}, String(index))
    assert.equal(await decide(), index === 0 ? 'wait' : 'complete')
  }
})

test('iOS JPEG evidence keeps its media type and rejects a forged signature', () => {
  const binding = {work: 'jpeg-work', session: 'jpeg-session', target: 'ios:device'}
  const ref = rememberGuiFrame('data:image/jpeg;base64,/9j/2Q==', binding)
  assert.equal(resolveGuiFrame(ref, binding)?.media_type, 'image/jpeg')
  assert.throws(() => rememberGuiFrame('data:image/jpeg;base64,iVBORw0KGgo=', binding), /invalid_gui_frame/u)
})

test('a long GUI run preserves early confirmation and final readback', () => {
  const binding = {work: 'long-work', session: 'long-session', target: 'browser:long'}
  const refs = Array.from({length: 12}, () => rememberGuiFrame('data:image/png;base64,iVBORw0KGgo=', binding))
  assert.ok(resolveGuiFrame(refs[2]!, binding))
  assert.equal(resolveGuiFrame(refs[4]!, binding), undefined)
  assert.ok(resolveGuiFrame(refs[11]!, binding))
})
