import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import type { JsonValue } from '../src/events.js'
import { Memory } from '../src/memory.js'
import { executorManifestSchema } from '../src/ports.js'
import {
ProjectConfirmationController
} from '../src/project-confirmation.js'
import {
RealtimeRuntimeBridge
} from '../src/realtime/bridge.js'
import type { ResponseOrigin } from '../src/realtime/protocol.js'
import { ItemDeliveryUncertainError } from '../src/realtime/protocol.js'
import { RealtimeService } from '../src/realtime/service.js'
import type { RealtimeSession } from '../src/realtime/session.js'
import { compileToolSchema } from '../src/tool-schema.js'
import { beginExecutorApprovalCarrier,confirmationTurn,emitExecutorApprovalFunction,emptyStream,endExecutorApprovalSpeech,finishExecutorApprovalQuestion,finishProviderResponse,guardFact,hostFact,offerCodexCommand,propose,realtimeServiceHarness,reserveConfirmationTurn,speak,toldAboutConfirmation,unsubscribeNothing } from './realtime-service-harness.js'

test('a Codex approval prompt is a neutral host fact with no local command detail', async () => {
  const {service, executorApproval} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const prompt = service.queuedHostItems().find(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  ))?.intent.item.content
  assert.notEqual(prompt, undefined)
  // Spec 08: a prose host fact naming the id, the neutral summary and the one tool that answers it.
  assert.equal(
    prompt,
    `权限请求 id=${approvalId}：Codex 请求批准 command_execution：Codex 请求执行一条工作区命令。`
      + '只有用户本轮明确同意或拒绝后才调用 confirm(id, accepted)；不要朗读 id。',
  )
  assert.doesNotMatch(prompt, /Remove-Item|raw-command|raw-cwd|private|codex__/u)

  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('an approval prompt names the project and session title of the work it belongs to', async () => {
  const {service, executorApproval} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = executorApproval.offer({
    kind: 'command_execution',
    local_detail: {kind: 'command_execution', command: 'npm test', cwd: '/blog'},
    operation_summary: 'Codex 请求执行一条工作区命令。',
  }, new AbortController().signal, {work_id: 'w-1', project: 'blog', title: '暗色模式'})
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const prompt = service.queuedHostItems().find(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  ))?.intent.item.content
  assert.match(prompt ?? '', /^权限请求 id=.*：项目 blog · 会话 暗色模式 请求批准 command_execution：/u)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex approval confirms provider context before it queues the audible question', async () => {
  let releaseContext!: () => void
  const contextGate = new Promise<void>(resolve => { releaseContext = resolve })
  let signalContextStarted!: () => void
  const contextStarted = new Promise<void>(resolve => { signalContextStarted = resolve })
  const {service, executorApproval, actions, telemetry} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (!item.event_id.startsWith('approval:')) return Promise.resolve()
      signalContextStarted()
      return contextGate
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.ok(
    actions.includes(`inject:approval:${approvalId}:requested`),
    'context injection starts without waiting for the audible delivery queue',
  )
  await contextStarted

  assert.deepEqual(actions.filter(action => action.startsWith('inject:approval:')), [
    `inject:approval:${approvalId}:requested`,
  ])
  assert.equal(actions.some(action => action.startsWith('create_response:')), false)
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  )), false, 'the question is not eligible before exact context confirmation')

  releaseContext()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(
    telemetry.filter(record => record.kind === 'approval.context'),
    [{kind: 'approval.context', payload: {session_epoch: 1, outcome: 'ready'}}],
  )
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  )), true)
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === `inject:approval:${approvalId}:requested`).length,
    1,
    'audible delivery reuses the already-injected context item',
  )
  assert.equal(actions.filter(action => action === 'create_response:host_fact').length, 1)

  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('unconfirmed Codex approval context disables voice and releases one existing semantic acknowledgement', async t => {
  for (const outcome of ['false', 'rejected', 'uncertain'] as const) {
    await t.test(outcome, async () => {
      let settleContext!: () => void
      let rejectContext!: (cause: Error) => void
      let signalContextStarted!: () => void
      const contextStarted = new Promise<void>(resolve => { signalContextStarted = resolve })
      const contextGate = new Promise<boolean>((resolve, reject) => {
        settleContext = () => { resolve(false) }
        rejectContext = reject
      })
      const {service, executorApproval, actions, session, telemetry} = realtimeServiceHarness('pipeline', {
        projectTool: true,
        withExecutorApproval: true,
      })
      assert.ok(executorApproval !== null)
      let contextAttempts = 0
      session.injectHostContext = () => {
        contextAttempts += 1
        signalContextStarted()
        return contextGate
      }
      await service.connect()
      service.queueHostItem(hostFact(`background:context-${outcome}`), {
        priority: 50,
        semanticEventId: `background:context-${outcome}`,
      })

      const waiting = offerCodexCommand(executorApproval)
      const approvalId = executorApproval.view.pending_approval_id!
      await contextStarted
      await service.flushHostItems()
      assert.equal(
        actions.includes(`inject:background:context-${outcome}`),
        false,
        'the pending context lifecycle initially owns the foreground',
      )

      if (outcome === 'false') {
        settleContext()
      } else if (outcome === 'uncertain') {
        rejectContext(new ItemDeliveryUncertainError({
          session_epoch: 1,
          host_item_id: 'uncertain-context-host',
          provider_item_id: 'uncertain-context-provider',
          item_kind: 'final',
        }))
      } else {
        rejectContext(new Error('definite context injection failure'))
      }
      await new Promise<void>(resolve => { setImmediate(resolve) })
      assert.deepEqual(
        telemetry.filter(record => record.kind === 'approval.context'),
        [{
          kind: 'approval.context',
          payload: {session_epoch: 1, outcome: 'failed'},
        }],
      )
      await new Promise<void>(resolve => { setImmediate(resolve) })

      assert.equal(executorApproval.pending, true, 'renderer authority remains clickable')
      assert.equal(contextAttempts, 1, 'a failed or uncertain context injection is never retried')
      assert.equal(service.queuedHostItems().some(item => (
        item.intent.item.event_id.startsWith(`approval:${approvalId}:`)
      )), false, 'no audible approval question survives the failed context')
      assert.equal(actions.some(action => action.startsWith('create_response:')), false)

      await service.flushHostItems()
      await service.flushHostItems()
      assert.equal(
        actions.filter(action => action === `inject:background:context-${outcome}`).length,
        1,
        'the existing semantic acknowledgement is released exactly once',
      )
      assert.equal(service.executorApprovalDecision(approvalId, false), true)
      assert.deepEqual(await waiting, {decision: 'decline'})
      assert.deepEqual(
        telemetry.filter(record => record.kind === 'approval.decision'),
        [{
          kind: 'approval.decision',
          payload: {session_epoch: 1, source: 'renderer', outcome: 'refused'},
        }],
      )
    })
  }
})

test('a click that wins context injection prevents a late Codex question and retires its context', async () => {
  let releaseContext!: () => void
  const contextGate = new Promise<void>(resolve => { releaseContext = resolve })
  let signalContextStarted!: () => void
  const contextStarted = new Promise<void>(resolve => { signalContextStarted = resolve })
  const {service, executorApproval, actions, telemetry} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (!item.event_id.startsWith('approval:')) return Promise.resolve()
      signalContextStarted()
      return contextGate
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.ok(actions.includes(`inject:approval:${approvalId}:requested`))
  await contextStarted
  assert.equal(service.executorApprovalDecision(approvalId, true), true)
  assert.deepEqual(await waiting, {decision: 'accept'})

  releaseContext()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(
    telemetry.filter(record => record.kind === 'approval.context'),
    [{kind: 'approval.context', payload: {session_epoch: 1, outcome: 'stale'}}],
  )
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id.startsWith(`approval:${approvalId}:`)
  )), false)
  assert.equal(actions.some(action => action.startsWith('create_response:')), false)
  assert.equal(
    actions.filter(action => (
      action === `retire:provider:approval:${approvalId}:requested`
    )).length,
    1,
  )
})

test('expiry during Codex context injection prevents late voice authority and question', async () => {
  let releaseContext!: () => void
  const contextGate = new Promise<void>(resolve => { releaseContext = resolve })
  let signalContextStarted!: () => void
  const contextStarted = new Promise<void>(resolve => { signalContextStarted = resolve })
  const {service, executorApproval, actions, clock} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (!item.event_id.startsWith('approval:')) return Promise.resolve()
      signalContextStarted()
      return contextGate
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await contextStarted

  clock.advanceTo(executorApproval.view.expires_at!)
  assert.deepEqual(await waiting, {decision: 'decline'})
  releaseContext()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id.startsWith(`approval:${approvalId}:`)
  )), false)
  assert.equal(actions.some(action => action.startsWith('create_response:')), false)
  assert.equal(
    actions.filter(action => (
      action === `retire:provider:approval:${approvalId}:requested`
    )).length,
    1,
  )
})

test('pre-context speech cannot authorize retroactively and gets one host clarification', async () => {
  let releaseContext!: () => void
  const contextGate = new Promise<void>(resolve => { releaseContext = resolve })
  let signalContextStarted!: () => void
  const contextStarted = new Promise<void>(resolve => { signalContextStarted = resolve })
  const {service, executorApproval, injectedItems, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (!item.event_id.startsWith('approval:')) return Promise.resolve()
      signalContextStarted()
      return contextGate
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.ok(actions.includes(`inject:approval:${approvalId}:requested`))
  await contextStarted

  await service.localSpeechOnset('pre-context-local')
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'pre-context-provider', provider_item_id: 'pre-context-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'pre-context-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'pre-context-response', callId: 'pre-context-call',
  })
  assert.equal(executorApproval.pending, true)
  assert.match(
    injectedItems.find(item => item.kind === 'tool_output' && item.call_id === 'pre-context-call')
      ?.content ?? '',
    /"code":"approval_not_authorized"/u,
  )
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'pre-context-provider', provider_item_id: 'pre-context-item',
  })
  await finishProviderResponse(service, 'pre-context-response')

  releaseContext()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const clarifications = service.queuedHostItems().filter(item => (
    item.intent.item.event_id === `approval:${approvalId}:clarification`
  ))
  assert.equal(clarifications.length, 1)
  assert.equal(clarifications[0]?.intent.item.content, '请明确说同意或拒绝。')

  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('post-context onset removes only the question and keeps the exact function authority', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  )), true)

  await service.localSpeechOnset('post-context-local')
  await beginExecutorApprovalCarrier(service, {
    itemId: 'post-context-item', responseId: 'post-context-response',
  })
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id === `approval:${approvalId}:requested`
  )), false)
  assert.equal(
    actions.includes(`retire:provider:approval:${approvalId}:requested`),
    false,
  )
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'post-context-response',
  })
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('a Codex approval prompt preempts an active response instead of waiting for user speech', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'response-before-approval',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1, response_id: 'response-before-approval',
    pcm: new Uint8Array([0, 1]),
  })

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()

  assert.ok(
    actions.includes('cancel:response-before-approval'),
    'the approval question owns the next audible turn without waiting for the user to barge in',
  )
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-before-approval',
    status: 'cancelled', reason: 'approval prompt preempted it',
  })
  await service.flushHostItems()
  assert.ok(
    actions.includes(`inject:approval:${approvalId}:requested`),
    'the approval prompt is delivered as soon as the interrupted turn releases the floor',
  )

  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('settling a Codex approval during preemption retires its unsaid prompt', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'response-before-fast-decision',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1, response_id: 'response-before-fast-decision',
    pcm: new Uint8Array([0, 1]),
  })

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()
  assert.ok(actions.includes('cancel:response-before-fast-decision'))

  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-before-fast-decision',
    status: 'cancelled', reason: 'approval was already settled',
  })
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === `inject:approval:${approvalId}:requested`).length,
    1,
    'the context-only fact was confirmed before the click',
  )
  assert.equal(
    actions.filter(action => action === 'create_response:host_fact').length,
    0,
    'an approval question cannot speak after the banner decision consumed its authority',
  )
  assert.equal(
    actions.filter(action => (
      action === `retire:provider:approval:${approvalId}:requested`
    )).length,
    1,
  )
})

test('Codex approval user onset stops exact question audio but retains provider context', async () => {
  const {service, executorApproval, actions, session} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'audible-approval-response',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'audible-approval-response', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(service.playbackStarted(generation!.utterance_id, generation!.generation_epoch), true)

  await service.localSpeechOnset('renderer-local-answer')
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.ok(actions.includes('cancel:audible-approval-response'))
  assert.equal(
    actions.includes(`retire:provider:approval:${approvalId}:requested`),
    false,
    'speech onset preserves the provider fact that carries the opaque approval ID',
  )
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.filter(action => (
      action === `retire:provider:approval:${approvalId}:requested`
    )).length,
    1,
    'actual settlement retires provider context exactly once',
  )
})

test('a pending Codex approval keeps its startup acknowledgement out of the user answer turn', async () => {
  const {service, executorApproval, actions, session} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()
  assert.ok(actions.includes(`inject:approval:${approvalId}:requested`))
  const backgroundInjectionsBefore = actions
    .filter(action => action === 'inject:background:d-1').length

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'audible-approval-before-answer',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'audible-approval-before-answer', pcm: new Uint8Array([0, 1]),
  })
  const approvalGeneration = session.currentGeneration
  assert.notEqual(approvalGeneration, null)
  assert.equal(
    service.playbackStarted(approvalGeneration!.utterance_id, approvalGeneration!.generation_epoch),
    true,
  )
  service.queueHostItem(hostFact('background:d-1'), {
    priority: 50,
    semanticEventId: 'background:d-1',
  })
  await service.localSpeechOnset('approval-answer-onset')
  assert.equal(
    service.playbackCleared(
      approvalGeneration!.utterance_id,
      approvalGeneration!.generation_epoch,
      0,
    ),
    true,
  )
  await finishProviderResponse(service, 'audible-approval-before-answer')
  await service.flushHostItems()

  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    backgroundInjectionsBefore,
    'the generic startup acknowledgement cannot open a competing response while approval is pending',
  )
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    backgroundInjectionsBefore + 1,
    'settlement releases rather than drops the delayed acknowledgement',
  )
})

test('a Codex function settlement releases one existing task acknowledgement exactly once', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  service.queueHostItem(hostFact('background:function-release'), {
    priority: 50,
    semanticEventId: 'background:function-release',
  })

  await beginExecutorApprovalCarrier(service, {
    itemId: 'function-release-item', responseId: 'function-release-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'function-release-response',
  })
  await finishProviderResponse(service, 'function-release-response')
  await service.flushHostItems()
  assert.deepEqual(await waiting, {decision: 'accept'})
  assert.equal(
    actions.filter(action => action === 'inject:background:function-release').length,
    1,
  )
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'function-release-response',
    callId: 'function-release-duplicate',
  })
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === 'inject:background:function-release').length,
    1,
  )
})

test('Codex approval telemetry is closed, privacy-safe, and records function versus renderer races', async () => {
  const {service, executorApproval, telemetry} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })

  await beginExecutorApprovalCarrier(service, {
    itemId: 'private-approval-item', responseId: 'private-approval-response',
  })
  assert.equal(service.executorApprovalDecision(approvalId, true), true)
  assert.deepEqual(await waiting, {decision: 'accept'})
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'private-approval-response',
    callId: 'private-losing-call',
  })

  const records = telemetry.filter(record => record.kind.startsWith('approval.'))
  assert.deepEqual(records.filter(record => record.kind === 'approval.context'), [{
    kind: 'approval.context', payload: {session_epoch: 1, outcome: 'ready'},
  }])
  assert.deepEqual(records.filter(record => record.kind === 'approval.attempt'), [{
    kind: 'approval.attempt', payload: {session_epoch: 1, attempt: 1, action: 'begun'},
  }])
  assert.deepEqual(records.filter(record => record.kind === 'approval.carrier'), [{
    kind: 'approval.carrier', payload: {session_epoch: 1, attempt: 1, action: 'bound'},
  }])
  assert.deepEqual(records.filter(record => record.kind === 'approval.decision'), [
    {
      kind: 'approval.decision',
      payload: {session_epoch: 1, source: 'renderer', outcome: 'accepted'},
    },
    {
      kind: 'approval.decision',
      payload: {
        session_epoch: 1, source: 'function', outcome: 'refused', reason: 'not_pending',
      },
    },
  ])
  const serialized = JSON.stringify(records)
  for (const sensitive of [
    approvalId, 'private-approval-item', 'private-approval-response', 'private-losing-call',
  ]) assert.equal(serialized.includes(sensitive), false)
})

test('Codex approval telemetry records bounded retry exhaustion without sensitive carrier values', async () => {
  const {service, executorApproval, telemetry} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await finishExecutorApprovalQuestion(service, 'private-question-response')

  await beginExecutorApprovalCarrier(service, {
    itemId: 'private-attempt-one-item', responseId: 'private-attempt-one-source',
  })
  await finishProviderResponse(service, 'private-attempt-one-source')
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'private-attempt-one-retry',
  })
  await finishProviderResponse(service, 'private-attempt-one-retry')
  await service.flushHostItems()
  await finishProviderResponse(service, 'private-host-clarification')

  await beginExecutorApprovalCarrier(service, {
    itemId: 'private-attempt-two-item', responseId: 'private-attempt-two-source',
  })
  await finishProviderResponse(service, 'private-attempt-two-source')
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'private-attempt-two-retry',
  })
  await finishProviderResponse(service, 'private-attempt-two-retry')

  assert.equal(executorApproval.pending, true)
  assert.deepEqual(
    telemetry.filter(record => record.kind === 'approval.attempt'),
    [
      {kind: 'approval.attempt', payload: {session_epoch: 1, attempt: 1, action: 'begun'}},
      {kind: 'approval.attempt', payload: {session_epoch: 1, attempt: 1, action: 'exhausted'}},
      {kind: 'approval.attempt', payload: {session_epoch: 1, attempt: 2, action: 'rotated'}},
      {kind: 'approval.attempt', payload: {session_epoch: 1, attempt: 2, action: 'exhausted'}},
    ],
  )
  assert.deepEqual(
    telemetry.filter(record => record.kind === 'approval.carrier').map(record => record.payload),
    [
      {session_epoch: 1, attempt: 1, action: 'bound'},
      {session_epoch: 1, attempt: 1, action: 'terminal'},
      {session_epoch: 1, attempt: 1, action: 'retry_requested'},
      {session_epoch: 1, attempt: 1, action: 'bound'},
      {session_epoch: 1, attempt: 1, action: 'terminal'},
      {session_epoch: 1, attempt: 2, action: 'bound'},
      {session_epoch: 1, attempt: 2, action: 'terminal'},
      {session_epoch: 1, attempt: 2, action: 'retry_requested'},
      {session_epoch: 1, attempt: 2, action: 'bound'},
      {session_epoch: 1, attempt: 2, action: 'terminal'},
    ],
  )
  const serialized = JSON.stringify(telemetry.filter(record => (
    record.kind.startsWith('approval.')
  )))
  for (const sensitive of [approvalId, 'private-attempt', 'private-host']) {
    assert.equal(serialized.includes(sensitive), false)
  }
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex approval telemetry classifies exact-deadline renderer and function decisions as expired', async t => {
  await t.test('renderer', async () => {
    const {service, executorApproval, clock, telemetry} = realtimeServiceHarness('pipeline', {
      projectTool: true, withExecutorApproval: true,
    })
    assert.ok(executorApproval !== null)
    await service.connect()
    const waiting = offerCodexCommand(executorApproval)
    const approvalId = executorApproval.view.pending_approval_id!
    const expiresAt = executorApproval.view.expires_at!
    await new Promise<void>(resolve => { setImmediate(resolve) })

    clock.advanceTo(expiresAt)
    assert.deepEqual(await waiting, {decision: 'decline'})
    assert.equal(service.executorApprovalDecision(approvalId, true), false)
    assert.deepEqual(
      telemetry.filter(record => record.kind === 'approval.decision'),
      [{
        kind: 'approval.decision',
        payload: {
          session_epoch: 1, source: 'renderer', outcome: 'refused', reason: 'expired',
        },
      }],
    )
  })

  await t.test('function', async () => {
    const {service, executorApproval, clock, telemetry} = realtimeServiceHarness('pipeline', {
      projectTool: true, withExecutorApproval: true,
    })
    assert.ok(executorApproval !== null)
    await service.connect()
    const waiting = offerCodexCommand(executorApproval)
    const approvalId = executorApproval.view.pending_approval_id!
    const expiresAt = executorApproval.view.expires_at!
    await new Promise<void>(resolve => { setImmediate(resolve) })
    await beginExecutorApprovalCarrier(service, {
      itemId: 'expired-private-item', responseId: 'expired-private-response',
    })

    clock.advanceTo(expiresAt)
    assert.deepEqual(await waiting, {decision: 'decline'})
    await emitExecutorApprovalFunction(service, {
      approvalId,
      approved: true,
      responseId: 'expired-private-response',
      callId: 'expired-private-call',
    })
    assert.deepEqual(
      telemetry.filter(record => record.kind === 'approval.decision'),
      [{
        kind: 'approval.decision',
        payload: {
          session_epoch: 1, source: 'function', outcome: 'refused', reason: 'expired',
        },
      }],
    )
    const serialized = JSON.stringify(telemetry.filter(record => (
      record.kind.startsWith('approval.')
    )))
    for (const sensitive of [approvalId, 'expired-private-item', 'expired-private-response']) {
      assert.equal(serialized.includes(sensitive), false)
    }
  })
})

test('Codex approval telemetry preserves exact-deadline expiry after context failure disables voice', async t => {
  await t.test('renderer', async () => {
    const {service, executorApproval, clock, telemetry, session} = realtimeServiceHarness('pipeline', {
      projectTool: true, withExecutorApproval: true,
    })
    assert.ok(executorApproval !== null)
    session.injectHostContext = () => Promise.resolve(false)
    await service.connect()
    const waiting = offerCodexCommand(executorApproval)
    const approvalId = executorApproval.view.pending_approval_id!
    const expiresAt = executorApproval.view.expires_at!
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(executorApproval.pending, true, 'context failure leaves renderer authority pending')

    clock.advanceTo(expiresAt)
    assert.deepEqual(await waiting, {decision: 'decline'})
    assert.equal(service.executorApprovalDecision(approvalId, true), false)
    assert.deepEqual(
      telemetry.filter(record => record.kind === 'approval.decision'),
      [{
        kind: 'approval.decision',
        payload: {
          session_epoch: 1, source: 'renderer', outcome: 'refused', reason: 'expired',
        },
      }],
    )
  })

  await t.test('function', async () => {
    const {service, executorApproval, clock, telemetry, session} = realtimeServiceHarness('pipeline', {
      projectTool: true, withExecutorApproval: true,
    })
    assert.ok(executorApproval !== null)
    session.injectHostContext = () => Promise.resolve(false)
    await service.connect()
    const waiting = offerCodexCommand(executorApproval)
    const approvalId = executorApproval.view.pending_approval_id!
    const expiresAt = executorApproval.view.expires_at!
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(executorApproval.pending, true, 'context failure leaves renderer authority pending')

    clock.advanceTo(expiresAt)
    assert.deepEqual(await waiting, {decision: 'decline'})
    await emitExecutorApprovalFunction(service, {
      approvalId,
      approved: true,
      responseId: 'context-failed-expired-response',
      callId: 'context-failed-expired-call',
    })
    assert.deepEqual(
      telemetry.filter(record => record.kind === 'approval.decision'),
      [{
        kind: 'approval.decision',
        payload: {
          session_epoch: 1, source: 'function', outcome: 'refused', reason: 'expired',
        },
      }],
    )
    assert.equal(JSON.stringify(telemetry).includes(approvalId), false)
  })
})

test('a pending Codex semantic acknowledgement does not block higher-priority Guard', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await finishExecutorApprovalQuestion(service, 'guard-priority-question')
  service.queueHostItem(hostFact('background:guard-priority-blocked'), {
    priority: 50,
    semanticEventId: 'background:guard-priority-blocked',
  })
  service.queueHostItem(guardFact('final:guard-priority-visible'), {
    priority: 90,
    preemptive: true,
  })
  await service.flushHostItems()

  assert.equal(actions.includes('inject:final:guard-priority-visible'), true)
  assert.equal(actions.includes('inject:background:guard-priority-blocked'), false)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex approval invalidation wakes a queued semantic acknowledgement', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'approval-question-response',
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'approval-answer', provider_item_id: 'approval-answer-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'approval-answer', provider_item_id: 'approval-answer-item',
  })
  await finishProviderResponse(service, 'approval-question-response')
  service.queueHostItem(hostFact('background:invalidate-release'), {
    priority: 50,
    semanticEventId: 'background:invalidate-release',
  })
  await service.flushHostItems()
  assert.equal(actions.includes('inject:background:invalidate-release'), false)

  assert.equal(executorApproval.invalidate('test_invalidation'), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
  await service.flushHostItems()
  assert.equal(actions.includes('inject:background:invalidate-release'), true)
})

test('a banner decision cancels the exact Codex approval response that is already audible', async () => {
  const {service, executorApproval, actions, session} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'clicked-approval-response',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'clicked-approval-response', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(service.playbackStarted(generation!.utterance_id, generation!.generation_epoch), true)

  assert.equal(service.executorApprovalDecision(approvalId, true), true)
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.ok(
    actions.includes('cancel:clicked-approval-response'),
    'a settled prompt cannot keep provider/playback ownership ahead of the task completion fact',
  )
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('Codex approval transcript completion alone leaves the controller pending', async () => {
  const {service, executorApproval} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!

  await beginExecutorApprovalCarrier(service, {
    itemId: 'transcript-only-item', responseId: 'transcript-only-response',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'transcript-only-item', text: '确认。',
  })

  assert.equal(executorApproval.pending, true, 'transcript text is audit data, not approval authority')
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex function is authoritative before or after transcript completion', async t => {
  for (const order of ['function-first', 'transcript-first'] as const) {
    await t.test(order, async () => {
      const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
        projectTool: true, withExecutorApproval: true,
      })
      assert.ok(executorApproval !== null)
      await service.connect()
      const waiting = offerCodexCommand(executorApproval)
      const approvalId = executorApproval.view.pending_approval_id!
      const itemId = `${order}-item`
      const responseId = `${order}-response`
      await beginExecutorApprovalCarrier(service, {itemId, responseId})
      if (order === 'transcript-first') {
        await service.handleEvent({
          kind: 'user_transcript_final', session_epoch: 1, item_id: itemId, text: '自然语言随意',
        })
        assert.equal(executorApproval.pending, true, 'transcript-first waits for the function')
      }

      await emitExecutorApprovalFunction(service, {
        approvalId, approved: order === 'function-first', responseId,
      })

      assert.equal(executorApproval.pending, false, 'the valid exact function settles immediately')
      assert.deepEqual(await waiting, {
        decision: order === 'function-first' ? 'accept' : 'decline',
      })
      assert.match(
        injectedContents.at(-1) ?? '',
        order === 'function-first' ? /"code":"approval_accepted"/u : /"code":"approval_declined"/u,
      )
    })
  }
})

test('Codex function arriving before user-item binding is held until exact reveal', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: null, responseId: 'prebinding-response', revealItemAtEnd: 'prebinding-item',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'prebinding-response',
  })
  assert.equal(executorApproval.pending, true)
  assert.equal(injectedContents.some(content => content.includes('approval_accepted')), false)

  await endExecutorApprovalSpeech(service, 'prebinding-response', 'prebinding-item')

  assert.equal(executorApproval.pending, false, 'exact item reveal releases the held function')
  assert.deepEqual(await waiting, {decision: 'accept'})
  assert.match(injectedContents.at(-1) ?? '', /"code":"approval_accepted"/u)
})

test('Codex final-only function stays silent and correlated through terminal before transcript', async () => {
  const {service, executorApproval, injectedContents, session} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  const responseId = 'final-only-response'

  await finishExecutorApprovalQuestion(service, 'approval-question-response')

  // Qwen may emit this entire response before the sibling transcript, without either VAD event.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  assert.equal(session.providerTurnUserInputRevision(responseId), 0)
  assert.deepEqual(session.responseEventIds(responseId), [])
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1, response_id: responseId,
    pcm: new Uint8Array([1, 2]),
  })
  assert.equal(session.currentGeneration, null, 'the provisional authorization carrier stays silent')

  await emitExecutorApprovalFunction(service, {approvalId, approved: true, responseId})
  assert.equal(executorApproval.pending, true, 'the function waits for exact item provenance')
  assert.deepEqual(
    injectedContents.filter(content => content.includes('"code":"approval_')),
    [],
    'the bounded provisional function is neither accepted nor refused prematurely',
  )
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: responseId,
    status: 'completed', reason: '',
  })

  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'final-only-item', text: '内容只用于记忆与审计。',
  })

  assert.equal(executorApproval.pending, false, 'the structured function settles after provenance arrives')
  assert.deepEqual(await waiting, {decision: 'accept'})
  assert.equal(
    injectedContents.filter(content => content.includes('"code":"approval_accepted"')).length,
    1,
    'terminal-before-transcript still completes the one-shot function exactly once',
  )
})

test('Codex final-only response binds when transcript precedes its structured function', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  const responseId = 'final-only-transcript-first-response'
  await finishExecutorApprovalQuestion(service, 'transcript-first-question')

  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'final-only-transcript-first-item', text: 'ASR 文本不参与授权。',
  })
  assert.equal(executorApproval.pending, true)
  await emitExecutorApprovalFunction(service, {approvalId, approved: false, responseId})

  assert.deepEqual(await waiting, {decision: 'decline'})
  assert.equal(
    injectedContents.filter(content => content.includes('"code":"approval_declined"')).length,
    1,
  )
})

test('Codex final-only terminal without a function requests only one structured retry', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  const responseId = 'final-only-empty-response'
  await finishExecutorApprovalQuestion(service, 'empty-question-response')

  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: responseId,
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'final-only-empty-item', text: '文本仍然不授权。',
  })

  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'final-only-retry-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'final-only-retry-response',
  })
  assert.deepEqual(await waiting, {decision: 'accept'})
  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
})

test('Codex final-only wrong approval identity stays refused while renderer click remains viable', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  const responseId = 'final-only-wrong-id-response'
  await finishExecutorApprovalQuestion(service, 'wrong-id-question-response')

  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await emitExecutorApprovalFunction(service, {
    approvalId: `${approvalId}-wrong`, approved: true, responseId,
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'final-only-wrong-id-item', text: '确认。',
  })

  assert.equal(executorApproval.pending, true, 'neither wrong function identity nor ASR text authorizes')
  // Spec 08: an id that names neither confirmation is no approval decision at all, so inside the
  // approval carrier response it is refused as any other tool would be; the approval FSM is not consulted.
  assert.equal(
    injectedContents.filter(content => content.includes('"code":"approval_carrier_tool_refused"')).length,
    1,
  )
  assert.equal(injectedContents.some(content => content.includes('approval_not_authorized')), false)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('ASR failure leaves both Codex function and renderer click authority viable', async t => {
  for (const authority of ['function', 'click'] as const) {
    await t.test(authority, async () => {
      const {service, executorApproval} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
      assert.ok(executorApproval !== null)
      await service.connect()
      const waiting = offerCodexCommand(executorApproval)
      const approvalId = executorApproval.view.pending_approval_id!
      const itemId = `asr-failed-${authority}`
      const responseId = `asr-failed-${authority}-response`
      await beginExecutorApprovalCarrier(service, {itemId, responseId})
      await service.handleEvent({
        kind: 'user_transcript_failed', session_epoch: 1, item_id: itemId,
      })
      if (authority === 'function') {
        await emitExecutorApprovalFunction(service, {approvalId, approved: true, responseId})
        assert.equal(executorApproval.pending, false, 'ASR failure does not disable exact function authority')
      } else {
        assert.equal(service.executorApprovalDecision(approvalId, true), true)
      }
      assert.deepEqual(await waiting, {decision: 'accept'})
    })
  }
})

test('a split Codex answer rotates to one fresh second attempt without inheriting the first', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!

  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-turn-a', provider_item_id: 'approval-turn-a',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-turn-a', provider_item_id: 'approval-turn-a',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'approval-response-a',
  })
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-turn-b',
    provider_item_id: 'approval-turn-b',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'approval-response-a',
  })

  assert.equal(executorApproval.pending, true, 'turn A cannot authorize after turn B starts')
  assert.match(injectedContents.at(-1) ?? '', /"code":"approval_not_authorized"/u)
  await finishProviderResponse(service, 'approval-response-a')
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-turn-b', provider_item_id: 'approval-turn-b',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'approval-response-b',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'approval-response-b',
  })
  assert.equal(executorApproval.pending, false, 'turn B owns a fresh exact isolation attempt')
  assert.match(injectedContents.at(-1) ?? '', /"code":"approval_accepted"/u)
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('a late unknown retry from attempt one cannot become attempt two carrier', async () => {
  const {service, executorApproval, injectedItems, session} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!

  await beginExecutorApprovalCarrier(service, {
    itemId: 'orphan-attempt-one-item', responseId: 'orphan-attempt-one-source',
  })
  await finishProviderResponse(service, 'orphan-attempt-one-source')
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'orphan-attempt-two-speech', provider_item_id: 'orphan-attempt-two-item',
  })

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'orphan-late-retry',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'orphan-late-retry', pcm: new Uint8Array([9, 9]),
  })
  assert.equal(session.currentGeneration, null, 'the ambiguous old retry stays silent')
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'orphan-late-retry', callId: 'orphan-late-call',
  })
  assert.equal(executorApproval.pending, true, 'the old retry cannot settle the fresh attempt')
  assert.match(
    injectedItems.find(item => item.kind === 'tool_output' && item.call_id === 'orphan-late-call')
      ?.content ?? '',
    /"code":"approval_not_authorized"/u,
  )
  await finishProviderResponse(service, 'orphan-late-retry')
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'orphan-attempt-two-speech', provider_item_id: 'orphan-attempt-two-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'orphan-attempt-two-fresh',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'orphan-attempt-two-fresh',
  })
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('a stale failed retry request cannot exhaust the fresh second attempt', async () => {
  let releaseRetry!: () => void
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
  let signalRetryStarted!: () => void
  const retryStarted = new Promise<void>(resolve => { signalRetryStarted = resolve })
  const {service, executorApproval, session} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  session.requestUserResponse = async () => {
    signalRetryStarted()
    await retryGate
    return false
  }
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!

  await beginExecutorApprovalCarrier(service, {
    itemId: 'stale-retry-attempt-one-item', responseId: 'stale-retry-attempt-one-response',
  })
  const staleTerminal = finishProviderResponse(service, 'stale-retry-attempt-one-response')
  await retryStarted
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'stale-retry-attempt-two-speech', provider_item_id: 'stale-retry-attempt-two-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'stale-retry-attempt-two-speech', provider_item_id: 'stale-retry-attempt-two-item',
  })

  releaseRetry()
  await staleTerminal
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'stale-retry-attempt-two-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'stale-retry-attempt-two-response',
  })

  assert.equal(executorApproval.pending, false, 'attempt two still owns exact voice authority')
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('an old failed retry continuation cannot mutate a replacement approval lifecycle', async () => {
  let releaseRetry!: () => void
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
  let signalRetryStarted!: () => void
  const retryStarted = new Promise<void>(resolve => { signalRetryStarted = resolve })
  const {service, executorApproval, session} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  session.requestUserResponse = async () => {
    signalRetryStarted()
    await retryGate
    return false
  }
  await service.connect()
  const oldWaiting = offerCodexCommand(executorApproval)
  const oldApprovalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: 'replacement-old-item', responseId: 'replacement-old-response',
  })
  const staleTerminal = finishProviderResponse(service, 'replacement-old-response')
  await retryStarted

  assert.equal(service.executorApprovalDecision(oldApprovalId, true), true)
  const oldResolution = await oldWaiting
  assert.deepEqual(oldResolution, {decision: 'accept'})
  assert.equal(executorApproval.consume(oldResolution), 'accept')
  const replacementWaiting = offerCodexCommand(executorApproval)
  const replacementId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })

  releaseRetry()
  await staleTerminal
  assert.equal(service.queuedHostItems().some(item => (
    item.intent.item.event_id === `approval:${replacementId}:clarification`
  )), false, 'the stale continuation cannot spend attempt one of the replacement')

  await beginExecutorApprovalCarrier(service, {
    itemId: 'replacement-fresh-item', responseId: 'replacement-fresh-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId: replacementId, approved: false, responseId: 'replacement-fresh-response',
  })
  assert.deepEqual(await replacementWaiting, {decision: 'decline'})
})

test('a delayed attempt-one initial response cannot inherit the fresh attempt-two revision', async () => {
  const {service, executorApproval, injectedItems, session} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })

  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'delayed-initial-a-speech', provider_item_id: 'delayed-initial-a-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'delayed-initial-a-speech', provider_item_id: 'delayed-initial-a-item',
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'delayed-initial-b-speech', provider_item_id: 'delayed-initial-b-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'delayed-initial-b-speech', provider_item_id: 'delayed-initial-b-item',
  })

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'delayed-attempt-one-response',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'delayed-attempt-one-response', pcm: new Uint8Array([1, 2, 3]),
  })
  assert.equal(session.currentGeneration, null, 'the old initial response is silent')
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'delayed-attempt-one-response',
    callId: 'delayed-attempt-one-call',
  })
  assert.equal(executorApproval.pending, true, 'the old approval decision cannot consume attempt two')
  assert.match(
    injectedItems.find(item => (
      item.kind === 'tool_output' && item.call_id === 'delayed-attempt-one-call'
    ))?.content ?? '',
    /"code":"approval_not_authorized"/u,
  )
  await finishProviderResponse(service, 'delayed-attempt-one-response')

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'delayed-attempt-two-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: false, responseId: 'delayed-attempt-two-response',
  })
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('an unrelated host response cannot consume a pending stale approval-response quarantine', async () => {
  const {service, executorApproval, injectedItems, session, actions} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })

  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'host-before-old-a-speech', provider_item_id: 'host-before-old-a-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'host-before-old-a-speech', provider_item_id: 'host-before-old-a-item',
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'host-before-old-b-speech', provider_item_id: 'host-before-old-b-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'host-before-old-b-speech', provider_item_id: 'host-before-old-b-item',
  })

  service.queueHostItem(hostFact('final:host-before-old-approval-response'), {
    priority: 90, preemptive: true,
  })
  await service.flushHostItems()
  assert.equal(actions.includes('inject:final:host-before-old-approval-response'), true)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'host-before-old-response',
  })
  assert.deepEqual(
    session.responseEventIds('host-before-old-response'),
    ['final:host-before-old-approval-response'],
  )
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'host-before-old-response', pcm: new Uint8Array([3, 4]),
  })
  assert.notEqual(session.currentGeneration, null, 'the event-owned host response stays audible')
  const hostGeneration = session.currentGeneration!
  assert.equal(service.playbackStarted(hostGeneration.utterance_id, hostGeneration.generation_epoch), true)
  await finishProviderResponse(service, 'host-before-old-response')
  assert.equal(service.playbackDone(
    hostGeneration.utterance_id,
    hostGeneration.generation_epoch,
    200,
  ), true)

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'old-response-after-host',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'old-response-after-host', pcm: new Uint8Array([8, 9]),
  })
  assert.equal(session.currentGeneration, null, 'the retained stale response remains silent')
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'old-response-after-host',
    callId: 'old-call-after-host',
  })
  assert.equal(executorApproval.pending, true)
  assert.match(
    injectedItems.find(item => item.kind === 'tool_output' && item.call_id === 'old-call-after-host')
      ?.content ?? '',
    /"state":"refused"/u,
  )
  await finishProviderResponse(service, 'old-response-after-host')

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'fresh-response-after-host',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: false, responseId: 'fresh-response-after-host',
  })
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('a pending retry remains quarantined after click, expiry, or replacement', async t => {
  for (const settlement of ['click', 'expiry', 'replacement'] as const) {
    await t.test(settlement, async () => {
      const {service, executorApproval, injectedItems, session, clock, actions} = realtimeServiceHarness('pipeline', {
        projectTool: true, withExecutorApproval: true,
      })
      assert.ok(executorApproval !== null)
      await service.connect()
      const oldWaiting = offerCodexCommand(executorApproval)
      const oldApprovalId = executorApproval.view.pending_approval_id!
      await beginExecutorApprovalCarrier(service, {
        itemId: `${settlement}-pending-item`, responseId: `${settlement}-pending-source`,
      })
      await finishProviderResponse(service, `${settlement}-pending-source`)
      service.queueHostItem(hostFact(`background:${settlement}-after-late-retry`), {
        priority: 50,
        semanticEventId: `background:${settlement}-after-late-retry`,
      })

      if (settlement === 'click') {
        assert.equal(service.executorApprovalDecision(oldApprovalId, true), true)
        assert.deepEqual(await oldWaiting, {decision: 'accept'})
      } else if (settlement === 'expiry') {
        clock.advanceTo(executorApproval.view.expires_at!)
        assert.deepEqual(await oldWaiting, {decision: 'decline'})
      } else {
        executorApproval.invalidate('replacement')
        assert.deepEqual(await oldWaiting, {decision: 'decline'})
        const currentWaiting = offerCodexCommand(executorApproval)
        const currentApprovalId = executorApproval.view.pending_approval_id!
        await new Promise<void>(resolve => { setImmediate(resolve) })
        assert.equal(service.executorApprovalDecision(currentApprovalId, false), true)
        const currentResolution = await currentWaiting
        assert.deepEqual(currentResolution, {decision: 'decline'})
        assert.equal(executorApproval.consume(currentResolution), 'decline')
      }

      const lateResponseId = `${settlement}-late-retry`
      await service.handleEvent({
        kind: 'response_started', session_epoch: 1, response_id: lateResponseId,
      })
      await service.handleEvent({
        kind: 'response_audio_delta', session_epoch: 1,
        response_id: lateResponseId, pcm: new Uint8Array([5, 6]),
      })
      assert.equal(session.currentGeneration, null, `${settlement} late retry stays silent`)
      await emitExecutorApprovalFunction(service, {
        approvalId: oldApprovalId, approved: true, responseId: lateResponseId,
        callId: `${settlement}-late-call`,
      })
      assert.match(
        injectedItems.find(item => (
          item.kind === 'tool_output' && item.call_id === `${settlement}-late-call`
        ))?.content ?? '',
        /"state":"refused"/u,
      )
      await finishProviderResponse(service, lateResponseId)

      await service.flushHostItems()
      assert.equal(
        actions.filter(action => action === `inject:background:${settlement}-after-late-retry`).length,
        1,
        'the quarantined retry terminal releases the existing completion receipt exactly once',
      )
    })
  }
})

test('attempt-one retry exhaustion opens one audible host clarification and a fresh attempt', async () => {
  const {service, executorApproval, actions, session, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await finishExecutorApprovalQuestion(service, 'attempt-one-question')

  await beginExecutorApprovalCarrier(service, {
    itemId: 'attempt-one-item', responseId: 'attempt-one-response',
  })
  await finishProviderResponse(service, 'attempt-one-response')
  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'attempt-one-retry',
  })
  await finishProviderResponse(service, 'attempt-one-retry')

  const clarification = injectedItems.filter(item => (
    item.event_id === `approval:${approvalId}:clarification`
  ))
  assert.equal(clarification.length, 1)
  assert.equal(clarification[0]?.content, '请明确说同意或拒绝。')
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === `inject:approval:${approvalId}:clarification`).length,
    1,
  )
  assert.equal(actions.filter(action => action === 'create_response:host_fact').length, 2)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'host-clarification-response',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'host-clarification-response', pcm: new Uint8Array([7, 8]),
  })
  assert.notEqual(session.currentGeneration, null, 'host clarification remains audible')
  await finishProviderResponse(service, 'host-clarification-response')

  await service.localSpeechOnset('attempt-two-local')
  await beginExecutorApprovalCarrier(service, {
    itemId: 'attempt-two-item', responseId: 'attempt-two-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'attempt-two-response',
  })
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('a third user revision retires voice authority but leaves the original banner clickable', async () => {
  const {service, executorApproval, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await new Promise<void>(resolve => { setImmediate(resolve) })

  await beginExecutorApprovalCarrier(service, {
    itemId: 'turn-one-item', responseId: 'turn-one-response',
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'turn-two-speech', provider_item_id: 'turn-two-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'turn-two-speech', provider_item_id: 'turn-two-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'turn-two-response',
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'turn-three-speech', provider_item_id: 'turn-three-item',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'turn-two-response', callId: 'late-turn-two-call',
  })

  assert.equal(executorApproval.pending, true)
  assert.match(
    injectedItems.find(item => item.kind === 'tool_output' && item.call_id === 'late-turn-two-call')
      ?.content ?? '',
    /"code":"approval_not_authorized"/u,
  )
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex approval click and function share one first-valid-decision race', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const clickWaiting = offerCodexCommand(executorApproval)
  const clickId = executorApproval.view.pending_approval_id!
  assert.equal(service.executorApprovalDecision(clickId, true), true)
  const clickResolution = await clickWaiting
  assert.deepEqual(clickResolution, {decision: 'accept'})
  assert.equal(service.executorApprovalDecision(clickId, false), false)
  await emitExecutorApprovalFunction(service, {
    approvalId: clickId, approved: false, responseId: null, callId: 'late-after-click',
  })
  assert.match(injectedContents.at(-1) ?? '', /"code":"approval_not_pending"/u)
  assert.ok(clickResolution !== null)
  assert.equal(executorApproval.consume(clickResolution), 'accept')

  const voiceWaiting = offerCodexCommand(executorApproval)
  const voiceId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: 'voice-wins', responseId: 'response-voice-wins',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId: voiceId, approved: false, responseId: 'response-voice-wins',
  })
  const voiceResolution = await voiceWaiting
  assert.deepEqual(voiceResolution, {decision: 'decline'})
  assert.equal(service.executorApprovalDecision(voiceId, true), false)
  await emitExecutorApprovalFunction(service, {
    approvalId: voiceId, approved: true, responseId: 'response-voice-wins',
    callId: 'duplicate-function',
  })
  assert.match(injectedContents.at(-1) ?? '', /"code":"approval_not_pending"/u)
})

test('Codex function identity mismatches fail closed while renderer authority remains', async t => {
  for (const mismatch of ['approval-id', 'response', 'epoch', 'arguments'] as const) {
    await t.test(mismatch, async () => {
      const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
        projectTool: true, withExecutorApproval: true,
      })
      assert.ok(executorApproval !== null)
      await service.connect()
      const waiting = offerCodexCommand(executorApproval)
      const approvalId = executorApproval.view.pending_approval_id!
      await beginExecutorApprovalCarrier(service, {
        itemId: `mismatch-${mismatch}`, responseId: `mismatch-${mismatch}-response`,
      })
      await emitExecutorApprovalFunction(service, {
        approvalId: mismatch === 'approval-id' ? 'wrong-id' : approvalId,
        approved: mismatch === 'arguments' ? 'yes' : true,
        responseId: mismatch === 'response' ? 'wrong-response' : `mismatch-${mismatch}-response`,
        epoch: mismatch === 'epoch' ? 2 : 1,
      })
      assert.equal(executorApproval.pending, true)
      if (mismatch !== 'epoch') {
        assert.match(injectedContents.at(-1) ?? '', /"state":"refused"/u)
      }
      assert.equal(service.executorApprovalDecision(approvalId, false), true)
      assert.deepEqual(await waiting, {decision: 'decline'})
    })
  }
})

test('Codex approval silent carrier retries once and retry function can settle', async () => {
  const {service, executorApproval, actions} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: 'retry-item', responseId: 'retry-source-response',
  })
  await finishProviderResponse(service, 'retry-source-response')
  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  assert.equal(executorApproval.pending, true)

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'retry-carrier-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId, approved: true, responseId: 'retry-carrier-response',
  })
  assert.equal(executorApproval.pending, false, 'the exact retry carrier can settle')
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('Codex approval exhausts both attempts before leaving only the click pending', async () => {
  const {service, executorApproval, actions, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: 'retry-exhausted-item', responseId: 'retry-exhausted-source',
  })
  await finishProviderResponse(service, 'retry-exhausted-source')
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'retry-exhausted-carrier',
  })
  await finishProviderResponse(service, 'retry-exhausted-carrier')

  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  assert.equal(executorApproval.pending, true)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'retry-exhausted-clarification',
  })
  await finishProviderResponse(service, 'retry-exhausted-clarification')
  await beginExecutorApprovalCarrier(service, {
    itemId: 'second-exhausted-item', responseId: 'second-exhausted-source',
  })
  await finishProviderResponse(service, 'second-exhausted-source')
  assert.equal(actions.filter(action => action === 'ensure_response').length, 2)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'second-exhausted-retry',
  })
  await finishProviderResponse(service, 'second-exhausted-retry')

  await beginExecutorApprovalCarrier(service, {
    itemId: 'later-item-after-exhaustion', responseId: 'later-response-after-exhaustion',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId,
    approved: true,
    responseId: 'later-response-after-exhaustion',
    callId: 'later-call-after-exhaustion',
  })

  assert.equal(executorApproval.pending, true, 'two exhausted attempts permanently retire voice authority')
  assert.equal(actions.filter(action => action === 'ensure_response').length, 2)
  const laterOutputs = injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'later-call-after-exhaustion'
  ))
  assert.equal(laterOutputs.length, 1)
  assert.match(laterOutputs[0]?.content ?? '', /"code":"approval_not_authorized"/u)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('a failed Codex retry request rotates to the one fresh second attempt', async () => {
  const {service, executorApproval, actions, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    ensureResponseFailure: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: 'failed-retry-item', responseId: 'failed-retry-source',
  })
  await finishProviderResponse(service, 'failed-retry-source')

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'failed-retry-clarification',
  })
  await finishProviderResponse(service, 'failed-retry-clarification')
  await beginExecutorApprovalCarrier(service, {
    itemId: 'later-item-after-failed-retry', responseId: 'later-response-after-failed-retry',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId,
    approved: true,
    responseId: 'later-response-after-failed-retry',
    callId: 'later-call-after-failed-retry',
  })

  assert.equal(executorApproval.pending, false)
  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  const laterOutputs = injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'later-call-after-failed-retry'
  ))
  assert.equal(laterOutputs.length, 1)
  assert.match(laterOutputs[0]?.content ?? '', /"code":"approval_accepted"/u)
  assert.deepEqual(await waiting, {decision: 'accept'})
})

test('Codex invalidation refuses every deferred current-epoch function exactly once', async () => {
  const {service, executorApproval, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: null, responseId: 'deferred-invalidation-response', revealItemAtEnd: 'never-revealed',
  })
  for (const callId of ['deferred-invalidation-a', 'deferred-invalidation-b']) {
    await emitExecutorApprovalFunction(service, {
      approvalId, approved: true, responseId: 'deferred-invalidation-response', callId,
    })
  }
  assert.equal(injectedItems.some(item => item.kind === 'tool_output'), false)

  assert.equal(executorApproval.invalidate('test_invalidation'), true)
  await new Promise<void>(resolve => { setImmediate(resolve) })

  for (const callId of ['deferred-invalidation-a', 'deferred-invalidation-b']) {
    const outputs = injectedItems.filter(item => item.kind === 'tool_output' && item.call_id === callId)
    assert.equal(outputs.length, 1, `${callId} receives one terminal output`)
    assert.match(outputs[0]?.content ?? '', /"code":"approval_not_authorized"/u)
  }
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('a deferred Codex refusal batch never injects its second call after reconnect', async () => {
  let releaseFirstInjection!: () => void
  const firstInjectionGate = new Promise<void>(resolve => { releaseFirstInjection = resolve })
  let signalFirstInjection!: () => void
  const firstInjectionStarted = new Promise<void>(resolve => { signalFirstInjection = resolve })
  const {service, executorApproval, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (item.kind === 'tool_output' && item.call_id === 'epoch-race-first') {
        signalFirstInjection()
        return firstInjectionGate
      }
      return Promise.resolve()
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: null, responseId: 'epoch-race-response', revealItemAtEnd: 'never-revealed',
  })
  for (const callId of ['epoch-race-first', 'epoch-race-second']) {
    await emitExecutorApprovalFunction(service, {
      approvalId, approved: true, responseId: 'epoch-race-response', callId,
    })
  }

  assert.equal(executorApproval.invalidate('epoch_race'), true)
  await firstInjectionStarted
  assert.equal(await service.reconnectForTest(1), true)
  releaseFirstInjection()
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.equal(injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'epoch-race-first'
  )).length, 1)
  assert.equal(injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'epoch-race-second'
  )).length, 0, 'the old second call must not reach the replacement provider')
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('a failed deferred Codex refusal does not strand later calls in the same epoch', async () => {
  const completedCallIds: string[] = []
  const {service, executorApproval, injectedItems, diagnostics} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
    beforeInjectConfirmation: item => {
      if (item.kind !== 'tool_output') return Promise.resolve()
      if (item.call_id === 'independent-failure-first') {
        return Promise.reject(new Error('first refusal injection failed'))
      }
      completedCallIds.push(item.call_id ?? '')
      return Promise.resolve()
    },
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: null, responseId: 'independent-failure-response', revealItemAtEnd: 'never-revealed',
  })
  for (const callId of ['independent-failure-first', 'independent-failure-second']) {
    await emitExecutorApprovalFunction(service, {
      approvalId, approved: true, responseId: 'independent-failure-response', callId,
    })
  }

  assert.equal(executorApproval.invalidate('injection_failure'), true)
  await new Promise<void>(resolve => { setImmediate(resolve) })

  for (const callId of ['independent-failure-first', 'independent-failure-second']) {
    assert.equal(injectedItems.filter(item => (
      item.kind === 'tool_output' && item.call_id === callId
    )).length, 1, `${callId} is attempted exactly once`)
  }
  assert.deepEqual(completedCallIds, ['independent-failure-second'])
  assert.equal(diagnostics.filter(line => line.includes('delivery_failure')).length, 1)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('a newer user item refuses deferred Codex functions and cannot inherit voice authority', async () => {
  const {service, executorApproval, actions, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true,
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await beginExecutorApprovalCarrier(service, {
    itemId: null, responseId: 'deferred-stale-response', revealItemAtEnd: 'never-revealed',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId,
    approved: true,
    responseId: 'deferred-stale-response',
    callId: 'deferred-stale-call',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-deferred-stale-response', provider_item_id: null,
  })
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'later-stale-speech', provider_item_id: 'later-stale-item',
  })

  const deferredOutputs = injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'deferred-stale-call'
  ))
  assert.equal(deferredOutputs.length, 1)
  assert.match(deferredOutputs[0]?.content ?? '', /"code":"approval_not_authorized"/u)
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'later-stale-speech', provider_item_id: 'later-stale-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'later-stale-response',
  })
  await emitExecutorApprovalFunction(service, {
    approvalId,
    approved: true,
    responseId: 'later-stale-response',
    callId: 'later-stale-call',
  })

  assert.equal(executorApproval.pending, true)
  assert.equal(actions.filter(action => action === 'ensure_response').length, 0)
  const laterOutputs = injectedItems.filter(item => (
    item.kind === 'tool_output' && item.call_id === 'later-stale-call'
  ))
  assert.equal(laterOutputs.length, 1)
  assert.match(laterOutputs[0]?.content ?? '', /"code":"approval_not_authorized"/u)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})

test('Codex approval expiry and provider reconnect revoke pending voice authority', async () => {
  const expired = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(expired.executorApproval !== null)
  await expired.service.connect()
  const expiredWaiting = offerCodexCommand(expired.executorApproval)
  const expiredId = expired.executorApproval.view.pending_approval_id!
  await expired.service.flushHostItems()
  expired.clock.advanceTo(expired.executorApproval.view.expires_at!)
  assert.deepEqual(await expiredWaiting, {decision: 'decline'})
  assert.equal(expired.executorApproval.pending, false)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(expired.actions.filter(action => (
    action === `retire:provider:approval:${expiredId}:requested`
  )).length, 1)

  const reconnected = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(reconnected.executorApproval !== null)
  await reconnected.service.connect()
  const reconnectWaiting = offerCodexCommand(reconnected.executorApproval)
  const reconnectId = reconnected.executorApproval.view.pending_approval_id!
  await reconnected.service.flushHostItems()
  assert.equal(await reconnected.service.reconnectForTest(1), true)
  assert.deepEqual(await reconnectWaiting, {decision: 'decline'})
  assert.equal(reconnected.executorApproval.pending, false)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(reconnected.actions.filter(action => (
    action === `retire:provider:approval:${reconnectId}:requested`
  )).length, 1)
})

test('a later project confirmation parks the Codex approval queue instead of draining it', async () => {
  // Spec 08 §concurrency: an approval from work A while the user confirms project B waits, undeclined.
  const {service, controller, executorApproval, actions, clock} = realtimeServiceHarness('confirmation', {
    withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()

  const head = offerCodexCommand(executorApproval)
  const queued = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id
  assert.ok(approvalId !== undefined)
  assert.equal(executorApproval.view.queued, 1)
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'codex-question-before-project',
  })
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'independent-project-answer',
    provider_item_id: 'independent-project-item',
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })

  // Neither approval is declined; the head only loses its voice authority while the proposal holds the floor,
  // and its TTL is paused (`held`): well past the 60 s TTL it is still pending, not auto-declined (P1-3).
  assert.equal(executorApproval.view.held, true)
  clock.advanceTo(clock.now() + 90)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(executorApproval.pending, true, 'the head approval keeps waiting')
  assert.equal(executorApproval.view.pending_approval_id, approvalId)
  assert.equal(executorApproval.view.queued, 1, 'the queued approval keeps its place')
  const injectedFacts = () => actions.filter(action => action === `inject:approval:${approvalId}:requested`).length
  assert.equal(injectedFacts(), 1)
  assert.equal(
    actions.filter(action => action === `retire:provider:approval:${approvalId}:requested`).length,
    1,
    'the Codex provider fact is withdrawn once',
  )
  assert.equal(actions.filter(action => action === 'cancel:codex-question-before-project').length, 1)
  assert.deepEqual(service.confirmationItemsForTest, ['1:independent-project-item'])
  assert.equal(service.projectConfirmationBlockingForTest, true)
  assert.equal(controller.lifecycleId, proposal.proposal_id)

  // The proposal settles (renderer cancel): the head is re-armed with a fresh full TTL and its spoken fact re-appears.
  clock.advanceTo(clock.now() + 5)
  await service.projectConfirmationDecision(proposal.proposal_id, false)
  assert.equal(controller.pending, false)
  await service.flushHostItems()
  assert.equal(executorApproval.pending, true)
  assert.equal(executorApproval.view.pending_approval_id, approvalId, 'the same head, never declined')
  assert.equal(executorApproval.view.held, undefined)
  assert.equal(executorApproval.view.expires_at, clock.now() + 60, 'a fresh TTL, as if it had just become head')
  assert.equal(injectedFacts(), 2, 're-armed after the proposal settled')

  // The renderer pill (controller view) answers it; the queued approval is promoted and armed in turn.
  assert.equal(service.executorApprovalDecision(approvalId, true), true)
  const resolution = await head
  assert.deepEqual(resolution, {decision: 'accept'})
  assert.equal(executorApproval.consume(resolution), 'accept')
  const secondId = executorApproval.view.pending_approval_id
  assert.ok(secondId !== undefined && secondId !== approvalId)
  await service.flushHostItems()
  assert.equal(actions.filter(action => action === `inject:approval:${secondId}:requested`).length, 1)

  // Parked again by a later proposal, then released: the fresh TTL runs out normally 60 s later.
  const later = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1, speech_id: 'later-project-answer', provider_item_id: 'later-project-item',
  })
  assert.equal(executorApproval.view.held, true)
  clock.advanceTo(clock.now() + 90)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(executorApproval.view.pending_approval_id, secondId, 'held through 90 s')
  await service.projectConfirmationDecision(later.proposal_id, false)
  await service.flushHostItems()
  assert.equal(executorApproval.view.expires_at, clock.now() + 60)
  clock.advanceTo(clock.now() + 60)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(await queued, {decision: 'decline'}, 'expired normally once released')
  assert.equal(executorApproval.pending, false)
})

test('the dedicated confirmation function commits the reserved proposal', async () => {
  const commits: string[] = []
  const {service, controller, injected} = realtimeServiceHarness('confirmation', {
    commit: operation => {
      commits.push(operation.proposal_id)
      return Promise.resolve({accepted: true, code: 'committed'})
    },
  })
  await service.connect()
  const proposal = propose(controller)

  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})

  assert.deepEqual(commits, [proposal.proposal_id])
  assert.match(injected.at(-1)?.content ?? '', /"code":"confirmed"/u)
  const confirmationFacts = [
    ...injected.map(item => item.content),
    ...service.queuedHostItems().map(item => item.intent.item.content),
  ]
  assert.ok(confirmationFacts.includes('已确认，已创建并切换到工作区 研究项目。'))
  assert.equal(controller.pending, false)
})

test('a committed confirmation has one host-owned reply and suppresses the tool continuation', async () => {
  const {service, controller, injected, actions} = realtimeServiceHarness('confirmation', {
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  await service.connect()
  const proposal = propose(controller)

  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  assert.equal(actions.includes('cancel:response-1'), true)
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-1',
    pcm: new Uint8Array([0, 1]),
  })

  assert.equal(
    service.session.currentGeneration,
    null,
    'the provider continuation must not speak in parallel with the deterministic host fact',
  )
  const confirmationFacts = [
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.event_id.startsWith('project-confirmation:'))
  assert.equal(confirmationFacts.length, 1)
  assert.equal(confirmationFacts[0]?.content, '已确认，已提交并正在启动。')
})

test('a voice confirmation quarantines the carrier and delivers the host fact after terminal', async () => {
  const {service, controller, injected, actions} = realtimeServiceHarness('confirmation', {
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  await service.connect()
  const proposal = propose(controller)

  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  assert.equal(actions.includes('cancel:response-1'), true)
  assert.ok(
    service.queuedHostItems().some(item => (
      item.intent.item.content === '已确认，已提交并正在启动。'
    )),
    'the confirmation fact is queued immediately',
  )

  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-1',
    status: 'cancelled',
    reason: '',
  })

  assert.ok(
    injected.some(item => item.content === '已确认，已提交并正在启动。'),
    'the confirmation fact is delivered once the carrier turn ends',
  )
  assert.equal(controller.pending, false)
})

test('a settled voice confirmation still owns its host reply after the carrier started speaking', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'spoken-confirmation',
    responseId: 'spoken-carrier',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'spoken-carrier',
    pcm: new Uint8Array([0, 1]),
  })

  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'spoken-confirmation-call',
    item_id: 'spoken-confirmation-function',
    response_id: 'spoken-carrier',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(actions.includes('cancel:spoken-carrier'), true)
  assert.equal(toldAboutConfirmation(service, actions), true)
  assert.equal([
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.event_id.startsWith('project-confirmation:')).length, 1)
})

test('a confirmation carrier cancel rejection reconnects without the Guard gate', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  service.session.registerDelegate('delegate-survives-confirmation-reconnect', {
    summary: '继续实现计时器',
    state: 'running',
    channel: 'codex',
    progress_summary: '正在运行测试',
    internal_activity: 2,
    elapsed: 8,
  })
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})

  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'response-1',
    cancel_request_id: 'cancel-confirmation-1',
    reason: 'no_active_response',
  })

  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)
  assert.equal(service.session.snapshot().active_delegates.some(([delegateId]) => (
    delegateId === 'delegate-survives-confirmation-reconnect'
  )), true, 'active delegate recovery survives the controlled reconnect')
  assert.equal([
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.event_id.startsWith('project-confirmation:')).length, 1,
  'the queued confirmation receipt survives reconnect exactly once')
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-1',
    pcm: new Uint8Array([0, 1]),
  })
  assert.equal(service.session.currentGeneration, null, 'late audio from the replaced epoch is ignored')
})

test('a confirmation carrier that never reaches terminal reconnects after three seconds', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})

  clock.advanceTo(2.999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 1)
  clock.advanceTo(3)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)
})

test('confirmation carrier recovery waits for a concurrent user transcript', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'follow-up-speech',
    provider_item_id: 'follow-up-item',
  })

  clock.advanceTo(3)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 1)
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'follow-up-speech',
    provider_item_id: 'follow-up-item',
  })
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 1)
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'follow-up-item',
    text: '你在写吗？',
  })

  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)
})

test('confirmation carrier recovery escapes a user hold whose transcript never terminates', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'stuck-follow-up',
    provider_item_id: 'stuck-follow-up-item',
  })

  clock.advanceTo(3)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 1)
  clock.advanceTo(31)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)
})

test('confirmation cancellation never targets a newer response after tool output injection races', async () => {
  let releaseInjection: (() => void) | undefined
  let injectionReached: (() => void) | undefined
  const blocked = new Promise<void>(resolve => { releaseInjection = resolve })
  const reached = new Promise<void>(resolve => { injectionReached = resolve })
  const {service, controller, actions} = realtimeServiceHarness('confirmation', {
    beforeInjection: item => {
      if (item.kind !== 'tool_output' || item.call_id !== 'racing-confirmation-call') {
        return Promise.resolve()
      }
      injectionReached?.()
      return blocked
    },
  })
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'racing-confirmation-item',
    responseId: 'old-confirmation-carrier',
  })
  const decision = service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'racing-confirmation-call',
    item_id: 'racing-confirmation-function',
    response_id: 'old-confirmation-carrier',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  await reached
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'old-confirmation-carrier',
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'new-user-response',
  })
  releaseInjection?.()
  await decision

  assert.equal(actions.includes('cancel:new-user-response'), false)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('a terminal carrier is fenced without arming a reconnect watchdog for queued audio', async () => {
  let releaseInjection: (() => void) | undefined
  let injectionReached: (() => void) | undefined
  const blocked = new Promise<void>(resolve => { releaseInjection = resolve })
  const reached = new Promise<void>(resolve => { injectionReached = resolve })
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation', {
    beforeInjection: item => {
      if (item.kind !== 'tool_output' || item.call_id !== 'terminal-carrier-call') {
        return Promise.resolve()
      }
      injectionReached?.()
      return blocked
    },
  })
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'terminal-carrier-item',
    responseId: 'terminal-carrier',
  })
  const decision = service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'terminal-carrier-call',
    item_id: 'terminal-carrier-function',
    response_id: 'terminal-carrier',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  await reached
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'terminal-carrier',
    pcm: new Uint8Array([0, 1]),
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'terminal-carrier',
    status: 'completed', reason: '',
  })
  releaseInjection?.()
  await decision

  assert.equal(service.session.currentGeneration, null, 'queued carrier audio is fenced')
  assert.equal(actions.includes('cancel:terminal-carrier'), false, 'a terminal turn is not cancelled')
  clock.advanceTo(4)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 1)
})

test('a confirmation transition has a stable event id within its proposal lifecycle', async () => {
  const lifecycleFactory = (suffix: string): (() => string) => {
    let count = 0
    return () => {
      count += 1
      return count === 1 ? 'shared-proposal' : `${suffix}-${count}`
    }
  }
  const first = realtimeServiceHarness('confirmation', {
    idFactory: lifecycleFactory('first'),
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  const second = realtimeServiceHarness('confirmation', {
    idFactory: lifecycleFactory('second'),
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  await first.service.connect()
  await second.service.connect()
  const firstProposal = propose(first.controller)
  const secondProposal = propose(second.controller)
  assert.equal(firstProposal.proposal_id, secondProposal.proposal_id)

  await confirmationTurn(first.service, {proposalId: firstProposal.proposal_id, confirmed: true})
  await confirmationTurn(second.service, {proposalId: secondProposal.proposal_id, confirmed: true})

  const eventId = (service: ReturnType<typeof realtimeServiceHarness>): string | undefined => [
    ...service.injected,
    ...service.service.queuedHostItems().map(item => item.intent.item),
  ].find(item => item.event_id.startsWith('project-confirmation:'))?.event_id
  assert.equal(eventId(first), eventId(second))
})

test('identical confirmation text in different proposal lifecycles has different event ids', async () => {
  const first = realtimeServiceHarness('confirmation', {
    idFactory: (() => {
      let count = 0
      return () => ++count === 1 ? 'proposal-a' : `a-${count}`
    })(),
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  const second = realtimeServiceHarness('confirmation', {
    idFactory: (() => {
      let count = 0
      return () => ++count === 1 ? 'proposal-b' : `b-${count}`
    })(),
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  await first.service.connect()
  await second.service.connect()
  const firstProposal = propose(first.controller)
  const secondProposal = propose(second.controller)

  await confirmationTurn(first.service, {proposalId: firstProposal.proposal_id, confirmed: true})
  await confirmationTurn(second.service, {proposalId: secondProposal.proposal_id, confirmed: true})

  const eventId = (service: ReturnType<typeof realtimeServiceHarness>): string | undefined => [
    ...service.injected,
    ...service.service.queuedHostItems().map(item => item.intent.item),
  ].find(item => item.event_id.startsWith('project-confirmation:'))?.event_id
  assert.notEqual(eventId(first), eventId(second))
})

test('a second utterance captured during the reserved confirmation cannot produce another reply', async () => {
  const {service, controller} = realtimeServiceHarness('confirmation', {
    commit: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })
  await service.connect()
  const proposal = propose(controller)

  for (const itemId of ['first-confirmation', 'repeated-confirmation']) {
    await service.handleEvent({
      kind: 'user_speech_started',
      session_epoch: 1,
      speech_id: `speech-${itemId}`,
      provider_item_id: itemId,
    })
    await service.handleEvent({
      kind: 'user_speech_ended',
      session_epoch: 1,
      speech_id: `speech-${itemId}`,
      provider_item_id: itemId,
    })
    await service.handleEvent({
      kind: 'user_transcript_final',
      session_epoch: 1,
      item_id: itemId,
      text: itemId === 'first-confirmation' ? '确认' : '可以啊，我确认',
    })
    if (itemId === 'first-confirmation') {
      // The carrier captured the first revision before the repeated utterance interrupted it.
      await service.handleEvent({
        kind: 'response_started', session_epoch: 1, response_id: 'response-1',
      })
    }
  }
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-1',
    item_id: 'function-1',
    response_id: 'response-1',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-1',
    status: 'completed',
    reason: 'completed',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'response-2'})
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-2',
    status: 'completed',
    reason: 'completed',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'response-3'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-3',
    pcm: new Uint8Array([0, 1]),
  })

  assert.equal(
    service.session.currentGeneration,
    null,
    'the unreserved duplicate turn is quarantined even after the proposal has been consumed',
  )
})

test('a structured false decision cancels without committing', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: false})
  assert.equal(actions.includes('commit'), false, 'nothing was committed')
  assert.equal(controller.pending, false)
  assert.match(injected.find(item => item.kind === 'tool_output')?.content ?? '', /cancelled/u)
  assert.ok(toldAboutConfirmation(service, actions), 'and the user is told')
})

test('non-boolean confirmation arguments fail closed without committing', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: 'true'})
  assert.equal(actions.includes('commit'), false)
  assert.equal(controller.pending, true)
  assert.match(injected.find(item => item.kind === 'tool_output')?.content ?? '', /invalid/u)
})

test('a stale proposal id fails closed without committing', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await confirmationTurn(service, {proposalId: 'proposal-stale', confirmed: true})
  assert.equal(actions.includes('commit'), false)
  assert.equal(controller.pending, true)
})

test('a confirmation call replay commits and produces provider output once', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  const replay = {
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-1',
    item_id: 'function-1',
    response_id: 'response-1',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  } as const
  await service.handleEvent(replay)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(injected.filter(item => item.call_id === 'confirm-1').length, 1)
})

test('a confirmation function from another response or epoch fails closed', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-user-1',
    provider_item_id: 'user-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'response-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-1',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 2,
    call_id: 'confirm-stale-epoch',
    item_id: 'function-stale-epoch',
    response_id: 'response-1',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(actions.includes('commit'), false)
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-other',
    item_id: 'function-other',
    response_id: 'response-other',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(actions.includes('commit'), false)
  assert.equal(controller.pending, true)
  assert.match(injected.at(-1)?.content ?? '', /confirmation_not_pending/u)
})

test('a stale response start cannot bind the current reserved confirmation item', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-current',
    provider_item_id: 'user-current',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 2,
    response_id: 'response-stale',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-current',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-polluted',
    item_id: 'function-polluted',
    response_id: 'response-stale',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.includes('commit'), false)
  assert.equal(controller.pending, true)
})

test('malformed confirmation arguments preserve the proposal and reservation', async () => {
  const cases: readonly {
    readonly name: string
    readonly build: (proposalId: string) => Record<string, unknown>
    readonly accessorReads?: () => number
  }[] = (() => {
    let reads = 0
    const accessor = (proposalId: string): Record<string, unknown> => {
      const value: Record<string, unknown> = {accepted: true}
      Object.defineProperty(value, 'id', {
        enumerable: true,
        get: () => {
          reads += 1
          return proposalId
        },
      })
      return value
    }
    return [
      {name: 'extra field', build: proposalId => ({id: proposalId, accepted: true, extra: 1})},
      {name: 'missing field', build: proposalId => ({id: proposalId})},
      {name: 'empty id', build: () => ({id: '', accepted: true})},
      {name: 'overlong id', build: () => ({id: 'p'.repeat(129), accepted: true})},
      {name: 'boxed boolean', build: proposalId => ({
        id: proposalId, accepted: new Boolean(true),
      })},
      {name: 'accessor object', build: accessor, accessorReads: () => reads},
    ]
  })()

  for (const [index, invalid] of cases.entries()) {
    const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
    await service.connect()
    const proposal = propose(controller)
    const responseId = `response-invalid-${index}`
    await reserveConfirmationTurn(service, {
      itemId: `user-invalid-${index}`,
      responseId,
    })
    const invalidEvent = {
      kind: 'tool_call_ready',
      session_epoch: 1,
      call_id: `confirm-invalid-${index}`,
      item_id: `function-invalid-${index}`,
      response_id: responseId,
      name: 'confirm',
      arguments: invalid.build(proposal.proposal_id) as Readonly<Record<string, JsonValue>>,
    } as const
    await service.handleEvent(invalidEvent)
    await service.handleEvent(invalidEvent)
    assert.equal(actions.includes('commit'), false, invalid.name)
    assert.equal(controller.pending, true, invalid.name)
    assert.equal(
      injected.filter(item => item.call_id === `confirm-invalid-${index}`).length,
      1,
      invalid.name,
    )
    if (invalid.accessorReads !== undefined) assert.equal(invalid.accessorReads(), 0, invalid.name)

    await service.handleEvent({
      kind: 'tool_call_ready',
      session_epoch: 1,
      call_id: `confirm-valid-${index}`,
      item_id: `function-valid-${index}`,
      response_id: responseId,
      name: 'confirm',
      arguments: {id: proposal.proposal_id, accepted: true},
    })
    assert.equal(actions.filter(action => action === 'commit').length, 1, invalid.name)
  }
})

test('a desktop banner decision commits through the same one-shot controller path', async () => {
  const {service, controller, actions, telemetry} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)

  await service.projectConfirmationDecision('stale-proposal', true)
  assert.equal(actions.includes('commit'), false)
  assert.equal(controller.pending, true)

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(controller.pending, false)
  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(actions.filter(action => action === 'commit').length, 1, 'a replay cannot commit twice')
  assert.ok(telemetry.some(record => (
    record.kind === 'project_confirmation.ui_decision_completed'
    && record.payload.proposal_id === proposal.proposal_id
    && record.payload.state === 'accepted'
  )))
})

test('a runtime-rejected banner decision restores the same authority and original ttl', async () => {
  let attempts = 0
  const {service, controller, views, clock, telemetry} = realtimeServiceHarness('confirmation', {
    commit: () => {
      attempts += 1
      return Promise.resolve(attempts === 1
        ? {accepted: false, code: 'runtime_rejected'}
        : {accepted: true, code: 'accepted'})
    },
  })
  await service.connect()
  const proposal = propose(controller)
  clock.advanceTo(15)

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(attempts, 1)
  assert.equal(controller.pending, true, 'the banner remains actionable')
  assert.equal(controller.committing, false, 'the shared committing lock is released')
  assert.deepEqual(views.at(-1), {
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: true,
    pending_confirmation_busy: false,
    pending_confirmation_id: proposal.proposal_id,
    pending_action: 'create_workspace',
    pending_workspace_display_name: '研究项目',
    pending_session_title: null,
    pending_expires_in_seconds: 345,
  })

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(attempts, 2)
  assert.equal(controller.pending, false, 'the restored authority is consumed after admission')
  assert.deepEqual(telemetry.filter(record => record.kind.startsWith(
    'project_confirmation.commit_',
  )).map(record => record.kind), [
    'project_confirmation.commit_started',
    'project_confirmation.commit_admission',
    'project_confirmation.commit_rollback',
    'project_confirmation.commit_started',
    'project_confirmation.commit_admission',
    'project_confirmation.commit_settled',
  ])
  const admission = telemetry.find(record => (
    record.kind === 'project_confirmation.commit_admission'
    && record.payload.accepted === true
  ))
  assert.equal(admission?.payload.proposal_origin_ref, 'conversation:1')
  assert.equal(admission?.payload.delegate_origin_ref, 'conversation:1')
})

test('a runtime rejection after the ttl publishes only the expiry-owned fact', async () => {
  let releaseCommit: (() => void) | undefined
  let commitReached: (() => void) | undefined
  const held = new Promise<void>(resolve => { releaseCommit = resolve })
  const reached = new Promise<void>(resolve => { commitReached = resolve })
  const {service, controller, clock, injected} = realtimeServiceHarness('confirmation', {
    commit: async () => {
      commitReached?.()
      await held
      return {accepted: false, code: 'runtime_rejected'}
    },
  })
  await service.connect()
  const proposal = propose(controller)

  const decision = service.projectConfirmationDecision(proposal.proposal_id, true)
  await reached
  clock.advanceTo(proposal.expires_at)
  releaseCommit?.()
  await decision
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const facts = [
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].map(item => item.content)
  assert.equal(controller.pending, false, 'an expired rejection is terminal rather than retryable')
  assert.equal(facts.filter(text => text === '确认已过期，本次操作已取消。').length, 1)
  assert.equal(facts.filter(text => text === 'Codex 当前正忙，本次操作未执行。').length, 0)
})

test('a voice runtime rejection after the ttl publishes only the expiry-owned fact', async () => {
  let releaseCommit: (() => void) | undefined
  let commitReached: (() => void) | undefined
  const held = new Promise<void>(resolve => { releaseCommit = resolve })
  const reached = new Promise<void>(resolve => { commitReached = resolve })
  const {service, controller, clock, injected} = realtimeServiceHarness('confirmation', {
    commit: async () => {
      commitReached?.()
      await held
      return {accepted: false, code: 'runtime_rejected'}
    },
  })
  await service.connect()
  const proposal = propose(controller)

  const turn = confirmationTurn(service, {
    proposalId: proposal.proposal_id,
    confirmed: true,
    transcript: '确认',
  })
  await reached
  clock.advanceTo(proposal.expires_at)
  releaseCommit?.()
  await turn
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const facts = [
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].map(item => item.content)
  assert.equal(controller.pending, false, 'an expired rejection is terminal rather than retryable')
  assert.equal(facts.filter(text => text === '确认已过期，本次操作已取消。').length, 1)
  assert.equal(facts.filter(text => text === 'Codex 当前正忙，本次操作未执行。').length, 0)
})

test('a delayed banner commit publishes busy and a bare failed callback cannot strand it', async () => {
  let releaseCommit: (() => void) | undefined
  let commitReached: (() => void) | undefined
  const held = new Promise<void>(resolve => { releaseCommit = resolve })
  const reached = new Promise<void>(resolve => { commitReached = resolve })
  const delayed = realtimeServiceHarness('confirmation', {
    commit: async () => {
      commitReached?.()
      await held
      return {accepted: true, code: 'accepted'}
    },
  })
  await delayed.service.connect()
  const proposal = propose(delayed.controller)
  const decision = delayed.service.projectConfirmationDecision(proposal.proposal_id, true)
  await reached
  assert.equal(delayed.views.at(-1)?.pending_confirmation, true)
  assert.equal(delayed.views.at(-1)?.pending_confirmation_busy, true)
  releaseCommit?.()
  await decision
  assert.equal(delayed.views.at(-1)?.pending_confirmation, false)

  const failed = realtimeServiceHarness('confirmation', {
    commit: () => Promise.resolve({accepted: false, code: 'busy'}),
  })
  await failed.service.connect()
  const failedProposal = propose(failed.controller)
  await failed.service.projectConfirmationDecision(failedProposal.proposal_id, true)
  assert.equal(failed.controller.pending, false)
  assert.equal(failed.controller.committing, false, 'manual callback failure is terminal, not stuck')
})

test('a banner decision fences an active confirmation response until its terminal', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'ui-active-item',
    responseId: 'ui-active-response',
    transcript: '确认',
  })

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(actions.includes('cancel:ui-active-response'), true)
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'late-active-tool', item_id: 'late-active-function',
    response_id: 'ui-active-response', name: 'codex__run',
    arguments: {work_order: 'must not run'},
  })
  assert.match(
    injected.find(item => item.call_id === 'late-active-tool')?.content ?? '',
    /confirmation_reserved/u,
  )
  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('a banner decision revokes a requested retry whose response id has not arrived', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'ui-retry-speech', provider_item_id: 'ui-retry-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'ui-retry-speech', provider_item_id: 'ui-retry-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'ui-retry-source',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'ui-retry-source',
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'ui-retry-item', text: '确认',
  })
  assert.equal(actions.filter(action => action === 'ensure-response').length, 1)

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'ui-retry-late',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'late-retry-tool', item_id: 'late-retry-function',
    response_id: 'ui-retry-late', name: 'codex__run',
    arguments: {work_order: 'must not run'},
  })
  assert.equal(
    injected.some(item => item.call_id === 'late-retry-tool'),
    false,
    'events from the replaced provider epoch are ignored rather than admitted',
  )
})

test('a banner click at the exact deadline produces only the expiry-owned fact', async () => {
  const {service, controller, clock, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  clock.advanceTo(360)

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  await new Promise(resolve => setImmediate(resolve))
  const facts = [
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.content === '确认已过期，本次操作已取消。')
  assert.equal(facts.length, 1)
})

test('a confirmation terminal before transcript final retries the same user turn once', async () => {
  const {service, controller, actions, injected, telemetry} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-first',
    provider_item_id: 'first',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-first',
    provider_item_id: 'first',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'response-first'})
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-first',
    status: 'completed',
    reason: '',
  })
  assert.equal(controller.pending, true, 'the proposal remains live')
  assert.equal(service.projectConfirmationBlockingForTest, true)
  assert.equal(actions.includes('ensure-response'), false, 'the transcript is not available yet')
  assert.equal(
    [
      ...injected.map(item => item.content),
      ...service.queuedHostItems().map(item => item.intent.item.content),
    ].some(content => content.includes('请明确说')),
    false,
    'the host does not ask for another unusable utterance',
  )
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'first', text: '确认',
  })
  assert.equal(actions.filter(action => action === 'ensure-response').length, 1)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'response-retry'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'confirm-retry',
    item_id: 'function-retry', response_id: 'response-retry',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.ok(telemetry.some(record => record.kind === 'project_confirmation.decision_retry_requested'))
})

test('a tool-first terminal confirmation delivers its host acknowledgement without another turn', async () => {
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-tool-terminal-first',
    provider_item_id: 'tool-terminal-first-user',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-tool-terminal-first',
    provider_item_id: 'tool-terminal-first-user',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'tool-terminal-first-response',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    response_id: 'tool-terminal-first-response',
    call_id: 'tool-terminal-first-confirm',
    item_id: 'tool-terminal-first-function',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(actions.includes('commit'), false, 'the call waits for its user origin')

  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'tool-terminal-first-response',
    status: 'completed',
    reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'tool-terminal-first-user',
    text: '确认',
  })

  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(actions.filter(action => action === 'ensure-response').length, 0)
  assert.equal(
    injected.filter(item => item.content === '已确认，已提交并正在启动。').length,
    1,
    'the idle floor receives exactly one acknowledgement in the same event pass',
  )
  assert.equal(
    service.queuedHostItems().some(item => (
      item.intent.item.content === '已确认，已提交并正在启动。'
    )),
    false,
    'the acknowledgement does not wait for another user turn or progress event',
  )
})

test('a settled tool-first confirmation cannot consume the next proposal retry', async () => {
  const {service, controller, actions, injected, views} = realtimeServiceHarness('confirmation')
  await service.connect()
  const firstProposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-first-tool-terminal', provider_item_id: 'first-tool-terminal-user',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-first-tool-terminal', provider_item_id: 'first-tool-terminal-user',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'first-tool-terminal-response',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    response_id: 'first-tool-terminal-response',
    call_id: 'first-tool-terminal-confirm', item_id: 'first-tool-terminal-function',
    name: 'confirm',
    arguments: {id: firstProposal.proposal_id, accepted: true},
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'first-tool-terminal-response', status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'first-tool-terminal-user', text: '确认',
  })
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(actions.filter(action => action === 'ensure-response').length, 0)
  assert.equal(
    injected.filter(item => item.content === '已确认，已提交并正在启动。').length,
    1,
    'the first acknowledgement was injected before its provider response starts',
  )
  assert.equal(actions.filter(action => action === 'create:host_fact').length, 1)
  assert.equal(
    service.queuedHostItems().some(item => (
      item.intent.item.content === '已确认，已提交并正在启动。'
    )),
    false,
    'the first acknowledgement is not merely waiting in the host queue',
  )

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'first-ack-response',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'first-ack-response', status: 'completed', reason: '',
  })

  const secondProposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'second-confirmation-user',
    responseId: 'second-confirmation-response',
    transcript: '确认',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'second-confirmation-response', status: 'completed', reason: '',
  })
  assert.equal(
    actions.filter(action => action === 'ensure-response').length,
    1,
    'the second proposal owns a fresh retry record',
  )

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'second-retry-response',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'second-retry-response', status: 'completed', reason: '',
  })
  assert.equal(controller.pending, true, 'the second proposal remains available in the banner')
  assert.equal(views.at(-1)?.pending_confirmation, true, 'the banner still exposes that proposal')

  await confirmationTurn(service, {
    proposalId: secondProposal.proposal_id,
    confirmed: false,
    callId: 'second-proposal-cancel',
    itemId: 'second-proposal-cancel-user',
    responseId: 'second-proposal-cancel-response',
    transcript: '取消',
  })
  assert.match(
    injected.find(item => item.call_id === 'second-proposal-cancel')?.content ?? '',
    /cancelled/u,
    'a later voice turn can still settle the second proposal',
  )
  assert.equal(views.at(-1)?.pending_confirmation, false, 'the observable banner is cleared')
})

test('a deduplicated confirmation output does not settle the user response debt', async () => {
  const duplicateId = 'duplicate-confirmation-output'
  const {service, controller, actions, injected} = realtimeServiceHarness('confirmation', {
    idFactory: () => duplicateId,
  })
  await service.connect()
  await service.session.injectToolOutput({
    kind: 'tool_output',
    host_item_id: 'seed-host-item',
    event_id: duplicateId,
    call_id: 'seed-call',
    content: '{}',
  })
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-deduplicated-output', provider_item_id: 'user-deduplicated-output',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-deduplicated-output', provider_item_id: 'user-deduplicated-output',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'response-deduplicated-output',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    response_id: 'response-deduplicated-output',
    call_id: 'confirm-deduplicated-output', item_id: 'function-deduplicated-output',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-deduplicated-output',
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-deduplicated-output', text: '确认',
  })

  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(
    actions.filter(action => action === `inject:${duplicateId}`).length,
    1,
    'only the seed output reached the provider',
  )
  assert.equal(
    injected.filter(item => item.content === '已确认，已提交并正在启动。').length,
    0,
    'the acknowledgement cannot run ahead of a tool output the provider did not receive',
  )
  assert.ok(
    service.queuedHostItems().some(item => (
      item.intent.item.content === '已确认，已提交并正在启动。'
    )),
    'the unresolved user-response debt keeps the acknowledgement queued',
  )
})

for (const status of ['cancelled', 'failed'] as const) {
  test(`a silent ${status} confirmation terminal preserves the same-turn retry`, async () => {
    const {service, controller, actions} = realtimeServiceHarness('confirmation')
    await service.connect()
    propose(controller)
    await service.handleEvent({
      kind: 'user_speech_started', session_epoch: 1,
      speech_id: `speech-${status}`, provider_item_id: `item-${status}`,
    })
    await service.handleEvent({
      kind: 'user_speech_ended', session_epoch: 1,
      speech_id: `speech-${status}`, provider_item_id: `item-${status}`,
    })
    await service.handleEvent({
      kind: 'response_started', session_epoch: 1, response_id: `response-${status}`,
    })
    await service.handleEvent({
      kind: 'response_terminal', session_epoch: 1, response_id: `response-${status}`,
      status, reason: status,
    })
    assert.equal(controller.pending, true)
    assert.equal(service.projectConfirmationBlockingForTest, true)
    await service.handleEvent({
      kind: 'user_transcript_final', session_epoch: 1,
      item_id: `item-${status}`, text: '确认',
    })
    assert.equal(actions.filter(action => action === 'ensure-response').length, 1)
  })
}

test('one empty confirmation retry releases voice isolation but keeps the banner actionable', async () => {
  const {service, controller, actions, injected, telemetry} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'empty-answer',
    responseId: 'empty-first-response',
    transcript: '确认',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'empty-first-response',
    status: 'completed', reason: '',
  })
  assert.equal(actions.filter(action => action === 'ensure-response').length, 1)
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'empty-retry-response',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'empty-retry-response',
    status: 'completed', reason: '',
  })

  assert.equal(controller.pending, true, 'the proposal and its banner remain available for a click')
  assert.equal(service.projectConfirmationBlockingForTest, false, 'voice isolation no longer hangs')
  assert.equal(
    [
      ...injected.map(item => item.content),
      ...service.queuedHostItems().map(item => item.intent.item.content),
    ].some(content => content.includes('请明确说')),
    false,
  )
  assert.ok(telemetry.some(record => (
    record.kind === 'project_confirmation.decision_retry_exhausted'
  )))
})

test('a confirmation response that already spoke gets no duplicate retry prompt', async () => {
  const {service, controller, injected} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'spoken-answer',
    responseId: 'spoken-response',
    transcript: '我还在想',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'spoken-response',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = service.session.currentGeneration
  assert.ok(generation !== null)
  assert.equal(service.playbackStarted(generation.utterance_id, generation.generation_epoch), true)
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'spoken-response',
    status: 'completed',
    reason: '',
  })

  assert.equal(
    [
      ...injected.map(item => item.content),
      ...service.queuedHostItems().map(item => item.intent.item.content),
    ].some(content => content.includes('我没有确认清楚')),
    false,
  )
})

test('a silent confirmation terminal at expiry cannot offer an impossible retry', async () => {
  const {service, controller, injected, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'expiring-answer',
    responseId: 'expiring-response',
    transcript: '我还在想',
  })
  clock.advanceTo(360)
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'expiring-response',
    status: 'completed',
    reason: '',
  })

  assert.equal(controller.pending, false)
  assert.equal(
    [
      ...injected.map(item => item.content),
      ...service.queuedHostItems().map(item => item.intent.item.content),
    ].some(content => content.includes('我没有确认清楚')),
    false,
  )
})

test('the confirmation function may arrive before its user transcript', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-tool-first',
    provider_item_id: 'tool-first-user',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-tool-first',
    provider_item_id: 'tool-first-user',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'tool-first-response',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    response_id: 'tool-first-response',
    call_id: 'tool-first-confirm',
    item_id: 'tool-first-function',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(actions.includes('commit'), false, 'the call waits for its user origin')
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'tool-first-user',
    text: '确认',
  })

  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('a tool call in a blocked turn is refused and answered', async () => {
  // The model must not act inside the very turn whose answer it is supposed to be waiting for -- and a
  // refused call still owes the provider a terminal result, or the protocol stalls.
  const {service, actions, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  const before = service.toolCallAcceptances().length
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'do something'},
    response_id: 'r-1',
  })
  assert.equal(service.toolCallAcceptances().length, before, 'never admitted')
  assert.ok(
    actions.some(action => action.startsWith('inject:id-')),
    'but the provider got a terminal result',
  )
})

test('a user utterance with no item id cancels rather than waiting for an answer it cannot attribute', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: null,
  })
  assert.equal(controller.pending, false, 'the proposal is gone')
  assert.ok(toldAboutConfirmation(service, actions))
})

test('a failed transcript cancels the confirmation', async () => {
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_failed',
    session_epoch: 1,
    item_id: 'user-item-1',
  })
  assert.equal(controller.pending, false)
})

test('a banner decision reconnects when its quarantined carrier never reaches terminal', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {
    itemId: 'banner-timeout-item',
    responseId: 'banner-timeout-response',
  })

  await service.projectConfirmationDecision(proposal.proposal_id, true)
  clock.advanceTo(3)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(actions.filter(action => action.startsWith('connect:')).length, 2)
})

test('a reconnect invalidates a pending proposal', async () => {
  // It described a provider session that no longer exists, so confirming it would commit against a
  // context the user never saw.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  assert.equal(controller.pending, true)
  await service.reconnectForTest()
  assert.equal(controller.pending, false, 'invalidated by the reconnect')
})

test('closing the service drops the proposal and stops observing expiry', async () => {
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.close()
  assert.equal(controller.pending, false)
})

test('the project view is published on every state change', async () => {
  // The renderer has no other way to learn a confirmation is pending, or that it stopped being.
  const {service, controller, views} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await confirmationTurn(service, {proposalId: proposal.proposal_id, confirmed: true})
  assert.ok(views.length > 0, 'the renderer was told')
  assert.equal(views.at(-1)?.pending_confirmation, false, 'and told it is over')
})

test('a duplicate transcript for a closing item does not confirm twice', async () => {
  // A second delivery of the same words must not confirm something the first delivery already handled.
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  const commits = actions.filter(action => action === 'commit').length
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  assert.equal(actions.filter(action => action === 'commit').length, commits, 'committed once')
})

test('an expiry cleans up and tells the user, without leaving the block set', async () => {
  // Cleanup involves provider I/O and possibly a reconnect, so it is batched onto its own task -- and
  // if it left the block set, every later turn would be refused.
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true, 'the proposal lapsed')
  // Let the drain task run.
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.ok(toldAboutConfirmation(service, actions), 'the user is told it lapsed')
  assert.equal(service.projectConfirmationBlockingForTest, false, 'and nothing stays blocked')
})

test('reserving does nothing when no proposal is pending', () => {
  // Every user utterance reaches this. Reserving without a proposal would arm a fence and start
  // blocking tool calls for a confirmation that does not exist.
  return (async (): Promise<void> => {
    const {service, controller} = realtimeServiceHarness('confirmation')
    await service.connect()
    assert.equal(controller.pending, false)
    await service.handleEvent({
      kind: 'user_speech_started',
      session_epoch: 1,
      speech_id: 'speech-1',
      provider_item_id: 'user-item-1',
    })
    assert.equal(
      service.projectConfirmationBlockingForTest,
      false,
      'no proposal, so nothing is blocked',
    )
  })()
})

test('a confirmation answer response stays alive long enough to emit its decision', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-answer',
    provider_item_id: 'user-answer',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-answer',
    provider_item_id: 'user-answer',
  })

  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-answer',
  })
  assert.equal(
    actions.includes('cancel:response-answer'),
    false,
    'Qwen emits response.created before the confirmation function and must remain alive',
  )

  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-answer',
    text: '同意',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-answer',
    item_id: 'function-answer',
    response_id: 'response-answer',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.includes('cancel:response-answer'), true)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('a confirmation response created before speech end remains tool-only and can commit', async () => {
  const {service, controller, actions, telemetry} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)

  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-overlap',
    provider_item_id: 'user-overlap',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-overlap',
  })
  assert.equal(actions.includes('cancel:response-overlap'), false)
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-overlap',
    provider_item_id: 'user-overlap',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-overlap',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-overlap',
    item_id: 'function-overlap',
    response_id: 'response-overlap',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.includes('cancel:response-overlap'), true)
  assert.equal(actions.filter(action => action === 'commit').length, 1)
  assert.equal(controller.pending, false)
  assert.deepEqual(telemetry.find(record => (
    record.kind === 'project_confirmation.response_started'
  )), {
    kind: 'project_confirmation.response_started',
    payload: {
      session_epoch: 1,
      response_id: 'response-overlap',
      accepted: true,
      started_during_user_speech: true,
      fence_pending: false,
      origin_bound: true,
      confirmation_item_count: 1,
      proposal_id: proposal.proposal_id,
      proposal_origin_ref: 'conversation:1',
      delegate_origin_ref: 'conversation:1',
      user_input_revision: 1,
      item_id: 'user-overlap',
    },
  })
  assert.ok(telemetry.some(record => (
    record.kind === 'user_origin.item_registered'
    && record.payload.user_input_revision === 1
    && record.payload.item_id === 'user-overlap'
  )))
  assert.ok(telemetry.some(record => (
    record.kind === 'user_origin.response_binding'
    && record.payload.response_id === 'response-overlap'
    && record.payload.item_id === 'user-overlap'
  )))
  assert.ok(telemetry.some(record => (
    record.kind === 'user_origin.transcript_resolution'
    && record.payload.origin_ref === 'conversation:1'
    && record.payload.status === 'resolved'
  )))
})

test('an unbound confirmation call fails visibly and releases the proposal for a retry', async () => {
  const {service, controller, actions, injected, diagnostics, telemetry} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)

  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-unbound',
    provider_item_id: 'user-unbound',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-unbound',
    provider_item_id: 'user-unbound',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-unbound',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-unbound',
    item_id: 'function-unbound',
    response_id: 'response-without-start',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.includes('commit'), false, 'an unbound call never authorizes a commit')
  assert.equal(controller.pending, true, 'the proposal remains available for a fresh answer')
  assert.deepEqual(service.confirmationItemsForTest, [], 'the stale answer no longer owns the proposal')
  assert.match(
    diagnostics.find(line => line.includes('project_confirmation_binding_missing')) ?? '',
    /response_id=response-without-start.*origin_item_bound=false.*recovered=true/u,
  )
  assert.deepEqual(telemetry.find(record => (
    record.kind === 'project_confirmation.binding_missing'
  )), {
    kind: 'project_confirmation.binding_missing',
    payload: {
      session_epoch: 1,
      call_id: 'confirm-unbound',
      response_id: 'response-without-start',
      active_response_id: 'none',
      response_phase: 'unknown',
      response_fenced: false,
      origin_item_bound: false,
      pending: true,
      recovered: true,
      proposal_id: proposal.proposal_id,
      proposal_origin_ref: 'conversation:1',
      delegate_origin_ref: 'conversation:1',
      user_input_revision: -1,
      item_id: 'none',
    },
  })
  const retryPrompt = '我没能把这次语音和确认请求关联起来；请再说一次“确认”或“取消”。'
  assert.equal(
    [
      ...injected.map(item => item.content),
      ...service.queuedHostItems().map(item => item.intent.item.content),
    ].filter(content => content === retryPrompt).length,
    1,
  )

  await confirmationTurn(service, {
    proposalId: proposal.proposal_id,
    confirmed: true,
    itemId: 'user-retry',
    responseId: 'response-retry',
    callId: 'confirm-retry',
    transcript: '确认',
  })
  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('a fenced stale question cannot consume the reserved confirmation answer', async () => {
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  service.queueHostItem(guardFact('confirmation-question-pending'), {priority: 50})
  await service.flushHostItems()

  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-answer',
    provider_item_id: 'user-answer',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-answer',
    provider_item_id: 'user-answer',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-stale-question',
  })
  assert.ok(actions.includes('cancel:response-stale-question'))
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-stale-question',
    status: 'cancelled',
    reason: 'cancelled',
  })

  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-answer',
  })
  assert.equal(actions.includes('cancel:response-answer'), false)
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-answer',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-answer',
    item_id: 'function-answer',
    response_id: 'response-answer',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })

  assert.equal(actions.filter(action => action === 'commit').length, 1)
})

test('reserving arms a fence so the question is not spoken over', async () => {
  // A host-requested question that has not started is stale once the user begins answering it.
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  service.queueHostItem(guardFact('confirmation-question-pending'), {priority: 50})
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // The already-requested question is cancelled rather than allowed to speak over the answer.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  assert.ok(actions.includes('cancel:r-1'), 'the next turn was fenced')
})

test('a confirmation blocks tool calls across the whole epoch, not just one response', async () => {
  // A reconnect renumbers responses. Keying the block only by response would let a confirmation
  // spanning one stop blocking, and the model would act inside the turn that is meant to be waiting.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  const before = service.toolCallAcceptances().length
  // A *different* response in the same epoch is blocked too.
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-2',
    item_id: 'tool-2',
    name: 'codex__run',
    arguments: {work_order: 'do something'},
    response_id: 'r-9',
  })
  assert.equal(service.toolCallAcceptances().length, before, 'blocked by epoch')
})

test('one refused call gets exactly one terminal output', async () => {
  // Two terminal outputs for the same function call is a protocol violation, and both the expiry
  // cleanup and a provider event can reach the same call.
  const {service, controller, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  const call = {
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'do something'},
    response_id: 'r-1',
  } as const
  await service.handleEvent(call)
  const first = actions.filter(action => action.startsWith('inject:id-')).length
  // The same call again -- a retried delivery, which the provider does.
  await service.handleEvent(call)
  assert.equal(
    actions.filter(action => action.startsWith('inject:id-')).length,
    first,
    'answered once',
  )
})

test('a confirmation fact never outranks the user', async () => {
  // Nothing the host says may claim precedence over the person in the room, however urgent.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '取消')
  for (const item of service.queuedHostItems()) {
    if (!item.intent.item.event_id.startsWith('project-confirmation:')) continue
    assert.ok(item.priority < 100, `priority ${item.priority} must stay below the user`)
    assert.equal(item.preemptive, false, 'and it does not interrupt')
  }
})

test('a view observer that throws does not break the state change that produced it', () => {
  // The renderer's failure is not the confirmation's to propagate: by the time the view is published,
  // the decision has already been made.
  const manifest = executorManifestSchema.parse({
    name: 'codex',
    display_name: 'Codex',
    roles: ['coding'],
    policy: {
      channel: 'codex',
      priority: 50,
      wake: 'fast',
      typical_latency: 5,
      compress_watermark: 8,
    },
    ops: [{
      name: 'look',
      description: 'readonly',
      params: {type: 'object', properties: {}, additionalProperties: false},
      readonly: true,
      deadline_budget: 5,
    }],
  })
  const clock = new VirtualClock()
  const memory = new Memory({policies: [manifest.policy]})
  const executors = new Map([[manifest.name, {manifest}]])
  let ids = 0
  const nextId = (): string => `id-${++ids}`
  const controller = new ProjectConfirmationController({clock, idFactory: nextId})
  const service = new RealtimeService({
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      clock,
      executors,
      memory,
      observe: () => unsubscribeNothing,
      serve: () => new Promise<void>(() => undefined),
      claimedHandoff: () => undefined,
      terminatedByDeadline: () => false,
      delegateFor: () => undefined,
      inFlightDelegate: () => undefined,
    },
    tools: compileToolSchema([manifest]),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: () => Promise.reject(new Error('unused')),
        dispatchExternal: () => ({accepted: false, delegate_id: null}),
      },
      tools: compileToolSchema([manifest]),
      idFactory: nextId,
    }),
    idFactory: nextId,
    projectConfirmation: controller,
    onProjectView: () => {
      throw new Error('renderer is gone')
    },
    onDiagnostic: () => undefined,
  })
  propose(controller)
  // Invalidation publishes the view; a throwing observer must not stop the invalidation.
  assert.doesNotThrow(() => service.invalidateProjectConfirmationForTest('test'))
  assert.equal(controller.pending, false, 'the proposal is still gone')
})

test('an expiry reconnects while a pending confirmation question fence remains', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  service.queueHostItem(guardFact('confirmation-question-pending'), {priority: 50})
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  const connects = actions.filter(action => action.startsWith('connect:')).length
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true, 'past the deadline')
  for (let index = 0; index < 30; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.ok(
    actions.filter(action => action.startsWith('connect:')).length > connects,
    'the pending-question fence forced a reconnect',
  )
  // The reserved item is released. The block itself legitimately persists here, because the armed fence
  // was never spent -- the user never finished speaking -- and an unspent fence is still holding the
  // question open. That distinction is what `_end_project_confirmation_close` encodes.
  assert.deepEqual(service.confirmationClosingItemsForTest, [], 'the item is no longer closing')
})

test('an expiry reconnects when a requested confirmation retry still has no response id', async () => {
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'expiry-retry-speech', provider_item_id: 'expiry-retry-item',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'expiry-retry-speech', provider_item_id: 'expiry-retry-item',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'expiry-retry-source',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'expiry-retry-source',
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'expiry-retry-item', text: '确认',
  })
  assert.equal(actions.filter(action => action === 'ensure-response').length, 1)
  const connects = actions.filter(action => action.startsWith('connect:')).length

  clock.advanceTo(400)
  assert.equal(controller.expire(), true)
  for (let index = 0; index < 30; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.ok(actions.filter(action => action.startsWith('connect:')).length > connects)
})

test('a terminal releases the response from the confirmation block', async () => {
  // Otherwise the block outlives the turn it was about, and every later call in the epoch is refused
  // for a confirmation that has already been answered.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  assert.ok(service.confirmationResponsesForTest.length > 0, 'the response is recorded')
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  assert.deepEqual(
    service.confirmationResponsesForTest,
    [],
    'and released when the turn ends',
  )
})

test('a settled confirmation stops blocking, so later turns work again', async () => {
  // The block has to lift completely. An item left in either set, or a fence left pending, would refuse
  // every tool call for the rest of the session — the agent would appear to work and quietly do nothing.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'confirm-1',
    item_id: 'function-1',
    response_id: 'r-1',
    name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true},
  })
  assert.equal(controller.pending, false, 'the proposal is settled')
  assert.deepEqual(service.confirmationItemsForTest, [], 'no item reserved')
  assert.deepEqual(service.confirmationClosingItemsForTest, [], 'and none closing')
  assert.equal(
    service.projectConfirmationBlockingForTest,
    false,
    'so nothing is blocked any more',
  )
})

test('a transcript alone keeps its confirmation item reserved', async () => {
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // No response has produced a structured decision yet.
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  assert.deepEqual(service.confirmationItemsForTest, ['1:user-item-1'], 'the item stays reserved')
  assert.equal(
    service.projectConfirmationBlockingForTest,
    true,
    'the undecided reserved item still holds the block',
  )
})

test('a response cannot lift a still-undecided confirmation item', async () => {
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  // Transcript text is evidence only; the structured decision has not arrived.
  assert.equal(service.projectConfirmationBlockingForTest, true)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  assert.equal(
    service.projectConfirmationBlockingForTest,
    true,
    'the response started but the undecided item still blocks',
  )
})

test('a response recorded while blocking keeps blocking its own epoch after the block lifts', async () => {
  // The narrow window the epoch-wide scan exists for: the items have cleared and the fence is spent, but
  // a response that was blocked is still running. A call in it must still be refused, or the model gets
  // to act inside the turn it was told to wait in.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'confirm-1', item_id: 'function-1',
    name: 'confirm', arguments: {
      id: proposal.proposal_id, accepted: true,
    }, response_id: 'r-1',
  })
  assert.equal(service.projectConfirmationBlockingForTest, false, 'the block has lifted')
  assert.deepEqual(service.confirmationResponsesForTest, ['1:r-1'], 'but r-1 is still recorded')

  const before = service.toolCallAcceptances().length
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-late',
    item_id: 'tool-late',
    name: 'codex__run',
    arguments: {work_order: 'sneak in'},
    response_id: 'r-1',
  })
  assert.equal(service.toolCallAcceptances().length, before, 'still refused')
})

test('after the block lifts, a call in any response of that epoch is still refused', async () => {
  // What the epoch-wide scan is for, isolated. A call on a response the confirmation never saw start is
  // caught by neither the exact-key check nor the blocking flag -- only by the epoch.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'confirm-1', item_id: 'function-1',
    name: 'confirm', arguments: {
      id: proposal.proposal_id, accepted: true,
    }, response_id: 'r-1',
  })
  assert.equal(service.projectConfirmationBlockingForTest, false, 'the block has lifted')

  const before = service.toolCallAcceptances().length
  // A different response id, never started, never recorded.
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-other',
    item_id: 'tool-other',
    name: 'codex__run',
    arguments: {work_order: 'different response'},
    response_id: 'r-77',
  })
  assert.equal(
    service.toolCallAcceptances().length,
    before,
    'refused because the epoch is still tainted',
  )
})

test('a tool call arriving while blocked taints its own response for later calls', async () => {
  // The recording in the block check, isolated. A response that never emitted `response_started` while
  // blocking is only known from the tool call that arrived on it -- and once that is refused, every
  // later call on the same response has to be refused too.
  const {service, controller} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'first'},
    response_id: 'r-5',
  })
  assert.ok(
    service.confirmationResponsesForTest.includes('1:r-5'),
    'the response is recorded from the call itself',
  )
})

test('an expiry in flight cannot reconnect after the service is closed', async () => {
  // A promise cannot be cancelled, so the continuations check the signal instead. Without that, an
  // expiry chain resuming after `close` returned would reconnect a provider the service has released.
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation')
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true)
  // Close immediately, before the drain has had a turn.
  await service.close()
  const connectsAfterClose = actions.filter(action => action.startsWith('connect:')).length
  // Give the drain every chance to resume.
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    connectsAfterClose,
    'no reconnect after close',
  )
  // The items are still released, so a restarted service is not blocked by them.
  assert.deepEqual(service.confirmationClosingItemsForTest, [])
})

test('a cancelled commit propagates instead of being reported as a failed operation', async () => {
  // The caller is trying to stop or replace this. Reporting "已确认，但操作未执行。" would publish an
  // authoritative outcome that contradicts the cancellation.
  const aborted = new Error('operation aborted')
  aborted.name = 'AbortError'
  const {service, controller} = realtimeServiceHarness('confirmation', {commit: () => Promise.reject(aborted)})
  await service.connect()
  const proposal = propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'user-item-1', text: '确认',
  })
  await assert.rejects(
    () => service.handleEvent({
      kind: 'tool_call_ready', session_epoch: 1, call_id: 'confirm-1', item_id: 'function-1',
      name: 'confirm', arguments: {
        id: proposal.proposal_id, accepted: true,
      }, response_id: 'r-1',
    }),
    /operation aborted/u,
    'the cancellation reaches the caller',
  )
})

test('an expiry that outlives the shutdown grace period still cannot reconnect', async () => {
  // `close` waits for the drain, but only boundedly — a provider that never answers makes the drain
  // outlive it. That is exactly when the signal checks inside the drain are the only thing left
  // stopping a stopped service from reconnecting.
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation', {
    hangInjection: true,
    // Milliseconds rather than the five-second default: what this test is about is what happens after a
    // step is abandoned, and waiting five real seconds for it would be waiting on the clock, not the code.
    expiryStepTimeoutMs: 5,
  })
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // A deferred call for this epoch, so the expiry has provider work to do.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true)
  // Let the drain reach its first hanging injection.
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await service.close()
  const connects = actions.filter(action => action.startsWith('connect:')).length
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 40))
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    connects,
    'a stopped service does not reconnect, however late the drain resumes',
  )
})

test('an abandoned confirmation cleanup cannot block a later expiry batch', async () => {
  const {service, controller, injected, clock} = realtimeServiceHarness('confirmation', {
    hangInjection: true,
    expiryStepTimeoutMs: 5,
  })
  const waitUntil = async (ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + 1000
    while (!ready() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'stuck-speech', provider_item_id: 'stuck-user',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'stuck-speech', provider_item_id: 'stuck-user',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'stuck-r'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'stuck-call', item_id: 'stuck-tool', response_id: 'stuck-r',
    name: 'codex__run', arguments: {work_order: 'deferred'},
  })

  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'confirmation-speech', provider_item_id: 'confirmation-user',
  })
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true)
  await waitUntil(() => injected.some(item => item.content === '确认已过期，本次操作已取消。'))
  const firstExpiryEvents = new Set(injected
    .filter(item => item.content === '确认已过期，本次操作已取消。')
    .map(item => item.event_id))
  assert.equal(firstExpiryEvents.size, 1)

  propose(controller)
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true)
  await waitUntil(() => new Set([
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.content === '确认已过期，本次操作已取消。').map(item => item.event_id)).size === 2)
  const expiryEvents = new Set([
    ...injected,
    ...service.queuedHostItems().map(item => item.intent.item),
  ].filter(item => item.content === '确认已过期，本次操作已取消。')
    .map(item => item.event_id))
  assert.equal(expiryEvents.size, 2, 'the later lifecycle reaches its own expiry fact')
  await service.close()
})

test('a shutdown mid-cleanup stops the expiry before it reconnects', async () => {
  // The inner signal checks, isolated. They matter when the drain is *already* inside cleanup when the
  // service closes: `close` waits only boundedly, so a step that hangs leaves the rest of the chain to
  // resume later — and without the checks it would reconnect a provider the service has released.
  //
  // The shape needed is a tool call deferred *before* the proposal exists, because once a confirmation
  // is pending its calls are blocked and closed rather than deferred.
  const {service, controller, actions, clock} = realtimeServiceHarness('confirmation', {
    hangInjection: true,
    expiryStepTimeoutMs: 5,
  })
  await service.connect()
  // A user turn with no proposal: nothing is reserved, so the call that follows is merely deferred.
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'deferred'},
    response_id: 'r-1',
  })

  // Now a proposal, reserved by a second turn.
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-2',
    provider_item_id: 'user-item-2',
  })
  clock.advanceTo(clock.now() + 400)
  assert.equal(controller.expire(), true)

  // Let the drain reach the hanging close of that deferred call, then close during it.
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await service.close()
  const connects = actions.filter(action => action.startsWith('connect:')).length
  // Past the step timeout, so the chain resumes with the service already stopped.
  await new Promise<void>(resolve => setTimeout(resolve, 60))
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    connects,
    'the resumed chain does not reconnect a stopped service',
  )
})

test('executor approval cannot use host, unknown, or mismatched provider evidence', async t => {
  const origins: ResponseOrigin[] = [
    {kind: 'host_request', host_item_id: 'host-approval'},
    {kind: 'unknown'},
    {kind: 'user_item', item_id: 'different-user'},
    {kind: 'user_item', item_id: 'approval-user'},
  ]
  for (const origin of origins) await t.test(JSON.stringify(origin), async () => {
    const {service, executorApproval} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
    assert.ok(executorApproval !== null)
    await service.connect()
    const waiting = offerCodexCommand(executorApproval)
    const approvalId = executorApproval.view.pending_approval_id!
    await beginExecutorApprovalCarrier(service, {
      itemId: 'approval-user', responseId: 'approval-response', origin,
    })
    await emitExecutorApprovalFunction(service, {
      approvalId, approved: true, responseId: 'approval-response',
    })
    const matches = origin.kind === 'user_item' && origin.item_id === 'approval-user'
    assert.equal(executorApproval.pending, !matches)
    if (!matches) assert.equal(service.executorApprovalDecision(approvalId, false), true)
    assert.deepEqual(await waiting, {decision: matches ? 'accept' : 'decline'})
  })
})

test('explicit wrong origin cannot acquire approval authority through final-only provisional binding', async () => {
  const {service, executorApproval, injectedContents} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval !== null)
  await service.connect()
  const waiting = offerCodexCommand(executorApproval)
  const approvalId = executorApproval.view.pending_approval_id!
  await finishExecutorApprovalQuestion(service, 'origin-question')
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin-provisional',
    origin: {kind: 'user_item', item_id: 'different-item'}})
  await service.handleEvent({kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'actual-item', text: '批准'})
  await emitExecutorApprovalFunction(service, {approvalId, approved: true, responseId: 'origin-provisional'})
  assert.equal(executorApproval.pending, true)
  assert.equal(injectedContents.some(content => content.includes('approval_accepted')), false)
  assert.equal(service.executorApprovalDecision(approvalId, false), true)
  assert.deepEqual(await waiting, {decision: 'decline'})
})
