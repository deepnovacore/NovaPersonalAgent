import assert from 'node:assert/strict'
import test from 'node:test'
import {describeHostBlockingEnvironment} from '@nova-personal-agent/runtime/desktop'
import {SECRET_ENV_MAP} from '../src/main/backend.mjs'
import {RUNTIME_DEFAULTS} from '../src/main/settings-defaults.mjs'
import {CASCADED_ASR_PROVIDERS, CASCADED_LLM_PROVIDERS, CASCADED_TTS_PROVIDERS, INTEGRATED_PROVIDERS} from '../src/main/settings-store.mjs'
import {CLEARABLE_VOICE_SECRETS, VOICE_DEFAULTS, VOICE_SECRET_KEYS} from '../../../cli/src/runtime.mjs'
import {isEndpointSecret} from '../src/renderer/compatible-providers.mjs'
import * as voice from '../../../cli/src/voice-credentials.mjs'

// `npa doctor` reads the desktop settings file without loading the desktop, so its copies must stay in step.
test('CLI voice tables follow the desktop provider enums, defaults and secret names', () => {
  assert.deepEqual([...voice.INTEGRATED_PROVIDERS], [...INTEGRATED_PROVIDERS])
  assert.deepEqual([...voice.CASCADED_ASR_PROVIDERS], [...CASCADED_ASR_PROVIDERS])
  assert.deepEqual([...voice.CASCADED_LLM_PROVIDERS], [...CASCADED_LLM_PROVIDERS])
  assert.deepEqual([...voice.CASCADED_TTS_PROVIDERS], [...CASCADED_TTS_PROVIDERS])
  assert.deepEqual(VOICE_DEFAULTS, {pipeline: RUNTIME_DEFAULTS.pipelineMode, integratedProvider: RUNTIME_DEFAULTS.integratedProvider,
    asrProvider: RUNTIME_DEFAULTS.cascadedAsrProvider, llmProvider: RUNTIME_DEFAULTS.cascadedLlmProvider, ttsProvider: RUNTIME_DEFAULTS.cascadedTtsProvider})
  const credentials = new Set([voice.INTEGRATED_CREDENTIALS, voice.CASCADED_ASR_CREDENTIALS, voice.CASCADED_LLM_CREDENTIALS, voice.CASCADED_TTS_CREDENTIALS]
    .flatMap(table => Object.values(table)).filter(name => name !== null))
  assert.deepEqual([...credentials].sort(), Object.keys(VOICE_SECRET_KEYS).sort())
  for (const [name, key] of Object.entries(VOICE_SECRET_KEYS)) assert.equal(SECRET_ENV_MAP[key], name, key)
  assert.deepEqual([...CLEARABLE_VOICE_SECRETS].sort(), Object.values(VOICE_SECRET_KEYS).filter(isEndpointSecret).sort())
})

// The runtime's own blocking check, fed a launch environment with every key absent, names the same keys.
test('CLI voice requirement matches the runtime blocking check for every provider selection', () => {
  const selections = [
    ...voice.INTEGRATED_PROVIDERS.map(integratedProvider => ({...VOICE_DEFAULTS, pipeline: 'integrated', integratedProvider})),
    ...voice.CASCADED_ASR_PROVIDERS.flatMap(asrProvider => voice.CASCADED_LLM_PROVIDERS.flatMap(llmProvider => voice.CASCADED_TTS_PROVIDERS.map(ttsProvider =>
      ({...VOICE_DEFAULTS, pipeline: 'cascaded', asrProvider, llmProvider, ttsProvider})))),
  ]
  for (const selection of selections) {
    const runtime = describeHostBlockingEnvironment({PIPELINE_MODE: selection.pipeline, INTEGRATED_PROVIDER: selection.integratedProvider,
      CASCADE_ASR_PROVIDER: selection.asrProvider, CASCADE_LLM_PROVIDER: selection.llmProvider, CASCADE_TTS_PROVIDER: selection.ttsProvider,
      CASCADE_LLM_MODEL: 'fixture-model', OPENAI_COMPATIBLE_BASE_URL: 'https://models.invalid/v1', SELF_HOSTED_LLM_BASE_URL: 'https://llm.invalid/v1',
      COMPATIBLE_ASR_BASE_URL: 'https://asr.invalid/v1', COMPATIBLE_TTS_BASE_URL: 'https://tts.invalid/v1', COMPATIBLE_ASR_MODEL: 'asr', COMPATIBLE_TTS_MODEL: 'tts',
      SELF_HOSTED_ASR_URL: 'https://asr.invalid', SELF_HOSTED_TTS_URL: 'https://tts.invalid'})
    assert.ok(runtime !== null, JSON.stringify(selection))
    const cli = voice.requiredVoiceCredentials(selection)
    assert.deepEqual({pipeline: cli.pipeline, missing: [...cli.credentials]}, {pipeline: runtime.pipeline, missing: [...runtime.missing]}, JSON.stringify(selection))
  }
})
