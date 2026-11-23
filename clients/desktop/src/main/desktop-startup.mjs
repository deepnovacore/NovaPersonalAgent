import {stat} from 'node:fs/promises'
import {t} from '../renderer/locale.mjs'
import {resolveDataRoot} from './data-root.mjs'
import {
  codexCandidates,
  resolveDesktopCodex,
} from './codex-discovery.mjs'
import {
  ensureProductDirectories,
  resolveDesktopConfig,
} from './platform-config.mjs'

const PROBE_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TMP', 'TEMP',
])

/**
 * Budget for one asynchronous configuration wait. A JS timer cannot preempt a
 * synchronous native/fs call that blocks the event loop, so this deadline covers
 * waits that yield; it does not claim every OS call is guaranteed to settle.
 */
export const CONFIGURATION_STAGE_TIMEOUT_MS = 20_000

const STAGE_NAME = /^[a-z_]{1,32}$/u

function stageError(code, stage = null) {
  const error = new Error(code)
  error.code = code
  if (typeof stage === 'string' && STAGE_NAME.test(stage)) error.stage = stage
  return error
}

export function configurationTimeout(stage) {
  return stageError('configuration_timeout', stage)
}

export function configurationSuperseded() {
  return stageError('configuration_superseded')
}

/**
 * One configuration attempt per owner. Aborting it is how a timeout or a newer
 * attempt prevents an older operation from committing after it lost ownership.
 */
export function createConfigurationAttempt() {
  const controller = new AbortController()
  return Object.freeze({
    signal: controller.signal,
    abort(reason = configurationSuperseded()) {
      if (controller.signal.aborted) return false
      controller.abort(reason)
      return true
    },
    current(isActive = () => true) {
      return !controller.signal.aborted && isActive(this)
    },
  })
}

/**
 * Bounds one wait and reports the stage that owns it. Aborting the attempt
 * rejects immediately, and the race keeps ownership local: a late value is
 * handed to `onLateResult` for cleanup instead of being allowed to continue
 * into the caller's commit.
 */
export async function runConfigurationStage(attempt, stage, operation, {
  onStage = () => {},
  timeoutMs = CONFIGURATION_STAGE_TIMEOUT_MS,
  onLateResult = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!attempt.current()) throw configurationSuperseded()
  onStage(stage)
  let settled = false
  let timer = null
  const work = Promise.resolve().then(operation).then(value => {
    if (settled && !attempt.current()) disposeLateResult(onLateResult, value)
    return value
  })
  let onAbort = null
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(configurationSuperseded())
    if (attempt.signal.aborted) onAbort()
    else attempt.signal.addEventListener('abort', onAbort, {once: true})
  })
  const deadline = new Promise((_, reject) => {
    timer = schedule(() => reject(configurationTimeout(stage)), timeoutMs)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  })
  try {
    const value = await Promise.race([work, deadline, aborted])
    if (!attempt.current()) {
      disposeLateResult(onLateResult, value)
      throw configurationSuperseded()
    }
    return value
  } catch (error) {
    if (error?.code === 'configuration_timeout') attempt.abort(error)
    throw error
  } finally {
    settled = true
    if (timer !== null) cancel(timer)
    if (onAbort !== null) attempt.signal.removeEventListener('abort', onAbort)
  }
}

function disposeLateResult(onLateResult, value) {
  // Late cleanup may be async or throw. Neither may surface as an unhandled rejection.
  Promise.resolve().then(() => onLateResult(value)).catch(() => {})
}

export function inspectCodexVersion(invocation, { environment = {}, run }) {
  const env = {}
  for (const key of PROBE_ENV_KEYS) {
    if (typeof environment[key] === 'string') env[key] = environment[key]
  }
  const result = run(invocation.command, [...invocation.prefixArgs, '--version'], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    maxBuffer: 64 * 1_024,
    windowsHide: true,
  })
  if (result?.status !== 0 || typeof result.stdout !== 'string') return null
  return Object.freeze({ version: result.stdout.trim() })
}

export function canonicalInstalledExecutable(candidate, {
  platform,
  realpath,
  stat,
  access,
}) {
  try {
    const canonical = realpath(candidate)
    if (!stat(canonical).isFile()) return null
    const lower = canonical.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) return null
    if (platform === 'win32' && !lower.endsWith('.exe')) return null
    if (platform !== 'win32') access(canonical)
    return canonical
  } catch {
    return null
  }
}

export function canonicalInstalledInvocation(candidate, dependencies) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.prefixArgs)) return null
  if (candidate.kind === 'native') {
    const command = canonicalInstalledExecutable(candidate.command, dependencies)
    if (command === null) return null
    if (dependencies.platform === 'darwin' && command.endsWith('.js')) {
      const native = canonicalDarwinNpmBinary(command, dependencies)
      if (native !== null) return Object.freeze({command: native, prefixArgs: Object.freeze([])})
    }
    return Object.freeze({command, prefixArgs: Object.freeze([])})
  }
  if (candidate.kind !== 'npm-launcher' || dependencies.platform !== 'win32'
    || candidate.prefixArgs.length !== 1) return null
  try {
    const {pathApi, realpath, stat, readFile} = dependencies
    const command = canonicalInstalledExecutable(candidate.command, dependencies)
    if (command === null) return null
    const launcher = realpath(candidate.launcherPath)
    if (!launcher.toLowerCase().endsWith('codex.cmd') || !stat(launcher).isFile()) return null
    const packageRoot = realpath(candidate.packageRoot)
    if (!stat(packageRoot).isDirectory()) return null
    const manifest = realpath(candidate.manifestPath)
    if (manifest !== pathApi.join(packageRoot, 'package.json') || !stat(manifest).isFile()) return null
    const parsed = JSON.parse(readFile(manifest, 'utf8'))
    const bin = typeof parsed?.bin === 'string' ? parsed.bin : parsed?.bin?.codex
    if (parsed?.name !== '@openai/codex' || bin !== 'bin/codex.js') return null
    const entry = realpath(candidate.prefixArgs[0])
    if (entry !== pathApi.join(packageRoot, 'bin', 'codex.js') || !stat(entry).isFile()) return null
    const relative = pathApi.relative(packageRoot, entry)
    if (relative === '' || relative === '..' || relative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(relative)) return null
    return Object.freeze({command, prefixArgs: Object.freeze([entry])})
  } catch {
    return null
  }
}

function canonicalDarwinNpmBinary(entry, dependencies) {
  const {arch, pathApi, realpath, stat, readFile} = dependencies
  if (arch !== 'arm64' && arch !== 'x64') return null
  try {
    const packageRoot = realpath(pathApi.resolve(pathApi.dirname(entry), '..'))
    if (!stat(packageRoot).isDirectory()) return null
    const manifest = realpath(pathApi.join(packageRoot, 'package.json'))
    const parsed = JSON.parse(readFile(manifest, 'utf8'))
    const bin = typeof parsed?.bin === 'string' ? parsed.bin : parsed?.bin?.codex
    if (parsed?.name !== '@openai/codex' || bin !== 'bin/codex.js'
      || entry !== realpath(pathApi.join(packageRoot, bin))) return null
    const platformPackage = `codex-darwin-${arch}`
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    for (const candidateRoot of [
      pathApi.join(packageRoot, 'node_modules', '@openai', platformPackage),
      pathApi.resolve(packageRoot, '..', platformPackage),
    ]) {
      let platformRoot
      try { platformRoot = realpath(candidateRoot) } catch { continue }
      if (!stat(platformRoot).isDirectory()) continue
      const platformManifest = realpath(pathApi.join(platformRoot, 'package.json'))
      const platformPackageJson = JSON.parse(readFile(platformManifest, 'utf8'))
      if (platformPackageJson?.name !== '@openai/codex'
        || !Array.isArray(platformPackageJson.os) || platformPackageJson.os.length !== 1
        || platformPackageJson.os[0] !== 'darwin'
        || !Array.isArray(platformPackageJson.cpu) || platformPackageJson.cpu.length !== 1
        || platformPackageJson.cpu[0] !== arch) continue
      const native = canonicalInstalledExecutable(
        pathApi.join(platformRoot, 'vendor', triple, 'bin', 'codex'),
        dependencies,
      )
      if (native !== null) return native
    }
  } catch {}
  return null
}

export async function prepareDesktopStartup({
  settings,
  environment,
  home,
  dataRootName,
  platform,
  arch,
  pathApi,
  canonicalizePath,
  canonicalizeExecutable,
  canonicalizeInvocation,
  mkdir,
  inspectCodex,
  inspectWorkspace = stat,
  ensureDirectories = config => ensureProductDirectories(config, { mkdir, pathApi }),
  runStage = (stage, operation) => operation(),
}) {
  const config = resolveDesktopConfig({
    settings,
    environment,
    home,
    // The legacy root stays active until its one-time migration has run.
    dataRootName: dataRootName ?? pathApi.basename(resolveDataRoot(home).root),
    platform,
    pathApi,
    canonicalize: canonicalizePath,
  })
  if (settings.codexWorkspace?.trim() || environment.CODEX_WORKSPACE?.trim()) {
    await runStage('workspace', async () => {
      let workspace
      try { workspace = await inspectWorkspace(config.workspace) }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw Object.assign(new Error('workspace_not_found'), {code: 'workspace_not_found'})
        throw error
      }
      if (!workspace.isDirectory()) throw Object.assign(new Error('workspace_invalid'), {code: 'workspace_invalid'})
    })
  }
  await runStage('directories', () => ensureDirectories(config))
  const { config: resolved, status } = await runStage('codex', () => resolveDesktopCodex({
    config,
    automaticCandidates: codexCandidates({
      platform,
      arch,
      env: environment,
      home,
      pathApi,
      manualBinaryPath: config.codexBinaryMode === 'manual' ? config.codexBinaryPath : undefined,
    }),
    canonicalize: canonicalizeInvocation ?? (candidate => {
      const command = canonicalizeExecutable(candidate.command)
      return command === null ? null : {command, prefixArgs: candidate.prefixArgs}
    }),
    inspect: inspectCodex,
  }))
  return Object.freeze({ config: resolved, codexStatus: status })
}

export function createLifecycleCoordinator({ onChange = () => {} } = {}) {
  let owner = null

  return Object.freeze({
    get busy() {
      return owner !== null
    },
    get owner() {
      return owner
    },
    async run(kind, operation) {
      if (owner !== null) return Object.freeze({ status: 'busy' })
      owner = kind
      onChange(Object.freeze({ busy: true, owner }))
      try {
        return Object.freeze({ status: 'completed', value: await operation() })
      } finally {
        owner = null
        onChange(Object.freeze({ busy: false, owner: null }))
      }
    },
  })
}

const MESSAGE_CODES = new Set([
  'project_directory_authority_unavailable',
  'project_directory_open_failed',
  'project_directory_open_failed_home',
  'project_directory_open_failed_root',
  'project_directory_open_failed_state',
  'project_directory_open_failed_managed',
  'project_directory_open_failed_workspace',
  'project_directory_create_failed',
  'project_directory_protection_failed',
])

export function startupFailureCode(error) {
  if (error?.code === 'configuration_superseded') return 'configuration_timeout'
  if (['embedding_provider_invalid', 'credential_access_failed', 'credential_invalid', 'startup_presentation_required', 'filesystem_permissions', 'workspace_not_found', 'workspace_invalid', 'state_permissions', 'state_busy', 'state_lock_failed', 'personal_store_locked', 'configuration_timeout'].includes(error?.code)) return error.code
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'filesystem_permissions'
  if (MESSAGE_CODES.has(error?.message)) return error.message
  if (error?.name === 'MainCameraConfigurationError') return 'camera_configuration_invalid'
  if (error?.message === 'BACKEND must be node') {
    return 'backend_selection_invalid'
  }
  return 'startup_failed'
}

export function reportStartupFailure(error, {
  write = chunk => process.stderr.write(chunk),
  showError,
} = {}) {
  const code = startupFailureCode(error)
  const stage = typeof error?.stage === 'string' && STAGE_NAME.test(error.stage) ? ` stage=${error.stage}` : ''
  write(`[desktop-diagnostic] startup_failure code=${code}${stage}\n`)
  if (code === 'embedding_provider_invalid') {
    showError?.(t("embeddingProvider 仅支持 dashscope，后端未启动，原配置未修改。请在设置文件中明确选择云端服务后再重启。"))
  } else showError?.(t("启动失败，请打开设置检查配置后重试。"))
  return code
}
