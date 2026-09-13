import {isWellFormed} from '../../python-text.js'
import {managedMcpEnvironment, type ManagedCodexMcp} from './managed-mcp.js'
import {realpathSync, type BigIntStats} from 'node:fs'
import {chmod, lstat, rename, rm, stat} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {basename, dirname, join} from 'node:path'
import {hostCodexHomeValue, refreshEphemeralCodexHomeIdentity, type HostCodexHome} from './process-owner.js'
import {CodexCredentialError, createCodexEnvironment, snapshotEnvironmentInput} from './spawn-env.js'
export {CodexCredentialError, environmentValue} from './spawn-env.js'

export type CodexCredentialDiagnosticCode =
  | 'codex_credential_snapshot_private_home_failed'
  | 'codex_credential_snapshot_environment_failed'

type CredentialPreparationPhase = 'private_home' | 'environment'

const credentialSnapshotBrand: unique symbol = Symbol('CredentialSnapshot')
export interface CredentialSnapshot { readonly [credentialSnapshotBrand]: true }

interface SnapshotValue {
  readonly environment: Readonly<Record<string, string>>
}

const snapshotValues = new WeakMap<CredentialSnapshot, SnapshotValue>()

export class CredentialSnapshotter {
  readonly #environment: Readonly<Record<string, string>>
  readonly #platform: NodeJS.Platform
  readonly #onDiagnostic: (code: CodexCredentialDiagnosticCode) => void

  constructor(options: {
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly onDiagnostic?: (code: CodexCredentialDiagnosticCode) => void
  }) {
    this.#environment = snapshotEnvironmentInput(options.environment)
    this.#platform = options.platform ?? process.platform
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  async prepare(input: {
    readonly codexHome: HostCodexHome
    readonly apiKey: string | null
    readonly managedMcp?: ManagedCodexMcp
    readonly preserveHome?: boolean | undefined
  }): Promise<CredentialSnapshot> {
    let phase: CredentialPreparationPhase = 'private_home'
    try {
      const home = hostCodexHomeValue(input.codexHome)
      if (home.ephemeral) await ensureEphemeralDirectory(input.codexHome)
      else await requirePrivateDirectory(home.path, input.preserveHome === true)
      phase = 'environment'
      const childEnvironment = createCodexEnvironment(this.#environment, home.path, input.apiKey,
        managedMcpEnvironment(input.managedMcp), this.#platform)
      const snapshot = Object.freeze({[credentialSnapshotBrand]: true as const})
      snapshotValues.set(snapshot, Object.freeze({environment: childEnvironment}))
      return snapshot
    } catch {
      this.#emitDiagnostic(credentialDiagnosticForPhase(phase))
      throw new CodexCredentialError()
    }
  }

  #emitDiagnostic(code: CodexCredentialDiagnosticCode): void {
    try { this.#onDiagnostic(code) } catch { /* diagnostics must not affect credential handling */ }
  }

  async removeEphemeralHome(home: HostCodexHome): Promise<void> {
    await removeEphemeralHome(home)
  }

  environment(snapshot: CredentialSnapshot): Readonly<Record<string, string>> {
    return credentialSnapshotEnvironment(snapshot)
  }

}

function credentialDiagnosticForPhase(
  phase: CredentialPreparationPhase,
): CodexCredentialDiagnosticCode {
  switch (phase) {
    case 'private_home': return 'codex_credential_snapshot_private_home_failed'
    case 'environment': return 'codex_credential_snapshot_environment_failed'
  }
}

/** Test-only scheduler seam for proving cleanup identity remains bound across a rename race. */
export async function removeEphemeralHomeWithRaceHookForTest(
  home: HostCodexHome,
  afterIdentityCheck: (path: string) => Promise<void>,
): Promise<void> {
  await removeEphemeralHome(home, afterIdentityCheck)
}

async function removeEphemeralHome(
  home: HostCodexHome,
  afterQuarantineRename?: (path: string) => Promise<void>,
): Promise<void> {
  try {
    const selected = hostCodexHomeValue(home)
    if (!selected.ephemeral) return
    const identity = selected.identity
    if (identity === null) throw new CodexCredentialError()
    let cleanupPath = selected.cleanupPath
    if (cleanupPath === null) {
      let linkInfo
      try { linkInfo = await lstat(selected.path, {bigint: true}) }
      catch (error) { if (isErrno(error, 'ENOENT')) return; throw error }
      requireCleanupIdentity(selected.path, linkInfo, identity)
      if (process.platform !== 'win32') await chmod(selected.path, 0o700)
      requireCleanupIdentity(
        selected.path,
        await lstat(selected.path, {bigint: true}),
        identity,
      )
      cleanupPath = join(
        dirname(selected.path),
        `.${basename(selected.path)}.nova-delete-${randomUUID().replaceAll('-', '')}`,
      )
      try {
        await lstat(cleanupPath)
        throw new CodexCredentialError()
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      await rename(selected.path, cleanupPath)
      selected.cleanupPath = cleanupPath
      await afterQuarantineRename?.(cleanupPath)
    }
    const quarantined = await lstat(cleanupPath, {bigint: true})
    requireCleanupIdentity(cleanupPath, quarantined, identity)
    if (process.platform !== 'win32') await chmod(cleanupPath, 0o700)
    await requirePrivateDirectory(cleanupPath)
    requireCleanupIdentity(cleanupPath, await lstat(cleanupPath, {bigint: true}), identity)
    // Security precondition: the transport calls this only after the one owned app-server tree is
    // confirmed gone. Node has no fd-relative recursive removal API, so the private-parent,
    // quarantine rename, and device/inode capability bind the path once that sole actor is dead.
    await rm(cleanupPath, {recursive: true, force: false})
    selected.cleanupPath = null
  } catch {
    throw new CodexCredentialError()
  }
}

function requireCleanupIdentity(
  path: string,
  linkInfo: BigIntStats,
  identity: {readonly device: bigint; readonly inode: bigint; readonly uid: number},
): void {
  const invalid = linkInfo.isSymbolicLink()
    || !linkInfo.isDirectory()
    || linkInfo.dev !== identity.device
    || linkInfo.ino !== identity.inode
    || Number(linkInfo.uid) !== identity.uid
    || !ownerMatches(Number(linkInfo.uid))
    // Use the same sync canonicalization domain that minted the cleanup
    // capability. Windows async realpath can expand an 8.3 alias differently
    // from realpathSync even though the device/inode identity is unchanged.
    || realpathSync(path) !== path
  if (invalid) throw new CodexCredentialError()
}

export function credentialSnapshotEnvironment(snapshot: CredentialSnapshot): Readonly<Record<string, string>> {
  const value = snapshotValues.get(snapshot)
  if (value === undefined) throw new CodexCredentialError()
  return value.environment
}

/** Test seam for the same HOME validation and environment preparation as production. */
export async function prepareCodexCredentialSnapshotForTest(
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const destinationHome = requireString(input.destinationHome)
  const environment = requireEnvironmentInput(input.environment)
  const apiKey = input.apiKey === null ? null : requireString(input.apiKey)
  const {hostCodexHomeForTest} = await import('./process-owner.js')
  const home = hostCodexHomeForTest(destinationHome, {ephemeral: true})
  const snapshotter = new CredentialSnapshotter({environment})
  const snapshot = await snapshotter.prepare({codexHome: home, apiKey})
  return {environment: {...credentialSnapshotEnvironment(snapshot)}}
}

async function requirePrivateDirectory(path: string, shared = false): Promise<void> {
  const [linkInfo, fileInfo] = await Promise.all([
    lstat(path),
    stat(path),
  ])
  if (
    linkInfo.isSymbolicLink()
    || !fileInfo.isDirectory()
    || realpathSync(path) !== path
    || (!ownerMatches(fileInfo.uid))
    || (process.platform !== 'win32' && (shared ? (fileInfo.mode & 0o022) !== 0 : (fileInfo.mode & 0o777) !== 0o700))
  ) throw new CodexCredentialError()
}

async function ensureEphemeralDirectory(homeValue: HostCodexHome): Promise<void> {
  const {path} = hostCodexHomeValue(homeValue)
  try {
    await requirePrivateDirectory(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    const {mkdir} = await import('node:fs/promises')
    await mkdir(path, {mode: 0o700})
    await chmod(path, 0o700)
    await requirePrivateDirectory(path)
    refreshEphemeralCodexHomeIdentity(homeValue)
  }
}

function requireEnvironmentInput(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) throw new CodexCredentialError()
  return value as Record<string, string>
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new CodexCredentialError()
  return value
}

function ownerMatches(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
