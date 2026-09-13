import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reportStartupFailure,
  startupFailureCode,
} from '../src/main/startup-diagnostics.mjs'

test('startup failures publish only a stable allowlisted code', () => {
  assert.equal(
    startupFailureCode(new Error('project_directory_open_failed')),
    'project_directory_open_failed',
  )
  assert.equal(
    startupFailureCode(Object.assign(new Error('private camera path'), {
      name: 'MainCameraConfigurationError',
    })),
    'camera_configuration_invalid',
  )

  let written = ''
  const code = reportStartupFailure(new Error('secret path C:\\private\\token'), {
    write: chunk => { written += chunk },
  })
  assert.equal(code, 'startup_failed')
  assert.equal(written, '[desktop-diagnostic] startup_failure code=startup_failed\n')
  assert.doesNotMatch(written, /private|token/u)
})


test('unsupported embedding startup shows an actionable message without exposing the stored value', () => {
  let shown, written = ''
  const code = reportStartupFailure(Object.assign(new Error('private stored value'), {
    code: 'embedding_provider_invalid',
  }), {
    write: chunk => {written += chunk},
    showError: message => {shown = message},
  })
  assert.equal(code, 'embedding_provider_invalid')
  assert.match(shown, /embeddingProvider.*dashscope/u)
  assert.match(shown, /后端未启动/u)
  assert.doesNotMatch(shown + written, /private stored value/u)
})
