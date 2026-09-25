import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises'
import {statSync} from 'node:fs'
import {join} from 'node:path'
import {resolveSecretConfiguration} from '../src/main/backend.mjs'
import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'
import {classifyBackendFailure} from '../src/main/backend-supervisor.mjs'
import {capabilityPath, capabilityDocumentRevision, readCapabilityDocument} from '../src/main/capabilities-settings.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const launch = source.slice(source.indexOf('async function launchBackend('), source.indexOf('function initializeDesktopBootstrap('))
const view = source.slice(source.indexOf('function settingsView()'), source.indexOf('async function loadMemoryBoardExport()'))

test('actual main prelaunch registry failures stop the supervisor without scheduling reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task4-prelaunch-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'cap.json')
  for (const bytes of ['invalid json', ' '.repeat(256 * 1024 + 1), null]) {
    if (bytes === null) await rm(path)
    else await writeFile(path, bytes)
    const context = vm.createContext({acceptance: null, readCapabilityDocument, classifyBackendFailure, currentSettings: {capabilitiesConfigPath: path}, process: {env: {}}, desktopConfig: {}, codexStatus: {status: 'ready'}})
    vm.runInContext(launch, context)
    let retries = 0
    const supervisor = createBackendSupervisor({start: () => context.launchBackend(), stopBackend: async () => {}, onStatus: () => {}, schedule: () => {retries++; return 1}})
    await supervisor.start()
    assert.equal(supervisor.status().state, 'configuration_required')
    assert.equal(supervisor.status().diagnostic, 'configuration_required')
    assert.equal(retries, 0)
    await supervisor.stop()
  }
})
for (const acceptance of [null, {}]) test(`actual main preserves model errors with Coding disabled (acceptance=${!!acceptance})`, async () => {
  const context = vm.createContext({acceptance, readCapabilityDocument: () => ({modules: {coding: {enabled: false}}}), classifyBackendFailure,
    currentSettings: {}, process: {env: {}}, desktopConfig: {modelConfigurationError: 'model_base_url_invalid', codexConfigurationError: 'manual_path_required'}, codexStatus: {status: 'unavailable'}})
  vm.runInContext(launch, context)
  await assert.rejects(context.launchBackend(), error => error.kind === 'configuration_required' && error.code === 'model_base_url_invalid')
})
for (const acceptance of [null, {}]) test(`actual main gates Coding configuration errors (acceptance=${!!acceptance})`, async () => {
  const context = vm.createContext({acceptance, readCapabilityDocument: () => ({modules: {coding: {enabled: true}}}), classifyBackendFailure,
    currentSettings: {}, process: {env: {}}, desktopConfig: {modelConfigurationError: 'model_base_url_invalid', codexConfigurationError: 'manual_path_required'}, codexStatus: {status: 'unavailable'}})
  vm.runInContext(launch, context)
  await assert.rejects(context.launchBackend(), error => error.code === (acceptance ? 'model_base_url_invalid' : 'manual_path_required'))
})
test('explicit settings refresh reads hand edits without IO in the public projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task6-cache-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'capabilities.json')
  let credentials = 0
  const context = vm.createContext({capabilityEditorCache: null, currentSettings: {capabilitiesConfigPath: path}, process: {env: {}},
    readCapabilityDocument, capabilityEnvironment: () => ({}), readCapabilityEditor: settings => ({document: readCapabilityDocument(settings, {})}),
    accessCredentials: operation => {credentials++; return operation()}, decryptSecretsForSpawn: () => ({}), secretCodec: {}, backendStatus: {state: 'connected'}, credentialFailure: null})
  const helpers = source.slice(source.indexOf('async function refreshSettingsCapabilities('), source.indexOf('async function loadMemoryBoardExport('))
  vm.runInContext(helpers, context)
  for (const budget of [4, 5, 6]) {
    await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: budget}))
    await context.refreshSettingsCapabilities()
    assert.equal(context.capabilityEditorCache.view.document.frontbrainToolBudget, budget)
  }
  assert.equal(credentials, 3)
  context.credentialFailure = {code: 'credential_access_failed'}
  await context.refreshSettingsCapabilities(); assert.equal(credentials, 3)
})
