import {lstat, mkdir, rename, unlink} from 'node:fs/promises'
import {join} from 'node:path'

// Main-process only. The bootstrap token stays in this process's memory: it is
// passed straight to the runtime, never written to disk, logged, or returned.
const MAX_PAYLOAD_BYTES = 8192
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CONTROL = /[\u0000-\u001f\u007f]/u

function rejected() {
  return new Error('space create rejected')
}

/** Throws on a malformed request; returns {error} for a well-formed request with an unusable value. */
export function parseSpaceCreateRequest(payload) {
  if (payload && Object.getPrototypeOf(payload) === Object.prototype
    && Object.keys(payload).join(',') === 'mode' && payload.mode === 'tailscale') return {mode: 'tailscale'}
  if (!payload || typeof payload !== 'object' || Object.getPrototypeOf(payload) !== Object.prototype
    || Object.keys(payload).sort().join(',') !== 'bootstrapToken,relayUrl'
    || typeof payload.relayUrl !== 'string' || typeof payload.bootstrapToken !== 'string'
    || Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw rejected()
  let url
  try { url = new URL(payload.relayUrl.trim()) } catch { return {error: 'relay_url_invalid'} }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return {error: 'relay_tls_required'}
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return {error: 'relay_url_invalid'}
  const bootstrapToken = payload.bootstrapToken.trim()
  if (CONTROL.test(bootstrapToken)) return {error: 'bootstrap_token_invalid'}
  if (bootstrapToken.length < 32) return {error: 'bootstrap_token_too_short'}
  return {relayUrl: url.origin, bootstrapToken}
}

/** Map any failure to a closed code. Error messages may echo request data, so none is forwarded. */
export function spaceCreateErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error?.message
  if (code === 'bootstrap_denied') return 'bootstrap_denied'
  if (['tailscale_not_installed', 'tailscale_unavailable', 'tailscale_not_running', 'tailscale_https_required',
    'tailscale_port_in_use', 'tailscale_identity_changed', 'tailscale_serve_failed'].includes(code)) return code
  if (['tls_required', 'origin_url_required', 'relay_tls_origin_required'].includes(code)) return 'relay_tls_required'
  if (code === 'space_personal_path_exists') return 'space_data_exists'
  if (['space_config_permissions', 'space_config_capacity', 'space_identity_mismatch', 'space_config_invalid'].includes(code)) return 'space_config_invalid'
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || (error instanceof TypeError && /fetch/iu.test(error.message))) return 'relay_unreachable'
  if (typeof error?.status === 'number' && error.status >= 400) return 'relay_rejected'
  return 'space_create_failed'
}

async function privateDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700})
  const info = await lstat(directory)
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw Object.assign(new Error('space_directory_not_private'), {code: 'space_directory_not_private'})
}

/**
 * The Space lives at a fixed main-owned path. An unfinished registration
 * (config written, relay unreachable) resumes the same identity on the same
 * relay; on a different relay it is archived and a new Space is created.
 */
export function createSpaceCreateHandler({allowed, directory, configured, loadRuntime, persist, prepareRelay}) {
  let inFlight = false
  return async (event, payload) => {
    if (!allowed(event)) throw rejected()
    let request = parseSpaceCreateRequest(payload)
    if (request.error) return {ok: false, error: request.error}
    if (configured()) return {ok: false, error: 'space_already_created'}
    if (inFlight) return {ok: false, error: 'space_create_busy'}
    inFlight = true
    try {
      if (request.mode === 'tailscale') request = parseSpaceCreateRequest(await prepareRelay())
      if (request.error) return {ok: false, error: request.error}
      const runtime = await loadRuntime()
      const root = directory(), configPath = join(root, 'config.json'), personalPath = join(root, 'personal.json')
      await privateDirectory(root)
      const missing = error => {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      let info = await lstat(configPath).catch(missing)
      // An interrupted first write leaves a zero-byte file that holds no identity.
      if (info?.isFile() && info.size === 0) { await unlink(configPath); info = null }
      let resume = false
      if (info) {
        let relayUrl
        try { relayUrl = new URL(runtime.readHostSpaceConfig(configPath).relay_url).origin } catch (error) {
          throw error?.code ? error : Object.assign(new Error('space_config_invalid'), {code: 'space_config_invalid'})
        }
        if (relayUrl === request.relayUrl) resume = true
        else {
          // Unregistered (configured() is false) and no personal data: the half-made Space
          // is pinned to a mistyped relay. Archive it aside rather than leave a dead end.
          const personal = await lstat(personalPath).catch(missing)
          if (personal && personal.size > 0) return {ok: false, error: 'space_relay_mismatch', relayUrl}
          await rename(configPath, join(root, `config.unfinished-${Date.now()}.json`))
        }
      }
      if (resume) await runtime.resumeHostSpaceRegistration({configPath, bootstrapToken: request.bootstrapToken})
      else await runtime.initializeHostSpace({configPath, personalPath, relayUrl: request.relayUrl, bootstrapToken: request.bootstrapToken})
      await persist(configPath)
      return {ok: true}
    } catch (error) {
      if (error?.code === 'space_directory_not_private') return {ok: false, error: 'space_directory_not_private'}
      console.error(`[desktop-diagnostic] space_create_failure code=${spaceCreateErrorCode(error)}`)
      return {ok: false, error: spaceCreateErrorCode(error)}
    } finally {
      inFlight = false
    }
  }
}
