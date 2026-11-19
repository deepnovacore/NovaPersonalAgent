import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {describeStartupError, startupConfiguration} from '../src/desktop/startup-error.js'
import {desktopConfigurationFailure, installDesktopControl} from '../src/desktop/desktop-control.js'

const configuration = {code: 'memory_provider_conflict', variables: ['MEMORY_PROVIDER', 'MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS']}
const privateDetail = 'Bearer short-secret https://private.invalid?token=secret consumer:private-user'

test('startup errors never expose raw messages, URLs, credentials or consumer identifiers', () => {
  for (const error of [new Error(privateDetail), Object.assign(new Error(privateDetail), {code: privateDetail}), privateDetail, null]) {
    assert.equal(describeStartupError(error), 'startup_failed')
    assert.equal(startupConfiguration(error), undefined)
  }
})

test('startup configuration projects only allowlisted codes and variable names', () => {
  const error = Object.assign(new Error(privateDetail), {startupConfiguration: {...configuration, hint: privateDetail}})
  assert.deepEqual(startupConfiguration(error), configuration)
  assert.equal(describeStartupError(error), 'memory_provider_conflict: MEMORY_PROVIDER, MEMORY_RECALL_ENGINE, MEMORY_EXTRACTORS')
  for (const value of [null, {}, {...configuration, code: privateDetail}, {...configuration, variables: ['MEMORY_PROVIDER', privateDetail]},
    {...configuration, variables: []}, {...configuration, variables: 'MEMORY_PROVIDER'}]) {
    assert.equal(startupConfiguration({startupConfiguration: value}), undefined)
    assert.equal(describeStartupError({startupConfiguration: value}), 'startup_failed')
  }
  for (const name of ['MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS', 'MEMORY_CONNECTION', 'MEMORY_URL', 'MEMORY_TOKEN']) {
    const issue = {code: 'memory_configuration_invalid', variables: [name]}
    assert.deepEqual(startupConfiguration({startupConfiguration: issue}), issue)
  }
})

test('desktop startup-status publishes the safe configuration contract, not exception details', () => {
  class Parent extends EventEmitter {
    readonly sent: unknown[] = []
    postMessage(message: unknown): void {this.sent.push(message)}
  }
  const parentPort = new Parent(), signal = new AbortController().signal
  const error = Object.assign(new Error(privateDetail), {startupConfiguration: {...configuration, hint: privateDetail}})
  const status = desktopConfigurationFailure(error)
  const control = installDesktopControl({parentPort, signal, status: () => status})
  try {
    control.publish()
    assert.deepEqual(parentPort.sent, [{type: 'nova.capabilities', status: {
      state: 'startup_failed', toolCount: null, toolBudget: 24, reason: 'configuration_required', startupConfiguration: configuration,
    }}])
    assert.doesNotMatch(JSON.stringify(parentPort.sent), /short-secret|private\.invalid|private-user|Bearer/u)
  } finally {control.dispose()}
})
