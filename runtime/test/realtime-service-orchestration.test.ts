import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { RealtimeService } from '../src/realtime/service.js'
import type { RealtimeSession } from '../src/realtime/session.js'
import { emptyStream,hostFact,parkedStream,queueOnlyOptions,realtimeServiceHarness,speak,twoTurns } from './realtime-service-harness.js'

test('the stop flag is a real AbortSignal, because the runtime registers a listener on it', async () => {
  // The finding this test exists for: a look-alike carrying only `aborted` throws
  // `TypeError: addEventListener is not a function` inside `serve`, which the task guard then reports
  // as a provider failure -- so the service would stop on its first `start()`.
  let received: AbortSignal | undefined
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {
      connect: () => Promise.resolve(),
    } as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => {
        received = signal
        // Exactly what CausalRuntime.serve does first.
        signal.addEventListener('abort', () => undefined, {once: true})
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  assert.ok(received instanceof AbortSignal, 'the runtime must be handed a real AbortSignal')
  assert.equal(service.stopped, false, 'start must not have tripped the failure path')
  await service.close()
  assert.equal(service.stopped, true)
  assert.equal(received.aborted, true, 'close must abort the signal the runtime is watching')
})

test('start after close works, because the stop flag is replaced rather than reset', async () => {
  // An AbortController cannot be un-aborted, so a service that kept one would never start again.
  const signals: AbortSignal[] = []
  const options = {
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
  }
  const service = new RealtimeService({
    ...options,
    runtime: {
      ...options.runtime,
      serve: (signal: AbortSignal) => {
        signals.push(signal)
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  await service.close()
  await service.start()
  assert.equal(signals.length, 2)
  assert.equal(signals[0]!.aborted, true)
  assert.equal(signals[1]!.aborted, false, 'the second run gets a signal that is not already aborted')
  assert.equal(service.stopped, false)
  await service.close()
})

test('delivery wakeups do not retain abort listeners for the lifetime of the run', async () => {
  let runSignal: AbortSignal | undefined
  const options = queueOnlyOptions()
  const service = new RealtimeService({
    ...options,
    session: {
      connect: () => Promise.resolve(),
      releaseStaleUserHold: () => false,
      foregroundIdle: false,
      floor: {state: 'idle'},
    } as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: (signal: AbortSignal) => parkedStream(signal),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...options.runtime,
      serve: (signal: AbortSignal) => {
        runSignal = signal
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  assert.ok(runSignal !== undefined)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const baseline = getEventListeners(runSignal, 'abort').length

  for (let index = 0; index < 12; index += 1) {
    service.queueHostItem({
      kind: 'host_fact',
      item: {
        kind: 'final',
        host_item_id: `listener-host-${index}`,
        event_id: `listener-event-${index}`,
        content: 'queued while the fake floor stays closed',
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }

  assert.equal(getEventListeners(runSignal, 'abort').length, baseline)
  await service.close()
})

test('close returns even when a task stays parked, and says so', async () => {
  // A JavaScript promise cannot be cancelled the way an asyncio task can. A loop that ignored its
  // abort signal would make `close` wait forever, and a service that never finishes closing is worse
  // than one that names the task it could not stop.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      // Deliberately ignores the signal.
      serve: () => new Promise<void>(() => undefined),
    },
    onDiagnostic: line => diagnostics.push(line),
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000, 'close must not wait forever')
  assert.equal(service.stopped, true)
  assert.equal(
    diagnostics.some(line => line.includes('shutdown_tasks_abandoned')),
    true,
    'a task that could not be stopped has to be reported, not hidden',
  )
})

test('a provider stream parked at shutdown does not hold close open', async () => {
  // The normal shutdown case: the provider has nothing to say and the iterator is suspended. It gets
  // the stop signal precisely so it can unpark itself.
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: (signal: AbortSignal) => parkedStream(signal),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    onDiagnostic: () => undefined,
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000)
  assert.equal(service.stopped, true)
})

test('a provider close failure is raised, after every task has been dealt with', async () => {
  // A close that failed still has to leave the service disconnected and its tasks stopped, so the
  // failure is held and re-raised at the very end rather than short-circuiting the shutdown.
  let serveAborted = false
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.reject(new Error('transport refused to close')),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          serveAborted = true
          resolve()
        }, {once: true})
      }),
    },
    onDiagnostic: () => undefined,
  })
  await service.start()
  await assert.rejects(() => service.close(), /transport refused to close/u)
  assert.equal(service.stopped, true, 'still stopped')
  assert.equal(serveAborted, true, 'the runtime task was still aborted')
})

test('conversation clear fences synchronously, joins provider ingress, and starts a blank epoch', async () => {
  let markIngestStarted!: () => void
  const ingestStarted = new Promise<void>(resolve => { markIngestStarted = resolve })
  let releaseIngest!: () => void
  const ingestGate = new Promise<void>(resolve => { releaseIngest = resolve })
  let releaseClear!: () => void
  const clearGate = new Promise<void>(resolve => { releaseClear = resolve })
  let markRuntimeClearStarted!: () => void
  const runtimeClearStarted = new Promise<void>(resolve => { markRuntimeClearStarted = resolve })
  let transcriptIngestCompleted = false
  const {service, session, injectedItems} = realtimeServiceHarness('pipeline', {
    beforeTranscriptIngest: async () => {
      markIngestStarted()
      await ingestGate
      transcriptIngestCompleted = true
    },
    clearConversation: async () => {
      markRuntimeClearStarted()
      assert.equal(
        transcriptIngestCompleted,
        true,
        'durable clear waits for the admitted provider event',
      )
      await clearGate
    },
  })
  await service.connect()
  session.registerDelegate('old-delegate', {
    summary: 'old private work order', state: 'running', channel: 'codex',
  })
  service.queueHostItem(hostFact('old-body'))
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1, speech_id: 'speech-clear', provider_item_id: 'user-clear',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1, speech_id: 'speech-clear', provider_item_id: 'user-clear',
  })
  const pendingIngress = service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'user-clear', text: 'old turn',
  })
  await ingestStarted
  const clearing = service.clearConversation()
  try {
    assert.equal(service.clearingConversation, true)
    assert.equal(service.clearConversation(), clearing, 'concurrent callers share one clear')
    service.queueHostItem(hostFact('arrived-after-fence'))

    releaseIngest()
    await runtimeClearStarted
    releaseClear()
    await Promise.all([pendingIngress, clearing])

    assert.equal(service.clearingConversation, false)
    assert.equal(session.sessionEpoch, 2)
    assert.equal(session.userInputRevision, 0)
    assert.deepEqual(session.snapshot().active_delegates, [])
    assert.deepEqual(service.queuedHostItems(), [])
    assert.equal(injectedItems.some(item => item.kind === 'recovery'), false)
  } finally {
    releaseIngest()
    releaseClear()
    await Promise.allSettled([pendingIngress, clearing])
  }
})

test('a failed conversation clear remains fenced and cannot consume old provider input', async () => {
  const {service, session, diagnostics} = realtimeServiceHarness('pipeline', {
    clearConversation: () => Promise.reject(new Error('synthetic durable clear failure')),
  })
  await service.connect()
  const clearing = service.clearConversation()
  assert.equal(service.clearingConversation, true)
  assert.equal(service.clearConversation(), clearing)
  await assert.rejects(clearing, /synthetic durable clear failure/u)
  assert.equal(service.stopped, true, 'failed clear enters the existing fatal service lifecycle')
  await assert.rejects(service.clearConversation(), /not available/u)

  assert.equal(service.clearingConversation, true)
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'stale-user', text: 'must be ignored',
  })
  service.queueHostItem(hostFact('must-not-queue'))
  assert.equal(session.userInputRevision, 0)
  assert.deepEqual(service.queuedHostItems(), [])
  assert.equal(diagnostics.some(line => line.includes('conversation_clear_failed')), true)
})

test('conversation clear drops buffered renderer audio before durable storage finishes', async () => {
  let releaseClear!: () => void
  const clearGate = new Promise<void>(resolve => { releaseClear = resolve })
  let markRuntimeClearStarted!: () => void
  const runtimeClearStarted = new Promise<void>(resolve => { markRuntimeClearStarted = resolve })
  const {service, session, actions} = realtimeServiceHarness('pipeline', {
    clearConversation: async () => {
      markRuntimeClearStarted()
      await clearGate
    },
  })
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'old-response'})
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'old-response', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)

  const clearing = service.clearConversation()
  try {
    assert.equal(
      actions.includes(`clear:${generation!.utterance_id}:${generation!.generation_epoch}`),
      true,
      'the synchronous fence clears audio before waiting on storage',
    )
    await runtimeClearStarted
    releaseClear()
    await clearing
  } finally {
    releaseClear()
    await Promise.allSettled([clearing])
  }
})

test('a task abandoned by one close cannot take down the next run', async () => {
  // A JavaScript promise cannot be cancelled, so a task the previous `close` gave up on can still
  // resolve later. Without scoping the guard to its own run it would read the *replacement*
  // controller, find it un-aborted, and stop a service that had already been restarted.
  const diagnostics: string[] = []
  let resolveStubborn: (() => void) | undefined
  const options = {
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      // Parked, not empty: a stream that ends is a provider that is gone, and the service is right to
      // stop for it -- which would mask what this test is about.
      events: (signal: AbortSignal) => parkedStream(signal),
      close: () => Promise.resolve(),
    },
    onDiagnostic: (line: string) => diagnostics.push(line),
  }
  let call = 0
  const service = new RealtimeService({
    ...options,
    runtime: {
      ...options.runtime,
      serve: (signal: AbortSignal) => {
        call += 1
        if (call === 1) {
          // Ignores the abort, then *fails* after the restart. A clean return from an aborted run is
          // an ordinary shutdown and correctly says nothing; a failure is what would otherwise be
          // charged to whichever run happens to be current.
          return new Promise<void>((_resolve, reject) => {
            resolveStubborn = () => reject(new Error('late failure from an abandoned run'))
          })
        }
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  await service.close()
  await service.start()
  assert.equal(service.stopped, false, 'the second run is live')

  // The abandoned first task finishes now.
  resolveStubborn?.()
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.equal(service.stopped, false, 'the previous run must not stop this one')
  assert.equal(
    diagnostics.some(line => line.includes('task_failure_from_previous_run')),
    true,
    'and it is recorded rather than silently ignored',
  )
  await service.close()
})

test('a provider close that never settles does not block shutdown', async () => {
  // The failure mode a degraded transport actually has. Bounding only the loops left this one able to
  // hold application shutdown open forever.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => new Promise<void>(() => undefined),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    onDiagnostic: line => diagnostics.push(line),
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000, 'close must not wait on the transport forever')
  assert.equal(service.stopped, true)
  assert.equal(
    diagnostics.some(line => line.includes('shutdown_provider_close_abandoned')),
    true,
    'a transport that would not close has to be named',
  )
})

test('a reconnect drops every origin binding from the dead session', async () => {
  // They name items a provider that no longer exists once held. Keeping any of them would let a tool
  // call in the new session cite evidence that session has never seen.
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  assert.equal(service.boundOriginsForTest.length, 1)
  assert.equal(service.unboundUserOriginCountForTest, 0)

  await service.reconnectForTest()
  assert.deepEqual(service.boundOriginsForTest, [], 'no response holds a dead turn')
  assert.equal(service.unboundUserOriginCountForTest, 0, 'nothing waits on a dead transcript')
})

test('a reconnect settles the tool calls of the dead epoch instead of leaving them open', async () => {
  // Nothing in the old epoch can receive a continuation, so a call left `queued` there would wait for
  // a terminal that cannot arrive. Each gets a disposition, and work that actually ran gets an
  // acknowledgement -- it happened, and the user has not heard about it.
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  assert.equal(service.deliveryState().continuationOrder.length, 1, 'one batch open')
  assert.equal(service.toolCallDispositionsForTest[0], null, 'not yet settled')

  await service.reconnectForTest()
  assert.deepEqual(
    service.deliveryState().continuationOrder,
    [],
    'the dead epoch leaves nothing in the queue',
  )
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'abandoned',
    'dispatched work that will not be spoken about is abandoned, not refused',
  )
  // And the acknowledgement reaches the provider, because that work really did start. Checked at the
  // provider rather than in the queue: the reconnect ends with a delivery pass, so anything it queued
  // into an idle floor has already been injected by the time this returns.
  assert.ok(
    actions.includes('inject:background:d-1'),
    'the user is told about work that ran',
  )
})

test('a reconnect requeues an urgent item that was injected but never spoken', async () => {
  // It reached a session that died before speaking it, so the user heard nothing. That is the one case
  // where re-delivering is right rather than a repeat.
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  service.seedUrgentOwnerForTest({sessionEpoch: 1, eventId: 'final:d-9', responseId: null})
  const before = service.urgentOwnerForTest?.delivery_token
  await service.reconnectForTest()
  // At the provider, not in the queue: the reconnect's own delivery pass has already flushed it.
  assert.ok(actions.includes('inject:final:d-9'), 'requeued and delivered')
  // The *old* owner is gone. Delivering into the new session creates a fresh one, which is what keeps
  // the alert's audio attributable there -- so the check is on identity, not on absence.
  const after = service.urgentOwnerForTest
  assert.notEqual(after?.delivery_token, before, 'the dead session\'s owner did not survive')
  assert.equal(after?.session_epoch, service.session.sessionEpoch, 'and any owner belongs to the new one')
})

test('a reconnect does not requeue an urgent item that already had a response', async () => {
  // A response means the provider took it up. Re-queueing would say the same thing twice.
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  service.seedUrgentOwnerForTest({sessionEpoch: 1, eventId: 'final:d-9', responseId: 'r-7'})
  await service.reconnectForTest()
  assert.equal(actions.includes('inject:final:d-9'), false, 'not requeued')
  assert.equal(service.urgentOwnerForTest, null)
})

test('a reconnect that lost the race leaves the live session alone', async () => {
  // Someone else already replaced it. Replacing it again would discard a session that is working.
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  const epoch = service.session.sessionEpoch
  assert.equal(await service.reconnectForTest(epoch + 5), false, 'refused')
  assert.equal(service.session.sessionEpoch, epoch, 'and the session is untouched')
})

test('a reconnect demands an activation, unless the user already spoke into the new session', async () => {
  // A reconnected provider will not speak until something user-shaped arrives. But a user who started
  // talking *during* the reconnect has already activated it, so demanding one would be wrong.
  const quiet = realtimeServiceHarness('pipeline')
  await quiet.service.connect()
  await quiet.service.reconnectForTest()
  assert.equal(
    quiet.service.deliveryState().epochNeedingActivation,
    quiet.service.session.sessionEpoch,
    'the new session needs activating',
  )

  const spoken = realtimeServiceHarness('pipeline')
  await spoken.service.connect()
  await spoken.service.reconnectForTest()
  await spoken.service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: spoken.service.session.sessionEpoch,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  assert.equal(
    spoken.service.deliveryState().epochNeedingActivation,
    null,
    'the user activated it themselves',
  )
})

test('a reconnect blanks speculative captions on both roles', async () => {
  // Partial text from a dead epoch is speculation about a turn that no longer exists. Leaving it on
  // screen would show the user words the new session never said.
  const captions: {readonly role: string; readonly text: string; readonly final: boolean}[] = []
  const {service} = realtimeServiceHarness('pipeline', {onCaption: frame => captions.push(frame)})
  await service.connect()
  await service.reconnectForTest()
  assert.deepEqual(
    captions.map(frame => [frame.role, frame.text, frame.final]),
    [['assistant', '', true], ['user', '', true]],
    'both roles blanked, and marked final so nothing waits for more',
  )
})

test('a batch already spoken before the reconnect keeps its terminal phase', async () => {
  // It was spoken. Marking it abandoned would make the reconnect re-announce work the user already
  // heard about.
  const {service, actions, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  const toolOutputEventId = service.toolCallAcceptances()[0]?.acceptance.host_item.event_id
  assert.notEqual(toolOutputEventId, undefined, 'the tool output crossed the provider boundary')
  // The continuation turn runs to audible renderer completion, so the batch is truly spoken.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-2',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(
    service.playbackStarted(generation!.utterance_id, generation!.generation_epoch),
    true,
  )
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-2',
    status: 'completed',
    reason: '',
  })
  assert.equal(
    service.playbackDone(generation!.utterance_id, generation!.generation_epoch, 250),
    true,
  )
  assert.equal(
    actions.includes(`retire:provider:${toolOutputEventId}`),
    false,
    `hearing a continuation must not delete its function_call_output: ${JSON.stringify(actions)}`,
  )
  assert.equal(
    session.hostEventIsDeduplicated(toolOutputEventId!),
    true,
    'the tool output remains answered after its continuation is heard',
  )
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'completed',
    'spoken, and recorded as completed',
  )
  const injectedBefore = actions.filter(action => action.startsWith('inject:background')).length

  await service.reconnectForTest()
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'completed',
    'the reconnect must not downgrade work that was already spoken',
  )
  assert.equal(
    actions.filter(action => action.startsWith('inject:background')).length,
    injectedBefore,
    'and must not re-announce it',
  )
})

test('an inline-fulfilled call gets no background acknowledgement on reconnect', async () => {
  // Recall answers in the same breath: there is no background work to tell the user about, so an
  // acknowledgement would announce something that never ran. `dispatch` is what distinguishes it, which
  // is why the flag is computed before the disposition is written.
  const {service, actions} = realtimeServiceHarness('pipeline', {includeRecall: true})
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'what did we decide',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'memory__recall',
    arguments: {query: 'decide', scope: 'recent'},
    response_id: 'r-1',
  })
  const accepted = service.toolCallAcceptances()[0]
  assert.equal(accepted?.acceptance.inline_fulfilled, true, 'answered inline')

  await service.reconnectForTest()
  assert.equal(
    actions.some(action => action.startsWith('inject:background:')),
    false,
    'no background acknowledgement for work that never went to the background',
  )
})

test('provider reconnect telemetry has categorical outcomes and never leaks provider errors', async () => {
  const completed = realtimeServiceHarness('pipeline')
  await completed.service.connect()
  assert.equal(await completed.service.reconnectForTest(1), true)
  assert.equal(await completed.service.reconnectForTest(1), false)
  assert.deepEqual(
    completed.telemetry.filter(record => record.kind === 'provider.reconnect'),
    [
      {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'started'}},
      {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'completed'}},
      {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'started'}},
      {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'skipped_epoch'}},
    ],
  )

  const failed = realtimeServiceHarness('pipeline', {failReconnect: true})
  await failed.service.connect()
  await assert.rejects(() => failed.service.reconnectForTest(1), /secret reconnect provider error/u)
  const failureRecords = failed.telemetry.filter(record => record.kind === 'provider.reconnect')
  assert.deepEqual(failureRecords, [
    {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'started'}},
    {kind: 'provider.reconnect', payload: {reason: 'test', outcome: 'failed'}},
  ])
  assert.equal(JSON.stringify(failureRecords).includes('secret reconnect provider error'), false)
})

test('every provider reconnect call site declares one reviewed categorical reason', () => {
  const source = ['service.ts', 'tool-continuations.ts', 'project-confirmation-flow.ts'].map(file => readFileSync(
    resolve(import.meta.dirname, '../../src/realtime', file),
    'utf8',
  )).join('\n')
  for (const reason of [
    'project_confirmation_ui_retry',
    'uncertain_delivery',
    'recoverable_provider_error',
    'origin_resolution_overflow',
    'origin_binding_overflow',
    'refusal_ledger_overflow',
    'project_confirmation_carrier_recovery',
    'project_confirmation_expiry_cleanup',
    'test',
  ]) {
    assert.match(source, new RegExp(`reason: '${reason}'`, 'u'))
  }
  const calls = [...source.matchAll(/(?:#|\.)reconnectProviderSession\(\{(?<options>[\s\S]*?)\}\)/gu)]
  assert.ok(calls.length >= 9)
  for (const call of calls) {
    assert.match(call.groups?.options ?? '', /reason: '/u)
  }
})

test('fatal provider errors settle an admitted user response through the service path', async () => {
  const {service, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  try {
    await speak(service, 'admitted-user', 'Hello')
    assert.equal(await session.requestUserResponse(), true)
    assert.equal(session.providerIdle, false)
    await service.handleEvent({kind: 'provider_error', session_epoch: 1, code: 'unavailable', recoverable: false})
    assert.equal(session.providerIdle, true)
  } finally { await service.close() }
})
