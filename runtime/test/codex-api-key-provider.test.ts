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

test('ChatGPT broker provider is loopback-only and disables websocket transport', () => {
  const proxy='http://127.0.0.1:19455/v1'
  assert.ok(apiKeyProviderOverrides(proxy).includes(`model_providers.nova_api_key.base_url="${proxy}"`))
  assert.ok(apiKeyProviderOverrides(proxy).includes('model_providers.nova_api_key.supports_websockets=false'))
  for(const bad of ['https://evil.test/v1','http://localhost:1455/v1','http://127.0.0.1:1455/v1?secret=x','http://127.0.0.1:0/v1'])assert.throws(()=>apiKeyProviderOverrides(bad))
  const provider={base_url:proxy,env_key:'NOVA_CODEX_API_KEY',wire_api:'responses',requires_openai_auth:false,supports_websockets:false}
  const response={config:{model_provider:'nova_api_key',model_providers:{nova_api_key:provider}}}
  assert.doesNotThrow(()=>assertApiKeyProvider(response,proxy))
  assert.throws(()=>assertApiKeyProvider(response))
  assert.throws(()=>assertApiKeyProvider({...response,config:{...response.config,model_providers:{nova_api_key:{...provider,supports_websockets:true}}}},proxy))
})
