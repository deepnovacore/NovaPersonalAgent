import {realpathSync} from 'node:fs'
import {join} from 'node:path'
import {parse} from 'smol-toml'
import {snapshotRegularFile} from '../../storage/native-resource-snapshot.js'

/** Provider configuration can supply credentials independently of a saved OpenAI login. */
export function hasLocalProviderCredential(codexHome: string): boolean {
  try {
    const path = realpathSync(join(codexHome, 'config.toml'))
    const bytes = snapshotRegularFile(path, 2 * 1024 * 1024).bytes
    const config = parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))
    const selected = config.model_provider
    if (typeof selected !== 'string' || selected === ''
      || ['openai', 'ollama', 'lmstudio', 'amazon-bedrock'].includes(selected)) return false
    const providers = config.model_providers
    if (!isTable(providers)) return false
    const provider = providers[selected]
    if (!isTable(provider) || typeof provider.base_url !== 'string'
      || provider.base_url.trim() === '') return false
    if (typeof provider.experimental_bearer_token === 'string'
      && provider.experimental_bearer_token.trim() !== '') return true
    const authPath = realpathSync(join(codexHome, 'auth.json'))
    const authBytes = snapshotRegularFile(authPath, 1024 * 1024).bytes
    const auth: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(authBytes))
    return isTable(auth) && typeof auth.OPENAI_API_KEY === 'string'
      && auth.OPENAI_API_KEY.trim() !== ''
  } catch {
    // Keep the existing login failure for absent, unreadable or malformed configuration.
    return false
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
