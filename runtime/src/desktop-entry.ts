import {fileURLToPath} from 'node:url'
import {installAcceptanceGate,probeAcceptanceGate,acceptanceRuntimeHash} from './desktop/workbench-acceptance.js'
import {installDesktopControl, handleFeishuSettings, handlePersonalSettings, PERSONAL_SETTINGS_METHODS, desktopBudgetFailure, type DesktopCapabilityState} from './desktop/desktop-control.js'
import {runDesktopEntryWithStopSources, type DesktopStopParentSource} from './desktop/desktop-session.js'
import {announceReadiness} from './desktop.js'
import {buildProductionComposition} from './composition/production-composition.js'

type UtilityProcess = NodeJS.Process & {readonly parentPort?: DesktopStopParentSource & {postMessage(message: unknown): void}}

const acceptance=installAcceptanceGate()
if(process.argv.includes('--nova-workbench-acceptance-required')&&!acceptance)throw Error('acceptance_gate_missing')

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort
const acceptanceProbe=acceptance?await probeAcceptanceGate():undefined
if(acceptance&&acceptanceProbe)parentPort?.postMessage({type:'nova:acceptance:gate-ready',buildCommit:acceptance.buildCommit,runtimeHash:acceptanceRuntimeHash(fileURLToPath(import.meta.url)),...acceptanceProbe})

let capabilityView: (() => DesktopCapabilityState | undefined) = () => undefined
let knowledgeHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let feishuHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let personalSettingsHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let clearConversation: (() => Promise<void>) | undefined
const control = installDesktopControl({...(parentPort === undefined ? {} : {parentPort}), signal: stop.signal,
  status: () => capabilityView(), handle: async (method, params) => {
    if (method.startsWith('feishu.')) return feishuHandle?.(method, params)
    if (PERSONAL_SETTINGS_METHODS.includes(method)) return personalSettingsHandle?.(method, params)
    if (method !== 'conversation.clear') return knowledgeHandle?.(method, params)
    if (clearConversation === undefined || params === null || typeof params !== 'object'
      || Array.isArray(params) || Object.keys(params).length !== 0) return {error: 'unavailable'}
    try { await clearConversation(); return {cleared: true} }
    catch { return {error: 'clear_failed'} }
  }})

const onDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

const exitCode = await runDesktopEntryWithStopSources({
  token,
  readyEndpoint,
  stop,
  announce: (endpoint, readiness, signal) => announceReadiness(
    endpoint,
    readiness,
    {signal},
  ),
  onDiagnostic,
  onStartupFailure: error => {
    if(acceptance){
      const detail=error instanceof Error?`${error.name}: ${error.message}`:typeof error
      onDiagnostic(`[acceptance-startup-error] ${detail.replace(/[\r\n]/gu,' ').slice(0,300)}`)
    }
    const status = desktopBudgetFailure(error)
    capabilityView = () => status
    control.publish()
  },
  construct: async ownership => {
    const composition = await buildProductionComposition({token, stop, ownership, onDiagnostic, onUsage: control.publishUsage,
      onKnowledge: knowledge => { knowledgeHandle = (method, params) => knowledge.service.handle(method, params) },
    })
    capabilityView = () => ({...composition.realtime.capabilityStatus, state: 'running'})
    clearConversation = () => composition.realtime.clearConversation()
    feishuHandle = (method, params) => handleFeishuSettings(input => composition.realtime.personalAgent.command(input), method, params)
    personalSettingsHandle = (method, params) => handlePersonalSettings(input => composition.realtime.personalAgent.command(input), method, params)
    control.publish()
    return composition
  },
}, {
  processEvents: process,
  stdin: process.stdin,
  ...(parentPort === undefined ? {} : {parentPort}),
})

control.dispose()
process.exitCode = exitCode
// Electron utility processes can retain native/IPC handles after all owned
// services have drained. Finish only here, after stop-source and control disposal.
if (exitCode !== 0 || parentPort !== undefined) {
  await new Promise<void>(resolve => process.stderr.write('', () => resolve()))
  process.exit(exitCode)
}
