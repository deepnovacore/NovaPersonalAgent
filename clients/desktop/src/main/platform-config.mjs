import { DATA_ROOT_NAME } from './data-root.mjs'

function nonempty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** `dataRootName` is the active root: the new one, or the legacy one until its one-time migration has run. */
export function productPaths({ home, pathApi, dataRootName = DATA_ROOT_NAME }) {
  const root = pathApi.join(home, dataRootName)
  const managedRoot = pathApi.join(root, 'workspaces')
  return Object.freeze({
    root,
    stateRoot: root,
    managedRoot,
    defaultWorkspace: pathApi.join(managedRoot, 'default'),
  })
}

export function resolveDesktopConfig({
  settings = {},
  environment = {},
  home,
  dataRootName,
  platform,
  pathApi,
  canonicalize = value => pathApi.resolve(value),
}) {
  const defaults = productPaths({ home, pathApi, dataRootName })
  const settingsHasMode = Object.hasOwn(settings, 'codexBinaryMode')
  const settingsBinary = nonempty(settings.codexBinaryPath)
  const environmentBinary = nonempty(environment.CODEX_BIN)
  const settingsMode = settings.codexBinaryMode === 'manual' ? 'manual' : 'auto'
  const codexBinaryMode = environmentBinary !== null
    ? 'manual'
    : (settingsHasMode ? settingsMode : 'auto')
  const binaryPath = codexBinaryMode === 'manual'
    ? environmentBinary ?? settingsBinary ?? ''
    : ''
  const codexConfigurationError = codexBinaryMode === 'manual' && binaryPath === ''
    ? 'manual_path_required'
    : null
  const managedRoot = nonempty(settings.codexManagedRoot)
    || nonempty(environment.CODEX_MANAGED_ROOT)
    || defaults.managedRoot
  const stateRoot = nonempty(environment.CODEX_PROJECT_STATE_ROOT)
    || defaults.stateRoot
  const workspace = nonempty(settings.codexWorkspace)
    || nonempty(environment.CODEX_WORKSPACE)
    || defaults.defaultWorkspace

  void platform
  return Object.freeze({
    root: canonicalize(defaults.root),
    stateRoot: canonicalize(stateRoot),
    managedRoot: canonicalize(managedRoot),
    workspace: canonicalize(workspace),
    codexBinaryMode,
    codexBinaryPath: binaryPath === '' ? '' : canonicalize(binaryPath),
    codexConfigurationError,
    startListeningOnLaunch: settings.startListeningOnLaunch === true,
  })
}

export async function ensureProductDirectories(config, { mkdir, pathApi }) {
  const directories = new Set([config.root, config.stateRoot, config.managedRoot])
  const relativeWorkspace = pathApi.relative(config.managedRoot, config.workspace)
  if (
    relativeWorkspace !== ''
    && relativeWorkspace !== '..'
    && !relativeWorkspace.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativeWorkspace)
  ) {
    directories.add(config.workspace)
  }
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  return config
}
