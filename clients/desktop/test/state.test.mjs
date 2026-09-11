import assert from 'node:assert/strict'
import test from 'node:test'

import * as orbState from '../src/renderer/state.mjs'

const { compactOrbLabel, deriveOrbState, ORB_STATE_NAMES, orbDormant } = orbState

const base = {
  booting: false,
  activated: true,
  capture: 'idle',
  playback: 'idle',
  codex: 'idle',
  executorName: 'Codex',
  connected: true,
  permission: 'granted',
  error: '',
  shellExpanded: false,
  audioMode: 'voice_processing_io',
  workspace: '',
  session: '',
  pendingConfirmation: false,
  pendingAction: null,
  pendingWorkspace: '',
  pendingSession: '',
  pendingExpiresInSeconds: null,
}

test('keeps capture playback codex and shell as independent axes', () => {
  const state = deriveOrbState({
    ...base,
    capture: 'listening',
    codex: 'working',
    shellExpanded: true,
  })

  assert.equal(state.name, 'listening')
  assert.match(state.label, /正在聆听/)
  assert.equal(state.codexLabel, '')
  assert.equal(state.shellExpanded, true)
  assert.equal(state.aecLabel, '系统级 AEC')
})

test('projects voice and Codex state into one compact visible line', () => {
  const state = deriveOrbState({
    ...base,
    capture: 'listening',
    codex: 'working',
    workspace: 'alpha',
    session: 'Task 1',
  })

  assert.equal(state.statusLine, '聆听中')
  assert.doesNotMatch(state.statusLine, /工作区|Session|AEC/u)
  assert.equal(state.projectLabel, '工作区 alpha · Session Task 1')
  assert.equal(state.codexMode, 'project')

  const waitingInput = {
    ...base,
    pendingConfirmation: true,
    pendingAction: 'create_workspace',
    pendingWorkspace: 'tetris-game',
    pendingExpiresInSeconds: 89.25,
  }
  const waiting = deriveOrbState(waitingInput)
  assert.equal(waiting.statusLine, '需要你的确认')
  assert.equal(
    waiting.codexLabel,
    '创建工作区 “tetris-game”\n尚未执行 · 90 秒后自动取消',
  )
  assert.equal(waiting.confirmationCompactStatus, '90 秒')
  assert.equal(waiting.confirmationVisible, true)
  assert.equal(waiting.codexMode, 'confirmation')
  assert.equal(deriveOrbState({
    ...waitingInput,
    pendingConfirmationBusy: true,
  }).confirmationCompactStatus, '处理中')
})

test('hides the project row only when neither workspace nor session is known', () => {
  const hidden = deriveOrbState(base)
  assert.equal(hidden.projectLabel, '')
  assert.equal(hidden.codexMode, 'hidden')

  const workspaceOnly = deriveOrbState({...base, workspace: 'alpha'})
  assert.equal(workspaceOnly.projectLabel, '工作区 alpha')
  assert.equal(workspaceOnly.codexMode, 'project')
})

test('Codex approval can provide a local bounded operation without changing project semantics', () => {
  const state = deriveOrbState({
    ...base,
    pendingConfirmation: true,
    pendingConfirmationKind: 'codex',
    pendingOperation: '执行命令：npm test',
    pendingExpiresInSeconds: 12,
  })
  assert.equal(state.confirmationVisible, true)
  assert.equal(state.confirmationOperation, '执行命令：npm test')
  assert.match(state.confirmationStatus, /12 秒后自动取消/u)
})

test('describes each project action; a proposal without one keeps the generic label', () => {
  // Every change of the active project is confirmed (decision 2026-09-04): the pill names the action.
  for (const [pendingAction, label] of [
    ['select_workspace', '切换到工作区 “timer-app”'],
    ['reuse_workspace', '使用现有工作区 “timer-app”并开始任务'],
    ['resume_session', '恢复 “timer-app / Initial”'],
  ]) {
    const state = deriveOrbState({
      ...base, pendingConfirmation: true, pendingAction, pendingWorkspace: 'timer-app', pendingSession: 'Initial', pendingExpiresInSeconds: 360,
    })
    assert.equal(state.confirmationOperation, label)
    assert.equal(state.codexMode, 'confirmation')
  }
  const creating = deriveOrbState({
    ...base,
    pendingConfirmation: true,
    pendingAction: 'create_workspace',
    pendingWorkspace: 'timer-app',
    pendingSession: null,
    pendingExpiresInSeconds: 360,
  })
  assert.equal(creating.codexLabel, '创建工作区 “timer-app”\n尚未执行 · 360 秒后自动取消')

  const voiceOnly = deriveOrbState({
    ...base,
    pendingConfirmation: true,
    pendingAction: null,
    pendingWorkspace: 'timer-app',
    pendingSession: 'Initial',
    pendingExpiresInSeconds: 360,
  })
  assert.equal(voiceOnly.codexLabel, '项目操作等待确认\n尚未执行 · 360 秒后自动取消')
  assert.doesNotMatch(voiceOnly.codexLabel, /创建/u)
})

test('explains incomplete configuration on the visible status line', () => {
  const state = deriveOrbState({ ...base, backendState: 'configuration_required' })

  assert.equal(state.statusLine, '配置不完整')
})

test('uses a readable fallback instead of leaking undefined for a future state', () => {
  assert.equal(compactOrbLabel('future-state'), '状态异常')
})

// The compact line is the only status text the transparent orb still shows, so
// every state in the `data-state` vocabulary needs its own compact label.
test('every orb state carries a compact label on the one visible status line', () => {
  const inputs = {
    booting: { ...base, booting: true, connected: false },
    inactive: { ...base, activated: false },
    idle: base,
    candidate: { ...base, capture: 'candidate' },
    listening: { ...base, capture: 'listening' },
    speaking: { ...base, playback: 'speaking' },
    muted: { ...base, muted: true },
    'permission-denied': { ...base, microphone: 'permission_denied' },
    'microphone-restricted': { ...base, microphone: 'restricted' },
    'microphone-no-device': { ...base, microphone: 'no_input_device' },
    'microphone-busy': { ...base, microphone: 'device_busy' },
    'microphone-unavailable': { ...base, microphone: 'capture_unavailable' },
    'audio-pipeline-error': { ...base, microphone: 'audio_pipeline_error' },
    disconnected: { ...base, connected: false },
    reconnecting: { ...base, backendState: 'reconnecting' },
    'configuration-required': { ...base, backendState: 'configuration_required' },
    'authentication-failed': { ...base, backendState: 'authentication_failed' },
    'backend-unavailable': { ...base, backendState: 'unavailable' },
    error: { ...base, error: 'boom' },
  }

  assert.deepEqual(Object.keys(inputs).sort(), [...ORB_STATE_NAMES].sort())
  for (const name of ORB_STATE_NAMES) {
    const state = deriveOrbState(inputs[name])
    assert.equal(state.name, name, `${name} must be reachable`)
    assert.doesNotMatch(state.statusLine, /undefined/u, `${name} needs a compact label`)
    assert.equal(state.statusLine, compactOrbLabel(name), `${name} shows only the voice state`)
  }
})

test('labels the browser AEC path without implying it is a fallback', () => {
  const state = deriveOrbState({ ...base, audioMode: 'browser_aec' })

  assert.equal(state.aecLabel, '浏览器 AEC')
})

test('provides stable accessible labels for permission disconnect and playback', () => {
  assert.equal(deriveOrbState({ ...base, permission: 'denied' }).name, 'permission-denied')
  assert.equal(deriveOrbState({ ...base, connected: false }).name, 'disconnected')
  assert.ok(deriveOrbState({ ...base, playback: 'speaking' }).label)
})

test('keeps microphone recovery states distinct and actionable', () => {
  for (const [microphone, name, copy] of [
    ['permission_denied', 'permission-denied', /权限被拒绝/],
    ['restricted', 'microphone-restricted', /系统策略/],
    ['no_input_device', 'microphone-no-device', /未检测到/],
    ['device_busy', 'microphone-busy', /占用/],
    ['capture_unavailable', 'microphone-unavailable', /不可用/],
    ['audio_pipeline_error', 'audio-pipeline-error', /音频管线/],
  ]) {
    const state = deriveOrbState({ ...base, microphone })
    assert.equal(state.name, name, microphone)
    assert.match(state.label, copy, microphone)
  }
})

test('shows booting until the first connection instead of an immediate disconnect', () => {
  // The renderer's axes start out booting with connected=false, so a plain
  // "disconnected wins" precedence made 'booting' unreachable: the very first
  // frames have to read as an agent starting up, not as one that already died.
  assert.equal(deriveOrbState({ ...base, booting: true, connected: false }).name, 'booting')
  assert.match(deriveOrbState({ ...base, booting: true, connected: false }).label, /正在启动/)

  // A disconnect that lands after boot still collapses the orb.
  assert.equal(deriveOrbState({ ...base, connected: false }).name, 'disconnected')

  // A failed bootstrap is an error, not a boot still in progress.
  assert.equal(
    deriveOrbState({ ...base, booting: true, connected: false, error: 'bootstrap' }).name,
    'error',
  )
})

test('derives candidate from the onset attack window', () => {
  const candidate = deriveOrbState({ ...base, capture: 'candidate' })

  assert.equal(candidate.name, 'candidate')
  assert.match(candidate.label, /检测到可能的语音/)
  // A confirmed onset outranks the attack window it grew out of.
  assert.equal(deriveOrbState({ ...base, capture: 'listening' }).name, 'listening')
})

test('muted outranks capture and playback but never faults', () => {
  // The mic being off is the state the user acted on: it wins over anything
  // the (now silent) capture or the still-audible playback would show.
  assert.equal(deriveOrbState({ ...base, muted: true }).name, 'muted')
  assert.equal(deriveOrbState({ ...base, muted: true, capture: 'listening' }).name, 'muted')
  assert.equal(deriveOrbState({ ...base, muted: true, playback: 'speaking' }).name, 'muted')
  assert.match(deriveOrbState({ ...base, muted: true }).label, /已闭麦/)
  // Faults and errors still outrank a deliberate mute; inactive means there is
  // nothing to mute.
  assert.equal(deriveOrbState({ ...base, muted: true, error: 'boom' }).name, 'error')
  assert.equal(deriveOrbState({ ...base, muted: true, connected: false }).name, 'disconnected')
  assert.equal(deriveOrbState({ ...base, muted: true, activated: false }).name, 'inactive')
})

test('does not claim an AEC implementation before microphone activation', () => {
  const state = deriveOrbState({
    ...base,
    activated: false,
    audioMode: 'inactive',
  })

  assert.equal(state.aecLabel, 'AEC 未启用')
})

test('backend terminal and reconnecting states remain distinguishable', () => {
  const base = {
    booting: false, connected: false, permission: 'granted', activated: false,
    capture: 'idle', playback: 'idle', codex: 'idle', executorName: 'Codex', workspace: '', session: '',
    pendingConfirmation: false, error: '', audioMode: 'inactive', shellExpanded: false,
  }
  assert.equal(deriveOrbState({...base, backendState: 'reconnecting'}).name, 'reconnecting')
  assert.equal(deriveOrbState({...base, backendState: 'configuration_required'}).name, 'configuration-required')
  assert.equal(deriveOrbState({...base, backendState: 'authentication_failed'}).name, 'authentication-failed')
  assert.equal(deriveOrbState({...base, backendState: 'unavailable'}).name, 'backend-unavailable')
})

test('projects only public workspace session and confirmation into the Codex label', () => {
  const state = deriveOrbState({
    ...base,
    workspace: 'alpha',
    session: 'Task 1',
    pendingConfirmation: true,
    pendingAction: 'create_workspace',
    pendingWorkspace: 'beta',
    pendingSession: null,
    pendingExpiresInSeconds: 40,
  })

  assert.equal(state.codexLabel, '创建工作区 “beta”\n尚未执行 · 40 秒后自动取消')
})

test('adds a Windows-specific hint to the permission-denied label', () => {
  const state = deriveOrbState({ ...base, permission: 'denied', platform: 'win32' })

  assert.equal(state.name, 'permission-denied')
  assert.equal(
    state.label,
    '麦克风权限被拒绝(请在 系统设置 → 隐私 → 麦克风 中允许桌面应用)',
  )
})

test('keeps the shorter permission-denied label on non-Windows platforms', () => {
  const darwin = deriveOrbState({ ...base, permission: 'denied', platform: 'darwin' })
  const unspecified = deriveOrbState({ ...base, permission: 'denied' })

  assert.equal(darwin.label, '麦克风权限被拒绝')
  assert.equal(unspecified.label, '麦克风权限被拒绝')
})

const dormantBase = {
  stateName: 'idle',
  wakeState: 'active',
  hovered: false,
  confirmationVisible: false,
  bubblesVisible: false,
}

test('resting covers a dozing wake word and a session that never started', () => {
  // Two independent ways of not being in use, one appearance.
  assert.equal(orbDormant({ ...dormantBase, wakeState: 'sleeping' }), true)
  assert.equal(orbDormant({ ...dormantBase, stateName: 'inactive' }), true)

  // Everything that is in use stays full size.
  for (const stateName of ['idle', 'listening', 'speaking', 'candidate', 'muted']) {
    assert.equal(orbDormant({ ...dormantBase, stateName }), false, stateName)
  }
  // Muted is deliberately not resting: the user turned the mic off and is
  // still sitting in front of a live session.
  assert.equal(orbDormant({ ...dormantBase, stateName: 'muted' }), false)

  // A wake word that failed is not asleep — it needs to stay legible.
  assert.equal(orbDormant({ ...dormantBase, wakeState: 'blocked' }), false)

  // Booting must not shrink: the orb has not yet decided what it is, and a
  // bubble at launch would read as a broken window.
  assert.equal(orbDormant({ ...dormantBase, stateName: 'booting' }), false)
})

test('a dozing wake word must not shrink the orb over a state that needs reading', () => {
  // The wake word's idle timer watches the microphone and knows nothing about
  // the backend, so it doses off just as happily while the session is broken.
  // Resting on top of that would collapse the orb to 40px AND hide the pill
  // naming the fault — the user would lose the only sign anything is wrong.
  //
  // Every one of these must be asserted with wakeState 'sleeping': with
  // 'active' the predicate is already false for an unrelated reason, which is
  // exactly how this shipped green once before.
  for (const stateName of [
    'disconnected', 'error', 'backend-unavailable', 'reconnecting',
    'configuration-required', 'authentication-failed', 'permission-denied',
    'microphone-restricted', 'microphone-no-device', 'microphone-busy',
    'microphone-unavailable', 'audio-pipeline-error', 'booting',
  ]) {
    assert.equal(
      orbDormant({ ...dormantBase, stateName, wakeState: 'sleeping' }),
      false,
      `${stateName} must stay legible while the wake word sleeps`,
    )
  }

  // Nor may work in progress shrink underneath the user.
  for (const stateName of ['listening', 'candidate', 'speaking']) {
    assert.equal(
      orbDormant({ ...dormantBase, stateName, wakeState: 'sleeping' }),
      false,
      `${stateName} is in use`,
    )
  }

  // muted is the user's own choice and was deliberately left out of resting.
  assert.equal(orbDormant({ ...dormantBase, stateName: 'muted', wakeState: 'sleeping' }), false)

  // What may rest: a connected idle session whose wake word dozed off, and a
  // session that was never activated.
  assert.equal(orbDormant({ ...dormantBase, stateName: 'idle', wakeState: 'sleeping' }), true)
  assert.equal(orbDormant({ ...dormantBase, stateName: 'inactive', wakeState: 'active' }), true)
})

test('a working executor keeps the orb full size, bubbles or not', () => {
  // A running task leaves the orb state at 'idle' — the executor axis is not
  // part of deriveOrbState — and the bubble area it reserves only lands after
  // an async IPC round trip. So bubblesVisible is still false while that is in
  // flight, and without its own guard the orb would shrink and hide the very
  // task banner announcing the work.
  const working = {
    ...dormantBase, wakeState: 'sleeping', executorWorking: true, bubblesVisible: false,
  }
  assert.equal(orbDormant(working), false, 'not even before the reservation lands')
  assert.equal(orbDormant({ ...working, bubblesVisible: true }), false)
  assert.equal(orbDormant({ ...working, stateName: 'inactive' }), false)

  // Once the work is done, resting resumes.
  assert.equal(orbDormant({ ...working, executorWorking: false }), true)
})

test('hover and the larger surfaces all lift resting', () => {
  const sleeping = { ...dormantBase, wakeState: 'sleeping' }
  // Hover has to win, or the rail and the status pill would stay unreachable
  // at 40% scale inside a 64px window.
  assert.equal(orbDormant({ ...sleeping, hovered: true }), false)
  // Both of these reclaim the window bounds on the main side, so the renderer
  // must agree rather than fight over them.
  assert.equal(orbDormant({ ...sleeping, confirmationVisible: true }), false)
  assert.equal(orbDormant({ ...sleeping, bubblesVisible: true }), false)

  // Same for the inactive route into resting.
  const inactive = { ...dormantBase, stateName: 'inactive' }
  assert.equal(orbDormant({ ...inactive, hovered: true }), false)
  assert.equal(orbDormant({ ...inactive, confirmationVisible: true }), false)
  assert.equal(orbDormant({ ...inactive, bubblesVisible: true }), false)
})

test('resting tolerates a missing or partial input', () => {
  // render() passes a freshly built object, but a dropped wake-word frame or an
  // early call must not throw inside the render path.
  assert.equal(orbDormant(undefined), false)
  assert.equal(orbDormant({}), false)
  assert.equal(orbDormant({ stateName: 'inactive' }), true)
})
