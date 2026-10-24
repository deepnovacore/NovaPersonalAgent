import type {ComputerConfig} from './computer-config.js'
import type {startComputerBackend} from './computer-backend.js'
/** Local desktop binding. No accessibility/UI control tree, only display and foreground-window metadata. */
import type {AbstractInterface} from '@midscene/core/device'
import {z} from '@midscene/core'
import {actionScrollParamSchema, actionKeyboardPressParamSchema} from '@midscene/core/device'
import type {DeviceAction} from '@midscene/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {logicalSwipeDistance, type GuiProgress} from './gui-runner.js'

const exec = promisify(execFile)
export interface ComputerTarget {displayId: string; width: number; height: number; target: string}
export interface ComputerGuardOptions {
  displayId: string
  signal: AbortSignal
  beforeWrite?: () => void
  capture?: (image: string, steps: number) => void
  maxSteps: number
  budgetMs: number
  screenshotScrollDistance?: boolean
  approve: (name: string, params: unknown) => Promise<boolean>
  progress: (event: GuiProgress) => void
}

export async function guiApproval(approval: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Error('cancelled')
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => reject(new Error('cancelled'))
    signal.addEventListener('abort', abort, {once: true})
    approval.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
    if (signal.aborted) abort()
  })
}

/** The SDK already maps screenshot pixels to device.size() logical coordinates. Never scale centers twice. */
function validateCoordinates(params: unknown, target: ComputerTarget): void {
  if (params === null || typeof params !== 'object') return
  for (const [key, value] of Object.entries(params)) {
    if (key === 'center') {
      if (!Array.isArray(value) || value.length !== 2 || value.some((n, i) => typeof n !== 'number'
        || !Number.isFinite(n) || n < 0 || n >= (i ? target.height : target.width))) throw new Error('needs_user_action')
    } else if (value !== null && typeof value === 'object') validateCoordinates(value, target)
  }
}

/** A sent action is awaited to a bounded receipt; transport ambiguity always overrides cancellation. */
export async function computerWrite(action: () => Promise<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup_unknown')), Math.min(budgetMs, 30_000))
    })])
  } catch(error) { throw new Error('cleanup_unknown',{cause:error}) }
  finally { clearTimeout(timer) }
}

export async function guardComputerDevice(raw: AbstractInterface, target: () => Promise<ComputerTarget>, options: ComputerGuardOptions) {
  const initial = await target()
  if (initial.displayId !== options.displayId || !initial.target
    || ![initial.width, initial.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('invalid_configuration')
  let latest: ComputerTarget | undefined, planned: ComputerTarget | undefined, steps = 0
  let failure: string | undefined
  const check = () => {if (failure) throw new Error(failure); if (options.signal.aborted) throw new Error('cancelled')}
  const fresh = async (baseline?: ComputerTarget) => {
    check()
    const current = await target()
    if (current.displayId !== initial.displayId || current.width !== initial.width || current.height !== initial.height
      || (baseline && current.target !== baseline.target)) throw new Error('screen_changed')
    check()
    return current
  }
  const actions: DeviceAction[] = raw.actionSpace().filter(action => ['Tap', 'Input', 'Scroll', 'KeyboardPress'].includes(action.name))
    .map(action => ({...action, ...(action.name === 'Scroll' ? {paramSchema: actionScrollParamSchema.extend({scrollType: z.literal('singleAction'), distance: options.screenshotScrollDistance ? z.number().finite().positive() : z.number().finite().positive().max(Math.max(initial.width, initial.height))})} : action.name === 'KeyboardPress' ? {paramSchema: actionKeyboardPressParamSchema.omit({locate: true}).strict()} : {}), call: async (params: unknown, context) => {
      try {
        // AutoGLM leaves wheel distance in screenshot pixels, unlike its already rescaled locator centers.
        if (options.screenshotScrollDistance && action.name === 'Scroll' && params && typeof params === 'object' && typeof (params as {distance?: unknown}).distance === 'number') {
          params = {...params, distance: logicalSwipeDistance((params as {distance: number}).distance, context?.uiContext?.shrunkShotToLogicalRatio ?? NaN)}
        }
        check()
        if (steps >= options.maxSteps) throw new Error('step_limit')
        if (!planned) throw new Error('screen_changed')
        const baseline = planned
        validateCoordinates(params, baseline)
        const input = params as {locate?: unknown; value?: unknown; mode?: unknown; keyName?: unknown; scrollType?: unknown; distance?: unknown}
        // Input/key actions use existing focus; SDK target autofocusing can emit extra clicks.
        if (action.name === 'Input' && (input.locate || (input.mode !== undefined && (typeof input.mode!=='string'||!['typeOnly','append','replace'].includes(input.mode))) || typeof input.value !== 'string'
          || !input.value || input.value.length > 4000)) throw new Error('needs_user_action')
        if (action.name === 'KeyboardPress' && (input.locate || typeof input.keyName !== 'string'
          || !input.keyName || input.keyName.length > 100)) throw new Error('needs_user_action')
        if (action.name === 'Scroll' && (input.scrollType !== 'singleAction' || (input.distance != null
          && (typeof input.distance !== 'number' || !Number.isFinite(input.distance) || input.distance <= 0
            || input.distance > Math.max(baseline.width, baseline.height))))) throw new Error('needs_user_action')
        await fresh(baseline)
        options.progress({phase: 'action_pending', steps, actionName: action.name})
        if (!await guiApproval(options.approve(action.name, params), options.signal)) throw new Error('declined')
        await fresh(baseline)
        check()
        options.beforeWrite?.()
        steps++
        await computerWrite(async () => {await action.call(params, context)}, options.budgetMs)
        planned = undefined
        options.progress({phase: 'action_returned', steps, actionName: action.name})
        check()
        // Observation is retained in memory; model Finished alone is never verification.
        const observed = await device.screenshotBase64()
        options.capture?.(observed, steps)
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        failure ??= ['cleanup_unknown', 'cancelled', 'step_limit', 'screen_changed', 'needs_user_action', 'declined'].includes(reason) ? reason : 'action_failed'
        throw new Error(failure,{cause:error})
      }
    }}))
  const device: AbstractInterface = {interfaceType: raw.interfaceType, size: async () => {
    await fresh()
    return {width: initial.width, height: initial.height}
  }, screenshotBase64: async () => {
    const before = await fresh()
    const image = await raw.screenshotBase64()
    latest = await fresh(before)
    return image
  }, actionSpace: () => actions}
  return {device, planning: () => {check(); planned = latest}, steps: () => steps, failure: () => failure}
}

// CGWindowList supplies window IDs/bounds only. No AX elements or UI semantics are read.
const foregroundScript = `ObjC.import('AppKit'); ObjC.import('CoreGraphics');
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const pid = Number(app.processIdentifier);
const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0)));
const window = windows.find(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0);
if (!window) throw new Error('no foreground window');
if (Number($.NSScreen.screens.count) !== 1) throw new Error('multiple displays');
const frame = $.NSScreen.mainScreen.frame;
JSON.stringify({target: [pid, ObjC.unwrap(app.bundleIdentifier), window.kCGWindowNumber, window.kCGWindowBounds],
  width: frame.size.width, height: frame.size.height});`

export async function macForeground(signal: AbortSignal): Promise<Omit<ComputerTarget, 'displayId'>> {
  const {stdout} = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', foregroundScript],
    {signal, timeout: 5000, maxBuffer: 16_384})
  const value = JSON.parse(stdout.trim()) as {target?: unknown; width?: unknown; height?: unknown}
  const identity = value.target
  if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== 'number'
    || typeof identity[1] !== 'string' || typeof identity[2] !== 'number' || !identity[3]
    || typeof value.width !== 'number' || typeof value.height !== 'number') throw new Error('invalid_configuration')
  return {target: JSON.stringify(identity), width: value.width, height: value.height}
}

export function validComputerDisplayId(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^\\\\\.\\DISPLAY[1-9]\d{0,2}$/u.test(value) : /^\d{1,10}$/u.test(value)
}
// Win32 identity and physical geometry only; no UIA tree or control semantics.
const windowsForegroundScript = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NovaWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left, Top, Right, Bottom;}
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
}
'@
if ([NovaWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) {throw 'dpi_unavailable'}
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Count -ne 1) {throw 'screen_changed'}
$bounds = $screens[0].Bounds
if ($bounds.X -ne 0 -or $bounds.Y -ne 0) {throw 'screen_changed'}
$window = [NovaWindow]::GetForegroundWindow()
$processId = [uint32]0
$rect = New-Object NovaWindow+Rect
[void][NovaWindow]::GetWindowThreadProcessId($window, [ref]$processId)
if ($window -eq [IntPtr]::Zero -or ![NovaWindow]::GetWindowRect($window, [ref]$rect)) {throw 'window_unavailable'}
@{target = @($processId, $window.ToInt64(), @($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)); width=$bounds.Width; height=$bounds.Height} | ConvertTo-Json -Compress -Depth 4`

export async function computerForeground(signal: AbortSignal): Promise<Omit<ComputerTarget, 'displayId'>> {
  if (process.platform === 'darwin') return macForeground(signal)
  if (process.platform !== 'win32') throw Error('invalid_configuration')
  const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsForegroundScript, 'utf16le').toString('base64')],
    {signal, timeout: 5000, maxBuffer: 16_384})
  const value = JSON.parse(stdout.trim()) as {target?: unknown; width?: unknown; height?: unknown}
  if (!Array.isArray(value.target) || value.target.length !== 3 || typeof value.target[0] !== 'number' || typeof value.target[1] !== 'number'
    || !Array.isArray(value.target[2]) || value.target[2].length !== 4 || !value.target[2].every(Number.isFinite)
    || typeof value.width !== 'number' || !Number.isFinite(value.width) || value.width <= 0
    || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) throw Error('invalid_configuration')
  return {target: JSON.stringify(value.target), width: value.width, height: value.height}
}

/** Both planners share connection consent and target checks; callers retain their resource lease. */
export async function connectComputerDevice(backend: Awaited<ReturnType<typeof startComputerBackend>>, config: ComputerConfig,
  options: Omit<ComputerGuardOptions, 'displayId' | 'maxSteps' | 'budgetMs'> & {
    foreground?: typeof computerForeground; beforeConnect?: () => void
  }) {
  const target = async (): Promise<ComputerTarget> => {
    options.signal.throwIfAborted()
    if (config.macWindow) return {displayId: config.displayId, ...await backend.windowTarget()}
    const displays = await backend.listDisplays()
    if (displays.length !== 1 || displays[0]?.id !== config.displayId) throw Error('screen_changed')
    return {displayId: config.displayId, ...await (options.foreground ?? computerForeground)(options.signal)}
  }
  const baseline = await target()
  if (!await guiApproval(options.approve('Connect', config.macWindow
    ? {window: config.macWindow, ...(config.macApplication?{application:config.macApplication}:{}), mode: 'background', healthCheck: 'window identity only', pointerInput: 'window-bound AX actions or targeted events; no foreground activation'}
    : {displayId: config.displayId, mode:'activated', healthCheck: 'moves and restores pointer'}), options.signal)) throw Error('declined')
  const approved = await target()
  // Whole-screen consent binds the display; the first screenshot binds the input target.
  if (approved.width !== baseline.width || approved.height !== baseline.height
    || (config.macWindow && approved.target !== baseline.target)) throw Error('screen_changed')
  options.signal.throwIfAborted()
  options.beforeConnect?.()
  await backend.connect()
  const size = await backend.device.size()
  if (size.width !== baseline.width || size.height !== baseline.height) throw Error('screen_changed')
  return guardComputerDevice(backend.device, target, {...options, displayId: config.displayId,
    maxSteps: config.maxSteps, budgetMs: config.budgetMs})
}
