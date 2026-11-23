import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'

import {
  hostBinaryFromConfig,
  hostWorkspaceFromConfig,
} from './process-owner.js'
import type {HostBinary, HostWorkspace} from './process-owner.js'
import {
  hostManagedProjectRootFromConfig,
  hostProjectRootFromConfig,
  type HostManagedProjectRoot,
  type HostProjectRoot,
} from '../../projects/project-store.js'
import type {Settings} from '../../config/config.js'
import {isWellFormed, stripLikePython} from '../../text/python-text.js'

const resolvedCodexHostConfigBrand: unique symbol = Symbol('ResolvedCodexHostConfig')
const codexCredentialProfileBrand: unique symbol = Symbol('CodexCredentialProfile')
const credentialValues = new WeakMap<CodexCredentialProfile, string | null>()

export type CodexHostConfigurationCode =
  | 'codex_workspace_missing'
  | 'codex_workspace_invalid'
  | 'codex_binary_invalid'
  | 'codex_host_unavailable'
  | 'codex_project_host_unsupported'
  | 'codex_project_state_invalid'
  | 'codex_managed_root_invalid'

export class CodexHostConfigurationError extends Error {
  constructor(readonly code: CodexHostConfigurationCode) {
    super(code)
    this.name = 'CodexHostConfigurationError'
  }
}

export interface CodexHostCatalog {
  readonly canonicalBinaries: readonly string[]
  readonly canonicalWorkspaces: readonly string[]
  readonly defaultBinary: string | null
  readonly homeDirectory: string
}

export interface CodexCredentialProfile {
  readonly [codexCredentialProfileBrand]: true
}

/** Backend-neutral project roots every coding backend (Codex app-server or ACP) runs inside. */
interface CodingHostConfigBase {
  readonly [resolvedCodexHostConfigBrand]: true
  readonly workspace: HostWorkspace
  readonly prewarm: boolean
  readonly workingInterval: number
  readonly eagerProgress: boolean
  readonly codexApprovalMode: 'ask' | 'yolo'
  readonly stateRoot: HostProjectRoot
  readonly managedRoot: HostManagedProjectRoot
}

/** Coding host with a usable Codex launch tuple. */
export interface ResolvedCodexHostConfig extends CodingHostConfigBase {
  readonly codexAvailable: true
  readonly localCodexHome?: string
  readonly binary: HostBinary
  readonly binaryPrefixArgs: readonly string[]
  readonly credential: CodexCredentialProfile
}

/** Coding host for an ACP default backend on a machine without a usable Codex CLI. */
export interface ResolvedAcpCodingHostConfig extends CodingHostConfigBase {
  readonly codexAvailable: false
}

export type ResolvedCodingHostConfig = ResolvedCodexHostConfig | ResolvedAcpCodingHostConfig

/** Codex selected as the default backend: the Codex binary is mandatory. */
export function resolveCodexHostConfig(
  settings: Settings,
  catalog: CodexHostCatalog,
): ResolvedCodexHostConfig | null {
  if (!settings.executors.includes('codex')) return null
  const {safeCatalog, workspacePath} = resolveCatalogWorkspace(settings, catalog)
  if (
    safeCatalog.canonicalBinaries.length === 0
    || safeCatalog.canonicalWorkspaces.length === 0
  ) throw new CodexHostConfigurationError('codex_host_unavailable')
  const workspace = resolveWorkspace(workspacePath, safeCatalog)
  const launch = resolveCodexLaunch(settings, safeCatalog)
  const roots = resolveProjectRoots(settings, safeCatalog)
  return Object.freeze({
    ...codingBase(settings, workspace, roots),
    codexAvailable: true as const,
    localCodexHome: ensureLocalCodexHome(safeCatalog),
    ...launch,
  })
}

/**
 * Coding host for the selected default backend. Codex stays mandatory when it is the default;
 * an ACP default only needs the workspace and project roots, and Codex becomes an optional
 * extra backend that is present only when its binary resolves.
 */
export function resolveCodingHostConfig(
  settings: Settings,
  catalog: CodexHostCatalog,
): ResolvedCodingHostConfig | null {
  if (settings.coding_backend === 'codex') return resolveCodexHostConfig(settings, catalog)
  if (!settings.executors.includes('codex')) return null
  const {safeCatalog, workspacePath} = resolveCatalogWorkspace(settings, catalog)
  if (safeCatalog.canonicalWorkspaces.length === 0) throw new CodexHostConfigurationError('codex_workspace_invalid')
  const workspace = resolveWorkspace(workspacePath, safeCatalog)
  const roots = resolveProjectRoots(settings, safeCatalog)
  const base = codingBase(settings, workspace, roots)
  // Codex is optional here: any failure resolving its launch tuple or home drops Codex, never the ACP default.
  let codex: {readonly localCodexHome: string} & ReturnType<typeof resolveCodexLaunch>
  try {
    codex = {...resolveCodexLaunch(settings, safeCatalog), localCodexHome: ensureLocalCodexHome(safeCatalog)}
  } catch {
    return Object.freeze({...base, codexAvailable: false as const})
  }
  return Object.freeze({...base, codexAvailable: true as const, ...codex})
}

function resolveCatalogWorkspace(
  settings: Settings,
  catalog: CodexHostCatalog,
): {readonly safeCatalog: CodexHostCatalog; readonly workspacePath: string} {
  const configuredWorkspace = stripLikePython(settings.codex_workspace ?? '')
  if (configuredWorkspace === '') throw new CodexHostConfigurationError('codex_workspace_missing')
  const safeCatalog = validateCatalog(catalog)
  return {safeCatalog, workspacePath: expandUserPath(configuredWorkspace, safeCatalog.homeDirectory)}
}

function resolveWorkspace(workspacePath: string, catalog: CodexHostCatalog): HostWorkspace {
  try {
    return hostWorkspaceFromConfig(workspacePath, catalog.canonicalWorkspaces)
  } catch {
    throw new CodexHostConfigurationError('codex_workspace_invalid')
  }
}

function resolveCodexLaunch(settings: Settings, catalog: CodexHostCatalog): {
  readonly binary: HostBinary
  readonly binaryPrefixArgs: readonly string[]
  readonly credential: CodexCredentialProfile
} {
  if (catalog.canonicalBinaries.length === 0) throw new CodexHostConfigurationError('codex_host_unavailable')
  const selector = stripLikePython(settings.codex_bin)
  if (selector === 'codex' && catalog.defaultBinary === null) {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  const selectedBinary = selector === 'codex' ? catalog.defaultBinary : selector
  if (
    selectedBinary === null
    || !isAbsolute(selectedBinary)
    || hasRejectedScriptSuffix(selectedBinary)
  ) throw new CodexHostConfigurationError('codex_binary_invalid')
  let binary: HostBinary
  try {
    binary = hostBinaryFromConfig(selectedBinary, catalog.canonicalBinaries)
  } catch {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
  const binaryPrefixArgs = resolveBinaryPrefixArgs(settings.codex_prefix_args)
  const credential = Object.freeze({[codexCredentialProfileBrand]: true as const})
  credentialValues.set(credential, settings.codex_api_key)
  return {binary, binaryPrefixArgs, credential}
}

function resolveProjectRoots(settings: Settings, catalog: CodexHostCatalog): {
  readonly stateRoot: HostProjectRoot
  readonly managedRoot: HostManagedProjectRoot
} {
  let stateRoot: HostProjectRoot
  try {
    stateRoot = hostProjectRootFromConfig(ensurePrivateDirectory(expandUserPath(
      settings.codex_project_state_root,
      catalog.homeDirectory,
    )))
  } catch {
    throw new CodexHostConfigurationError('codex_project_state_invalid')
  }
  let managedRoot: HostManagedProjectRoot
  try {
    managedRoot = hostManagedProjectRootFromConfig(ensurePrivateDirectory(expandUserPath(
      settings.codex_managed_root,
      catalog.homeDirectory,
    )))
  } catch {
    throw new CodexHostConfigurationError('codex_managed_root_invalid')
  }
  return {stateRoot, managedRoot}
}

function ensureLocalCodexHome(catalog: CodexHostCatalog): string {
  const localCodexHome = join(catalog.homeDirectory, '.codex')
  try { lstatSync(localCodexHome) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // The selected user home already exists; preserve its ACL inheritance on Windows.
    mkdirSync(localCodexHome, {mode: 0o700})
  }
  return realpathSync(localCodexHome)
}

function codingBase(
  settings: Settings,
  workspace: HostWorkspace,
  roots: {readonly stateRoot: HostProjectRoot; readonly managedRoot: HostManagedProjectRoot},
): CodingHostConfigBase {
  return {
    [resolvedCodexHostConfigBrand]: true as const,
    workspace,
    prewarm: settings.codex_prewarm,
    workingInterval: settings.codex_working_interval,
    eagerProgress: settings.proactivity_preset === 'eager',
    codexApprovalMode: settings.codex_approval_mode,
    stateRoot: roots.stateRoot,
    managedRoot: roots.managedRoot,
  }
}

function resolveBinaryPrefixArgs(configured: readonly string[]): readonly string[] {
  if (!Array.isArray(configured) || configured.length > 1) {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
  const result: string[] = []
  for (const value of configured) {
    if (typeof value !== 'string' || !isWellFormed(value) || !isAbsolute(value)
      || !value.toLowerCase().endsWith('.js')) {
      throw new CodexHostConfigurationError('codex_binary_invalid')
    }
    try {
      const canonical = realpathSync(value)
      const info = lstatSync(canonical)
      if (info.isSymbolicLink() || !info.isFile() || canonical !== resolve(value)) throw new Error()
      result.push(canonical)
    } catch {
      throw new CodexHostConfigurationError('codex_binary_invalid')
    }
  }
  return Object.freeze(result)
}

/** Internal host accessor; this module is intentionally absent from the runtime root exports. */
export function codexCredentialApiKey(profile: CodexCredentialProfile): string | null {
  const value = credentialValues.get(profile)
  if (value === undefined && !credentialValues.has(profile)) {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
  return value ?? null
}

function validateCatalog(catalog: CodexHostCatalog): CodexHostCatalog {
  try {
    if (
      !Array.isArray(catalog.canonicalBinaries)
      || !Array.isArray(catalog.canonicalWorkspaces)
      || typeof catalog.homeDirectory !== 'string'
      || !isWellFormed(catalog.homeDirectory)
      || !isAbsolute(catalog.homeDirectory)
    ) throw new Error('invalid catalog')
    const homeInfo = lstatSync(catalog.homeDirectory)
    if (
      homeInfo.isSymbolicLink()
      || !homeInfo.isDirectory()
      || realpathSync(catalog.homeDirectory) !== resolve(catalog.homeDirectory)
    ) throw new Error('invalid catalog')
    if (
      catalog.defaultBinary !== null
      && (typeof catalog.defaultBinary !== 'string' || !isWellFormed(catalog.defaultBinary))
    ) throw new Error('invalid catalog')
    for (const values of [catalog.canonicalBinaries, catalog.canonicalWorkspaces]) {
      for (const value of values) {
        if (typeof value !== 'string' || !isWellFormed(value) || !isAbsolute(value)) {
          throw new Error('invalid catalog')
        }
      }
    }
    return catalog
  } catch {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
}

export function expandUserPath(configured: string, homeDirectory: string): string {
  const value = stripLikePython(configured)
  if (value === '~') return homeDirectory
  if (value.startsWith('~/')) return join(homeDirectory, value.slice(2))
  return value
}

function ensurePrivateDirectory(path: string): string {
  try {
    lstatSync(path)
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Node cannot create or validate a protected DACL. The desktop bootstrap
    // must create missing Windows roots through the packaged native host
    // before runtime configuration is resolved.
    if (process.platform === 'win32') throw error
    const parent = dirname(path)
    const name = basename(path)
    if (parent === path || name === '' || name === '.' || name === '..') throw error
    ensurePrivateDirectory(parent)
    createPrivateDirectory(parent, path)
  }
  return path
}

function createPrivateDirectory(parent: string, path: string): void {
  const descriptor = openSync(
    parent,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  let childDescriptor: number | null = null
  try {
    const retainedParent = fstatSync(descriptor, {bigint: true})
    const currentParent = lstatSync(parent, {bigint: true})
    if (
      !retainedParent.isDirectory()
      || !sameIdentity(retainedParent, currentParent)
      || !ownedByCurrentUser(retainedParent.uid)
      || !safeParentMode(retainedParent.mode)
      || realpathSync(parent) !== resolve(parent)
    ) throw new Error('unsafe parent')
    mkdirSync(path, {mode: 0o700})
    const created = lstatSync(path, {bigint: true})
    childDescriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const opened = fstatSync(childDescriptor, {bigint: true})
    if (
      !opened.isDirectory()
      || !sameIdentity(created, opened)
      || !ownedByCurrentUser(opened.uid)
      || !privateDirectoryMode(opened.mode)
    ) throw new Error('unsafe created directory')
    const verified = fstatSync(childDescriptor, {bigint: true})
    const current = lstatSync(path, {bigint: true})
    const verifiedParent = fstatSync(descriptor, {bigint: true})
    const currentParentAfterCreate = lstatSync(parent, {bigint: true})
    if (
      !sameIdentity(opened, verified)
      || !sameIdentity(opened, current)
      || !sameIdentity(retainedParent, verifiedParent)
      || !sameIdentity(retainedParent, currentParentAfterCreate)
      || !privateDirectoryMode(verified.mode)
      || realpathSync(path) !== resolve(path)
      || dirname(realpathSync(path)) !== realpathSync(parent)
    ) throw new Error('created directory replaced')
  } finally {
    if (childDescriptor !== null) closeSync(childDescriptor)
    closeSync(descriptor)
  }
}

function sameIdentity(
  left: {readonly dev: bigint; readonly ino: bigint},
  right: {readonly dev: bigint; readonly ino: bigint},
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function ownedByCurrentUser(uid: bigint): boolean {
  return typeof process.getuid !== 'function' || uid === BigInt(process.getuid())
}

function safeParentMode(mode: bigint): boolean {
  return (mode & 0o7022n) === 0n
}

function privateDirectoryMode(mode: bigint): boolean {
  return (mode & 0o7777n) === 0o700n
}

function hasRejectedScriptSuffix(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')
}
