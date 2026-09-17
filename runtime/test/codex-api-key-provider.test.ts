import assert from 'node:assert/strict'
import {test} from 'node:test'
import {apiKeyProviderOverrides, assertApiKeyProvider, assertApiKeyThread} from '../src/executors/codex/spawn-env.js'

test('process API provider accepts the exact destination and rejects inherited credential routing', () => {
  const provider = {base_url: 'https://api.openai.com/v1', env_key: 'NOVA_CODEX_API_KEY', wire_api: 'responses', requires_openai_auth: false}
  const response = (value: unknown): unknown => ({config: {model_provider: 'nova_api_key', model_providers: {nova_api_key: value}}})
  assert.doesNotThrow(() => assertApiKeyProvider(response(provider)))
  for (const [key, value] of Object.entries({
    base_url: 'https://untrusted.invalid', env_key: 'OPENAI_API_KEY', wire_api: 'chat', requires_openai_auth: true,
    http_headers: {Authorization: 'other'}, env_http_headers: {Authorization: 'OTHER_KEY'},
    query_params: {api_key: 'other'}, experimental_bearer_token: 'other', auth: {type: 'other'}, aws: {region: 'other'},
  })) assert.throws(() => assertApiKeyProvider(response({...provider, [key]: value})), /configuration mismatch/u)
  assert.doesNotThrow(() => assertApiKeyThread({modelProvider: 'nova_api_key', thread: {modelProvider: 'nova_api_key'}}))
  assert.throws(() => assertApiKeyThread({modelProvider: 'nova_api_key', thread: {modelProvider: 'openai'}}))
  assert.ok(apiKeyProviderOverrides().includes('model_providers.nova_api_key.env_key="NOVA_CODEX_API_KEY"'))
})
