import { isWellFormed } from '../../python-text.js'
import { snapshotJsonRecord } from './safe-json.js'

export const NOVA_API_PROVIDER = 'nova_api_key'
export const NOVA_API_KEY_ENV = 'NOVA_CODEX_API_KEY'
const endpoint = 'https://api.openai.com/v1'

const ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
])

export class CodexCredentialError extends Error {
  readonly code = 'credential_missing' as const

  constructor() {
    super('credential_missing')
    this.name = 'CodexCredentialError'
  }
}

export function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return environment[name]
  const normalizedName = name.toUpperCase()
  let result: string | undefined
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== normalizedName || value === undefined) continue
    if (result !== undefined && result !== value) throw new CodexCredentialError()
    result = value
  }
  if (result !== undefined || normalizedName !== 'HOME') return result
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== 'USERPROFILE' || value === undefined) continue
    if (result !== undefined && result !== value) throw new CodexCredentialError()
    result = value
  }
  return result
}

export function snapshotEnvironmentInput(
  value: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, string> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new CodexCredentialError()
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CodexCredentialError()
    }
    const field = descriptor.value as unknown
    if (field === undefined) continue
    if (typeof field !== 'string' || !isWellFormed(field) || field.includes('\0')) {
      throw new CodexCredentialError()
    }
    defineString(result, key, field)
  }
  return Object.freeze(result)
}

function validateApiKey(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '' || !isWellFormed(value) || value.includes('\0')) {
    throw new CodexCredentialError()
  }
  return value
}

export function createCodexEnvironment(
  source: Readonly<Record<string, string>>,
  home: string,
  apiKey: string | null,
  managedEnvironment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = environmentValue(source, name, platform)
    if (value !== undefined) defineString(result, name, value)
  }
  result.CODEX_HOME = home
  result.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1'
  if (validateApiKey(apiKey) !== null) result[NOVA_API_KEY_ENV] = apiKey!
  if (Object.keys(managedEnvironment).some(key => CHILD_ENVIRONMENT_KEYS.has(key))) throw new CodexCredentialError()
  return validateCodexEnvironment({...result, ...managedEnvironment}, home, managedEnvironment)
}

const CHILD_ENVIRONMENT_KEYS = new Set([...ENVIRONMENT_ALLOWLIST, 'CODEX_HOME',
  'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED', NOVA_API_KEY_ENV])

export function validateCodexEnvironment(
  value: Readonly<Record<string, string>>,
  expectedCodexHome: string,
  managedEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) throw new CodexCredentialError()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, string> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (!CHILD_ENVIRONMENT_KEYS.has(key) && !Object.hasOwn(managedEnvironment, key))) {
      throw new CodexCredentialError()
    }
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CodexCredentialError()
    }
    const field = descriptor.value as unknown
    if (typeof field !== 'string' || !isWellFormed(field) || field.includes('\0')) {
      throw new CodexCredentialError()
    }
    Object.defineProperty(result, key, {value: field, enumerable: true})
  }
  if (
    Object.entries(managedEnvironment).some(([key, value]) => CHILD_ENVIRONMENT_KEYS.has(key) || result[key] !== value)
    || result.PATH === undefined
    || result.HOME === undefined
    || result.CODEX_HOME !== expectedCodexHome
    || result.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== '1'
    || result[NOVA_API_KEY_ENV] === ''
  ) throw new CodexCredentialError()
  return Object.freeze(result)
}

function defineString(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}




/** CLI tables merge with user config; verify the effective table before using it. */
export function apiKeyProviderOverrides(): readonly string[] {
  return [
    `model_provider="${NOVA_API_PROVIDER}"`,
    `model_providers.${NOVA_API_PROVIDER}.name="Nova API key"`,
    `model_providers.${NOVA_API_PROVIDER}.base_url="${endpoint}"`,
    `model_providers.${NOVA_API_PROVIDER}.env_key="${NOVA_API_KEY_ENV}"`,
    `model_providers.${NOVA_API_PROVIDER}.wire_api="responses"`,
    `model_providers.${NOVA_API_PROVIDER}.requires_openai_auth=false`,
  ].flatMap(value => ['-c', value])
}

export function assertApiKeyProvider(response: unknown): void {
  const config = snapshotJsonRecord(snapshotJsonRecord(response).config)
  const provider = snapshotJsonRecord(snapshotJsonRecord(config.model_providers)[NOVA_API_PROVIDER])
  if (config.model_provider !== NOVA_API_PROVIDER
    || provider.base_url !== endpoint || provider.env_key !== NOVA_API_KEY_ENV
    || provider.wire_api !== 'responses' || provider.requires_openai_auth !== false) {
    throw new TypeError('API key provider configuration mismatch')
  }
  for (const name of ['http_headers', 'env_http_headers', 'query_params', 'experimental_bearer_token', 'auth', 'aws']) {
    const value = provider[name]
    if (value != null && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0)) {
      throw new TypeError('API key provider configuration mismatch')
    }
  }
}

export function assertApiKeyThread(response: unknown): void {
  const result = snapshotJsonRecord(response)
  if (result.modelProvider !== NOVA_API_PROVIDER
    || snapshotJsonRecord(result.thread).modelProvider !== NOVA_API_PROVIDER) {
    throw new TypeError('API key thread provider mismatch')
  }
}
