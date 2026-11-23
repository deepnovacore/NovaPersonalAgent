import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {backendSettings, publicSettings, normalizeSettings} from '../src/main/settings-store.mjs'
import {applySettingsTransaction} from '../src/main/settings-apply.mjs'
import {createLifecycleCoordinator} from '../src/main/desktop-startup.mjs'
import {planSecretChange, rotationPayload} from '../src/main/credential-hot-apply.mjs'
import {codingBlockedByCodex} from '../src/main/coding-settings.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

// Runs the real applyDesktopSettings with only its collaborators replaced.
async function applyKeyChange({before, after, failDelivery = false, backendConnected = true, patch = {secrets: {dashscopeApiKey: {enc: 'x', data: 'y'}}}}) {
  const requests = []
  let restarted = 0
  const context = vm.createContext({
    configuredSpaceModelsPath: () => null, codingBlockedByCodex, desktopConfig: null, codexStatus: {status: 'ready'}, currentSettings: normalizeSettings({}), settingsRestartPending: false, settingsRecoveryAvailable: false,
    runtimeCapabilities: {modules: {coding: {enabled: true}}},
    backendSettings, publicSettings, applySettingsTransaction, lifecycleCoordinator: createLifecycleCoordinator(),
    planSecretChange, rotationPayload, backendStatus: {state: backendConnected ? 'connected' : 'stopped'},
    backendControl: backendConnected ? {request: async (method, params) => {
      requests.push([method, params])
      if (failDelivery) throw new Error('ack lost')
      return {applied: params.rotations.length}
    }} : null,
    settingsFile: () => '/tmp/hot-apply.json', resolve, capabilityPath: () => '/tmp/capabilities.json',
    parseSettingsCommit: value => value, validatePreparedSettings: () => {}, accessCredentials: work => work(),
    readCapabilityDocument: () => ({}), secretCodec: {}, capabilityEnvironment: () => ({}), process: {env: {}},
    decryptSecretsForSpawn: settings => settings.secrets?.dashscopeApiKey ? after : before,
    prepareCapabilityCommit: async ({beforeWrite}) => { await beforeWrite(); return {} },
    saveSettingsRecovery: async () => {}, clearSettingsRecovery: async () => {}, saveSettings: async () => {},
    publishCommittedSettings: () => {}, publishSettingsApplyStatus: () => {}, refreshSettingsCapabilities: async () => {},
    rollbackSettings: async () => {}, prepareDesktopConfiguration: async () => ({}),
    commitDesktopConfiguration: async () => ({}), discardDesktopConfiguration: () => {},
    restartSettingsBackend: async () => { restarted++ }, console,
  })
  context.settingsView = () => publicSettings(context.currentSettings)
  context.settingsWriter = async (patchValue, prepare) => { const next = {...context.currentSettings, ...patchValue}; await prepare(next); context.currentSettings = next; return next }
  const live = source.slice(source.indexOf('async function applyLiveCodingBackend('), source.indexOf('async function restartSettingsBackend('))
  const apply = source.slice(source.indexOf('async function applyDesktopSettings('), source.indexOf('function showOrbMenu('))
  vm.runInContext(`${live}\n${apply}\nglobalThis.applyDesktopSettings = applyDesktopSettings`, context)
  const result = await context.applyDesktopSettings({settingsPatch: patch})
  return {result, requests, restarted, pending: context.settingsRestartPending}
}

test('replacing a key in use is applied to the running backend without a restart', async () => {
  const {result, requests, restarted, pending} = await applyKeyChange({before: {dashscopeApiKey: 'old-key'}, after: {dashscopeApiKey: 'new-key'}})
  assert.equal(result.operationStatus, 'applied'); assert.equal(restarted, 0); assert.equal(pending, false)
  assert.deepEqual(requests, [['credentials.rotate', {rotations: [{from: 'old-key', to: 'new-key'}]}]])
  assert.ok(!JSON.stringify(result).includes('new-key') && !JSON.stringify(result).includes('old-key'), 'the reply never carries a key')
})

test('a failed hand-over keeps the saved key and asks for a restart instead of losing the save', async () => {
  const {result, pending, restarted} = await applyKeyChange({before: {dashscopeApiKey: 'old-key'}, after: {dashscopeApiKey: 'new-key'}, failDelivery: true})
  assert.equal(result.saved, true); assert.equal(result.operationStatus, 'pending_restart'); assert.equal(pending, true); assert.equal(restarted, 0)
})

test('a first key, a module that copies keys, or a stopped backend still go through the restart path', async () => {
  const first = await applyKeyChange({before: {}, after: {dashscopeApiKey: 'new-key'}})
  assert.equal(first.requests.length, 0); assert.equal(first.result.operationStatus, 'pending_restart')
  const stopped = await applyKeyChange({before: {dashscopeApiKey: 'old-key'}, after: {dashscopeApiKey: 'new-key'}, backendConnected: false})
  assert.equal(stopped.result.operationStatus, 'pending_restart')
})
