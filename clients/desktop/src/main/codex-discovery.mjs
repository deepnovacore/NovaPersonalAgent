const SOURCES = new Set(['path', 'npm-user', 'common', 'manual', 'npm-launcher'])

function normalizeCandidatePath(value, platform) {
  return platform === 'win32' ? value.toLowerCase() : value
}

function appendNative(target, seen, command, source, platform) {
  if (typeof command !== 'string' || command === '') return
  const key = `native\0${normalizeCandidatePath(command, platform)}`
  if (seen.has(key)) return
  seen.add(key)
  target.push(Object.freeze({
    kind: 'native', command, prefixArgs: Object.freeze([]), source,
  }))
}

function appendNpmLauncher(target, seen, candidate, platform) {
  const key = `npm-launcher\0${normalizeCandidatePath(candidate.command, platform)}\0${candidate.prefixArgs.map(value => normalizeCandidatePath(value, platform)).join('\0')}\0${normalizeCandidatePath(candidate.launcherPath, platform)}`
  if (seen.has(key)) return
  seen.add(key)
  target.push(Object.freeze({
    ...candidate,
    kind: 'npm-launcher',
    prefixArgs: Object.freeze([...candidate.prefixArgs]),
    source: 'npm-launcher',
  }))
}

function windowsNpmCandidates({ root, arch, pathApi }) {
  const packageArch = arch === 'arm64' ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const platformPackage = `codex-win32-${packageArch}`
  const packageRoots = [
    pathApi.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', platformPackage),
    pathApi.join(root, 'node_modules', '@openai', platformPackage),
  ]
  return packageRoots.flatMap(packageRoot => [
    pathApi.join(packageRoot, 'vendor', triple, 'codex', 'codex.exe'),
    pathApi.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
  ])
}

function windowsNpmPrefixes({ pathEntries, env, home, pathApi, manualBinaryPath }) {
  const appData = typeof env.APPDATA === 'string' && env.APPDATA !== ''
    ? env.APPDATA
    : pathApi.join(home, 'AppData', 'Roaming')
  const manualRoot = typeof manualBinaryPath === 'string'
    && pathApi.basename(manualBinaryPath).toLowerCase() === 'codex.cmd'
    ? pathApi.dirname(manualBinaryPath)
    : null
  const roots = [
    ...pathEntries,
    env.NPM_CONFIG_PREFIX,
    env.npm_config_prefix,
    pathApi.join(appData, 'npm'),
    manualRoot,
  ].filter(value => typeof value === 'string' && value !== '')
  const result = []
  const seen = new Set()
  for (const root of roots) {
    const key = normalizeCandidatePath(root, 'win32')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(root)
  }
  return result
}

export function codexCandidates({ platform, arch, env = {}, home, pathApi, manualBinaryPath }) {
  const candidates = []
  const seen = new Set()
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathEntries = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const entry of pathEntries) {
    if (platform === 'win32') {
      appendNative(candidates, seen, pathApi.join(entry, 'codex.exe'), 'path', platform)
      appendNative(candidates, seen, pathApi.join(entry, 'codex'), 'path', platform)
    } else {
      appendNative(candidates, seen, pathApi.join(entry, 'codex'), 'path', platform)
    }
  }
  if (platform === 'win32') {
    const nodeCommands = [...new Set(pathEntries.map(entry => pathApi.join(entry, 'node.exe')))]
    for (const root of windowsNpmPrefixes({pathEntries, env, home, pathApi, manualBinaryPath})) {
      for (const command of windowsNpmCandidates({root, arch, pathApi})) {
        appendNative(candidates, seen, command, 'npm-user', platform)
      }
      const packageRoot = pathApi.join(root, 'node_modules', '@openai', 'codex')
      const launcherPath = pathApi.join(root, 'codex.cmd')
      const nodeCandidates = [pathApi.join(root, 'node.exe'), ...nodeCommands]
      for (const command of new Set(nodeCandidates)) {
        appendNpmLauncher(candidates, seen, {
          command,
          prefixArgs: [pathApi.join(packageRoot, 'bin', 'codex.js')],
          packageRoot,
          manifestPath: pathApi.join(packageRoot, 'package.json'),
          launcherPath,
        }, platform)
      }
    }
  } else {
    appendNative(candidates, seen, pathApi.join(home, '.local', 'bin', 'codex'), 'common', platform)
    if (platform === 'darwin') {
      appendNative(candidates, seen, pathApi.join(home, '.npm-global', 'bin', 'codex'), 'npm-user', platform)
      appendNative(candidates, seen, pathApi.join(home, '.volta', 'bin', 'codex'), 'npm-user', platform)
      appendNative(candidates, seen, '/opt/homebrew/bin/codex', 'common', platform)
    }
    appendNative(candidates, seen, '/usr/local/bin/codex', 'common', platform)
  }
  return Object.freeze(candidates)
}

function missing() {
  return Object.freeze({
    status: 'missing', invocation: null, path: null, prefixArgs: null,
    source: null, version: null,
  })
}

function safeInvocation(value) {
  if (!value || typeof value !== 'object' || typeof value.command !== 'string'
    || value.command === '' || !Array.isArray(value.prefixArgs)
    || value.prefixArgs.some(arg => typeof arg !== 'string' || arg === '')) return null
  return Object.freeze({
    command: value.command,
    prefixArgs: Object.freeze([...value.prefixArgs]),
  })
}

export async function discoverCodex({ candidates, canonicalize, inspect }) {
  if (!Array.isArray(candidates)) return missing()
  // Candidate enumeration also runs before the source launcher builds runtime.
  const {admitCodexCliVersion} = await import(
    '@nova-personal-agent/runtime/executors/codex/version',
  )
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !SOURCES.has(candidate.source)) continue
    let invocation
    try {
      invocation = safeInvocation(canonicalize(candidate))
    } catch {
      continue
    }
    if (invocation === null) continue
    try {
      const result = await inspect(invocation)
      if (!result || typeof result !== 'object') continue
      const admitted = admitCodexCliVersion(result.version)
      if (admitted === null) continue
      return Object.freeze({
        status: 'ready', invocation, path: invocation.command,
        prefixArgs: invocation.prefixArgs, source: candidate.source,
        version: admitted.display,
      })
    } catch {
      // A candidate that cannot answer the bounded version probe is not usable.
    }
  }
  return missing()
}

export async function resolveDesktopCodex({
  config,
  automaticCandidates,
  canonicalize,
  inspect,
}) {
  const manual = config?.codexBinaryMode === 'manual'
    && typeof config.codexBinaryPath === 'string'
    && config.codexBinaryPath !== ''
  const manualLaunchers = manual
    ? automaticCandidates.filter(candidate => candidate?.kind === 'npm-launcher'
      && typeof candidate.launcherPath === 'string'
      && normalizeCandidatePath(candidate.launcherPath, 'win32')
        === normalizeCandidatePath(config.codexBinaryPath, 'win32'))
    : []
  const candidates = manual
    ? manualLaunchers.length > 0 ? manualLaunchers : [Object.freeze({
        kind: 'native', command: config.codexBinaryPath,
        prefixArgs: Object.freeze([]), source: 'manual',
      })]
    : automaticCandidates
  const status = await discoverCodex({ candidates, canonicalize, inspect })
  return Object.freeze({
    config: Object.freeze({
      ...config,
      codexBinaryPath: status.status === 'ready' ? status.invocation.command : '',
      codexBinaryPrefixArgs: status.status === 'ready'
        ? status.invocation.prefixArgs
        : Object.freeze([]),
    }),
    status,
  })
}
