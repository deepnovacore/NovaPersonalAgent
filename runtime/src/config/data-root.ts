/**
 * Dependency-free data-root resolution and the explicit `~/.nova-audio-agent` -> `~/.nova-personal-agent` move.
 * check-capabilities.mjs emits this file into the standalone CLI and the desktop main process, so every entry point
 * resolves the same root by the same rules.
 *
 * Resolution everywhere: an explicit path (environment or a user setting) is honoured as-is; otherwise the new root
 * once the move is done or when there is no legacy data; otherwise the legacy root (a real directory, or a link the
 * user created). Nothing moves on startup: existing users keep working from the legacy root until they run
 * `npa migrate-data` with Nova closed. A pending move journal blocks every writer until that command finishes or
 * rolls it back. A fresh install never creates the legacy root.
 */
import * as nodeFs from 'node:fs'
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path'

export const DATA_ROOT_NAME = '.nova-personal-agent'
// Compatibility: the retired product identity. Used only for detection, the explicit move and the compatibility link.
export const LEGACY_DATA_ROOT_NAME = '.nova-audio-agent'
export const DATA_ROOT_TILDE = `~/${DATA_ROOT_NAME}`
export const LEGACY_DATA_ROOT_TILDE = `~/${LEGACY_DATA_ROOT_NAME}`
/** Written into the new root last, once every entry has moved and the compatibility link is verified. */
export const DATA_ROOT_MARKER = '.data-root-migrated.json'
/** Written into the new root before the first rename; while it exists no process may write either root. */
export const DATA_ROOT_JOURNAL = '.data-root-migration.journal.json'
/** Exclusive migrator lock, in the home directory (outside both roots), held for the whole move. */
export const MIGRATION_LOCK_NAME = '.nova-personal-agent.migration.lock'
const EMPTY_SUFFIX = '.migrating-empty'

export type DataRootFs = Pick<typeof nodeFs,
  'closeSync' | 'existsSync' | 'linkSync' | 'lstatSync' | 'mkdirSync' | 'openSync' | 'readdirSync' | 'readFileSync'
  | 'readlinkSync' | 'readSync' | 'realpathSync' | 'renameSync' | 'rmdirSync' | 'statSync' | 'symlinkSync'
  | 'unlinkSync' | 'writeFileSync'>

/** `linkBroken`: migrated, but the compatibility link at the legacy path is missing or points elsewhere. */
export interface DataRootResolution {readonly root: string; readonly legacy: boolean; readonly linkBroken?: true}

export type DataRootMigrationOp =
  | {readonly kind: 'move'; readonly from: string; readonly to: string}
  | {readonly kind: 'backup'; readonly from: string; readonly to: string}
  | {readonly kind: 'rmdir'; readonly path: string}

export type DataRootConflictReason = 'differs' | 'sqlite_both' | 'sqlite_partial'
export interface DataRootConflict {readonly path: string; readonly reason: DataRootConflictReason}

export type DataRootSkipReason = 'locked' | 'conflict' | 'cross_device' | 'link_unsupported' | 'changed' | 'foreign_link' | 'root_link' | 'failed'

export type DataRootMigrationOutcome =
  | {readonly status: 'fresh' | 'done'; readonly root: string}
  | {readonly status: 'migrated'; readonly root: string; readonly moved: number; readonly backups: readonly string[]}
  | {readonly status: 'skipped'; readonly root: string; readonly reason: DataRootSkipReason; readonly pending: boolean
    readonly detail?: readonly string[]; readonly recovery?: readonly string[]}

export interface DataRootMigrationOptions {
  readonly home: string
  readonly fs?: DataRootFs
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  /** True when any Nova process may still be using either root. Asked before planning and again before the first rename. */
  readonly locksHeld?: () => boolean
  /** Runs after every entry moved and the link is verified, before the marker; a throw keeps the journal for a rerun. */
  readonly beforeCommit?: () => void
  readonly log?: (message: string) => void
}

/** A journal from an interrupted move exists: no process may read or write either root until it is finished. */
export class DataRootMigrationPendingError extends Error {
  readonly code = 'data_root_migration_pending'
  constructor(readonly journal: string, readonly lock?: string) {
    super(lock === undefined
      ? `Nova data migration is incomplete (${journal}). Quit Nova and run \`npa migrate-data\` to finish or roll it back.`
      : `Nova data migration is running or was interrupted (${lock}). Wait for \`npa migrate-data\` to finish; if none is running, run it again.`)
  }
}

export function dataRootPaths(home: string): {readonly root: string; readonly legacyRoot: string; readonly journal: string; readonly marker: string; readonly lock: string} {
  const root = join(home, DATA_ROOT_NAME)
  return {root, legacyRoot: join(home, LEGACY_DATA_ROOT_NAME), journal: join(root, DATA_ROOT_JOURNAL), marker: join(root, DATA_ROOT_MARKER), lock: join(home, MIGRATION_LOCK_NAME)}
}

function lstatOrNull(fs: DataRootFs, path: string): nodeFs.Stats | null {
  try { return fs.lstatSync(path) } catch { return null }
}

function realpathOrNull(fs: DataRootFs, path: string): string | null {
  try { return fs.realpathSync(path) } catch { return null }
}

function exists(fs: DataRootFs, path: string): boolean {
  return lstatOrNull(fs, path) !== null
}

/**
 * The new root once migrated or when no legacy data exists; the legacy root while it is a real directory or a link
 * the user created (relocated data is resolved through it, never treated as a fresh install).
 * Throws while a move journal is pending.
 */
export function resolveDataRoot(home: string, fs: DataRootFs = nodeFs): DataRootResolution {
  const {root, legacyRoot, journal, marker, lock} = dataRootPaths(home)
  // A journal or a held migrator lock always wins, even over the marker: the move is in progress.
  if (exists(fs, journal)) throw new DataRootMigrationPendingError(journal)
  if (exists(fs, lock)) throw new DataRootMigrationPendingError(journal, lock)
  if (fs.existsSync(marker)) return linkedToRoot(fs, legacyRoot, root) ? {root, legacy: false} : {root, legacy: false, linkBroken: true}
  const legacy = lstatOrNull(fs, legacyRoot)
  if (legacy !== null && (legacy.isDirectory() || legacy.isSymbolicLink())) return {root: legacyRoot, legacy: true}
  return {root, legacy: false}
}

/** Refuses (throws DataRootMigrationPendingError) before a writer creates anything while a journal is pending. */
export function assertNoPendingDataRootMigration(home: string, fs: DataRootFs = nodeFs): void {
  resolveDataRoot(home, fs)
}

/** The home directory a configuration environment names; undefined keeps the static defaults. */
export function environmentHome(environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | undefined {
  const value = platform === 'win32' ? environment.USERPROFILE ?? environment.HOME : environment.HOME
  return value?.trim() ? value : undefined
}

export function legacyDataRootActive(home: string | undefined, fs: DataRootFs = nodeFs): boolean {
  return home !== undefined && resolveDataRoot(home, fs).legacy
}

/** Moves a default `~/.nova-personal-agent/...` onto the legacy root while that root is still active. */
export function rebaseDataRootDefault(path: string, legacy: boolean): string {
  if (!legacy) return path
  if (path === DATA_ROOT_TILDE || path.startsWith(`${DATA_ROOT_TILDE}/`)) return LEGACY_DATA_ROOT_TILDE + path.slice(DATA_ROOT_TILDE.length)
  return path
}

/**
 * Once migrated, an explicit path under the legacy root (absolute or `~/.nova-audio-agent/...`) is mapped onto the
 * new root, so a missing or broken compatibility link can never make it open a second, separate database.
 */
export function mapLegacyDataPath(path: string, home: string | undefined, fs: DataRootFs = nodeFs): string {
  if (home === undefined || typeof path !== 'string' || path === '') return path
  const {root, legacyRoot} = dataRootPaths(home)
  if (resolveDataRoot(home, fs).legacy) return path
  if (path === LEGACY_DATA_ROOT_TILDE || path.startsWith(`${LEGACY_DATA_ROOT_TILDE}/`)) return DATA_ROOT_TILDE + path.slice(LEGACY_DATA_ROOT_TILDE.length)
  const inside = relative(legacyRoot, path)
  if (isAbsolute(path) && (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))) return join(root, inside)
  return path
}

/** A default data path under whichever root is active for `home`. */
export function defaultDataPath(relativePath: string, home: string | undefined, fs: DataRootFs = nodeFs): string {
  return rebaseDataRootDefault(relativePath === '' ? DATA_ROOT_TILDE : `${DATA_ROOT_TILDE}/${relativePath}`, legacyDataRootActive(home, fs))
}

/** `<db>`, `<db>-wal`, `<db>-shm`, `<db>-journal` and the `<db>.memory/` repository form one indivisible unit. */
export function sqliteGroup(name: string): string | null {
  return /^(.+\.(?:sqlite|sqlite3|db))(?:-wal|-shm|-journal|\.memory)?$/iu.exec(name)?.[1] ?? null
}

/** Group identity compared case-insensitively: conservative on case-insensitive volumes (macOS, Windows). */
function groupKey(name: string): string | null {
  return sqliteGroup(name)?.toLowerCase() ?? null
}

function sameBytes(fs: DataRootFs, left: string, right: string): boolean {
  const a = fs.statSync(left), b = fs.statSync(right)
  if (a.size !== b.size) return false
  const first = fs.openSync(left, 'r'), second = fs.openSync(right, 'r')
  try {
    const x = Buffer.alloc(65_536), y = Buffer.alloc(65_536)
    for (;;) {
      const read = fs.readSync(first, x, 0, x.length, null)
      const other = fs.readSync(second, y, 0, y.length, null)
      if (read !== other) return false
      if (read === 0) return true
      if (!x.subarray(0, read).equals(y.subarray(0, read))) return false
    }
  } finally {
    fs.closeSync(first)
    fs.closeSync(second)
  }
}

function emptyDirectory(fs: DataRootFs, path: string, stats: nodeFs.Stats | null): boolean {
  return stats?.isDirectory() === true && fs.readdirSync(path).length === 0
}

/** Release downloads the CLI can fetch again; a duplicate is set aside under a `.legacy-<ts>` name, never merged. */
function cacheLeaf(relativePath: string): boolean {
  const parts = relativePath.split(sep)
  return parts[0] === 'cli' && parts[1] === 'releases' && parts.length >= 4
}

/**
 * Plans renames only; nothing on disk changes. Directories present on both sides are merged entry by entry.
 * A database group moves only whole: its main file must exist in the legacy root and no member may exist in the
 * new root. Identical or empty non-database leftovers in the new root are set aside, never deleted.
 */
export function planDataRootMigration(fs: DataRootFs, from: string, to: string, stamp: string): {ops: DataRootMigrationOp[]; conflicts: DataRootConflict[]} {
  const ops: DataRootMigrationOp[] = [], conflicts: DataRootConflict[] = [], taken = new Set<string>()
  const aside = (target: string, label: string): string => {
    for (let index = 0; ; index += 1) {
      const candidate = `${target}.${label}-${stamp}${index === 0 ? '' : `-${index}`}`
      if (!taken.has(candidate) && lstatOrNull(fs, candidate) === null) { taken.add(candidate); return candidate }
    }
  }
  const visit = (source: string, target: string): void => {
    const names = fs.readdirSync(source).sort()
    const targetNames = lstatOrNull(fs, target)?.isDirectory() === true ? fs.readdirSync(target) : []
    const groups = new Set<string>()
    for (const name of names) {
      const sourcePath = join(source, name), targetPath = join(target, name)
      const group = groupKey(name)
      if (group !== null) {
        if (groups.has(group)) continue
        groups.add(group)
        const members = names.filter(member => groupKey(member) === group)
        const existing = targetNames.filter(candidate => groupKey(candidate) === group)
        if (existing.length > 0) { conflicts.push(...existing.sort().map(candidate => ({path: join(target, candidate), reason: 'sqlite_both' as const}))); continue }
        if (!members.some(member => member.toLowerCase() === group)) { conflicts.push({path: join(source, sqliteGroup(name) ?? name), reason: 'sqlite_partial'}); continue }
        for (const member of members) ops.push({kind: 'move', from: join(source, member), to: join(target, member)})
        continue
      }
      const existing = lstatOrNull(fs, targetPath)
      if (existing === null) { ops.push({kind: 'move', from: sourcePath, to: targetPath}); continue }
      if (cacheLeaf(relative(to, targetPath))) { ops.push({kind: 'move', from: sourcePath, to: aside(targetPath, 'legacy')}); continue }
      const current = fs.lstatSync(sourcePath)
      if (current.isDirectory() && existing.isDirectory()) {
        visit(sourcePath, targetPath)
        ops.push({kind: 'rmdir', path: sourcePath})
        continue
      }
      if (emptyDirectory(fs, targetPath, existing) || (current.isFile() && existing.isFile() && sameBytes(fs, sourcePath, targetPath))) {
        ops.push({kind: 'backup', from: targetPath, to: aside(targetPath, 'conflict')}, {kind: 'move', from: sourcePath, to: targetPath})
        continue
      }
      conflicts.push({path: targetPath, reason: 'differs'})
    }
  }
  visit(from, to)
  return {ops, conflicts}
}

function applied(fs: DataRootFs, op: DataRootMigrationOp): boolean {
  if (op.kind === 'rmdir') return !exists(fs, op.path)
  return !exists(fs, op.from) && exists(fs, op.to)
}

class NoClobberError extends Error {
  readonly code = 'EEXIST'
  constructor(readonly path: string, readonly counterpart?: string) { super(`refusing to overwrite ${path}`) }
}

/** Never renames onto an existing path; the migrator lock and the stopped-Nova checks exclude racing writers. */
function renameNoClobber(fs: DataRootFs, from: string, to: string): void {
  if (exists(fs, to)) throw new NoClobberError(to)
  fs.renameSync(from, to)
}

/** Rolls forward from whatever the disk says is already applied; a destination this step did not create stops it. */
export function applyDataRootOps(fs: DataRootFs, ops: readonly DataRootMigrationOp[]): void {
  for (const op of ops) {
    if (applied(fs, op)) continue
    if (op.kind === 'rmdir') fs.rmdirSync(op.path)
    else renameNoClobber(fs, op.from, op.to)
  }
}

/**
 * Undoes applied operations newest first, restoring the legacy root exactly. Stops (NoClobberError) instead of
 * renaming onto an existing path, or when an operation's source and destination are both present or both missing.
 */
export function revertDataRootOps(fs: DataRootFs, ops: readonly DataRootMigrationOp[]): void {
  for (const op of [...ops].reverse()) {
    if (op.kind === 'rmdir') {
      if (!exists(fs, op.path)) fs.mkdirSync(op.path, {mode: 0o700})
      continue
    }
    const source = exists(fs, op.from), target = exists(fs, op.to)
    if (source && !target) continue
    if (!source && target) { renameNoClobber(fs, op.to, op.from); continue }
    // Both present is expected only for a move whose destination still holds the copy its backup has not set aside.
    const awaitingBackup = source && ops.some(other => other.kind === 'backup' && other.from === op.to && exists(fs, other.from) && !exists(fs, other.to))
    if (!awaitingBackup) throw new NoClobberError(op.from, op.to)
  }
}

/**
 * Paths that block a resumed move: a destination of an unapplied move that already exists (and is not waiting for
 * its backup), or any member of an unapplied database's group in the new root that the journal did not put there.
 */
function resumeConflicts(fs: DataRootFs, ops: readonly DataRootMigrationOp[]): string[] {
  const targets = new Set(ops.flatMap(op => op.kind === 'rmdir' ? [] : [op.to]))
  const conflicts = new Set<string>()
  for (const op of ops) {
    if (op.kind !== 'move' || applied(fs, op) || !exists(fs, op.from)) continue
    const awaitingBackup = ops.some(other => other.kind === 'backup' && other.from === op.to && exists(fs, other.from) && !exists(fs, other.to))
    if (exists(fs, op.to) && !awaitingBackup) conflicts.add(op.to)
    const key = groupKey(basename(op.to))
    if (key === null) continue
    let names: string[] = []
    try { names = fs.readdirSync(dirname(op.to)) } catch { continue }
    for (const name of names) {
      const path = join(dirname(op.to), name)
      if (groupKey(name) === key && !targets.has(path)) conflicts.add(path)
    }
  }
  return [...conflicts].sort()
}

/** Operations whose effect is still on disk; empty exactly when the legacy layout is fully restored. */
function stillApplied(fs: DataRootFs, ops: readonly DataRootMigrationOp[]): DataRootMigrationOp[] {
  return ops.filter(op => op.kind === 'rmdir' ? !exists(fs, op.path) : !exists(fs, op.from))
}

function writeAtomic(fs: DataRootFs, path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`, {mode: 0o600})
  fs.renameSync(temporary, path)
}

function readJournal(fs: DataRootFs, path: string, root: string, legacyRoot: string): DataRootMigrationOp[] {
  const record = JSON.parse(fs.readFileSync(path, 'utf8')) as {version?: unknown; root?: unknown; legacyRoot?: unknown; ops?: unknown}
  if (record.version !== 1 || record.root !== root || record.legacyRoot !== legacyRoot || !Array.isArray(record.ops)) {
    throw new Error('data_root_journal_invalid')
  }
  return record.ops as DataRootMigrationOp[]
}

function linkType(platform: NodeJS.Platform): 'junction' | 'dir' {
  return platform === 'win32' ? 'junction' : 'dir'
}

function removeLink(fs: DataRootFs, path: string): void {
  try { fs.unlinkSync(path) } catch { fs.rmdirSync(path) }
}

function linkSupported(fs: DataRootFs, root: string, platform: NodeJS.Platform): boolean {
  const probe = join(root, `.compat-link-probe-${process.pid}`)
  try {
    fs.symlinkSync(root, probe, linkType(platform))
    const ok = realpathOrNull(fs, probe) === realpathOrNull(fs, root)
    removeLink(fs, probe)
    return ok
  } catch {
    return false
  }
}

function linkedToRoot(fs: DataRootFs, legacyRoot: string, root: string): boolean {
  return lstatOrNull(fs, legacyRoot)?.isSymbolicLink() === true && realpathOrNull(fs, legacyRoot) === realpathOrNull(fs, root)
}

/** Whether the rename phase is over: the legacy root was swapped aside or already replaced by our link. */
function inLinkPhase(fs: DataRootFs, legacyRoot: string, root: string): boolean {
  return exists(fs, legacyRoot + EMPTY_SUFFIX) || linkedToRoot(fs, legacyRoot, root)
}

/**
 * Replaces the emptied legacy root with the compatibility link: rename it aside, create the link at the old path,
 * verify it resolves to the new root, then remove the empty directory. Resumable from every intermediate state.
 */
function swapInLink(fs: DataRootFs, legacyRoot: string, root: string, platform: NodeJS.Platform): void {
  const aside = legacyRoot + EMPTY_SUFFIX
  const current = lstatOrNull(fs, legacyRoot)
  if (current !== null && !current.isSymbolicLink()) {
    if (!current.isDirectory() || fs.readdirSync(legacyRoot).length > 0) throw Object.assign(new Error('legacy root changed during migration'), {code: 'changed'})
    if (exists(fs, aside)) fs.rmdirSync(aside)
    fs.renameSync(legacyRoot, aside)
  }
  if (!exists(fs, legacyRoot)) fs.symlinkSync(root, legacyRoot, linkType(platform))
  if (!linkedToRoot(fs, legacyRoot, root)) throw Object.assign(new Error('compatibility link does not resolve to the new root'), {code: 'link_unsupported'})
  if (exists(fs, aside)) fs.rmdirSync(aside)
}

/** Undoes swapInLink: removes our link and restores the (empty) legacy directory, never touching foreign data. */
function unswapLink(fs: DataRootFs, legacyRoot: string, root: string): void {
  const aside = legacyRoot + EMPTY_SUFFIX
  if (linkedToRoot(fs, legacyRoot, root)) removeLink(fs, legacyRoot)
  if (exists(fs, aside)) renameNoClobber(fs, aside, legacyRoot)
  else if (!exists(fs, legacyRoot)) fs.mkdirSync(legacyRoot, {mode: 0o700})
}

function describeOp(op: DataRootMigrationOp): string {
  return op.kind === 'rmdir' ? `recreate the directory ${op.path}` : `move ${op.to} back to ${op.from}`
}

export type DataRootPlanStatus = 'fresh' | 'done' | 'link_broken' | 'foreign_link' | 'root_link' | 'pending' | 'ready' | 'conflict' | 'cross_device'

export interface DataRootPlan {
  readonly status: DataRootPlanStatus
  readonly root: string
  readonly legacyRoot: string
  readonly ops: readonly DataRootMigrationOp[]
  readonly conflicts: readonly DataRootConflict[]
}

function sameVolume(fs: DataRootFs, root: string, legacyRoot: string, home: string): boolean {
  const target = lstatOrNull(fs, root) === null ? home : root
  return fs.statSync(target).dev === fs.statSync(legacyRoot).dev
}

/** The move `migrateDataRoot` would make, without changing anything (the `--dry-run` view). */
export function inspectDataRootMigration(options: {readonly home: string; readonly fs?: DataRootFs; readonly now?: () => Date}): DataRootPlan {
  const fs = options.fs ?? nodeFs
  const {root, legacyRoot, journal, marker} = dataRootPaths(options.home)
  const result = (status: DataRootPlanStatus, ops: readonly DataRootMigrationOp[] = [], conflicts: readonly DataRootConflict[] = []): DataRootPlan => ({status, root, legacyRoot, ops, conflicts})
  if (exists(fs, journal)) return result('pending', readJournal(fs, journal, root, legacyRoot))
  if (fs.existsSync(marker)) return result(linkedToRoot(fs, legacyRoot, root) ? 'done' : 'link_broken')
  const legacy = lstatOrNull(fs, legacyRoot)
  if (legacy === null || (!legacy.isDirectory() && !legacy.isSymbolicLink())) return result('fresh')
  if (legacy.isSymbolicLink()) return result('foreign_link')
  if (lstatOrNull(fs, root)?.isSymbolicLink() === true) return result('root_link')
  if (!sameVolume(fs, root, legacyRoot, options.home)) return result('cross_device')
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, '-')
  const planned = planDataRootMigration(fs, legacyRoot, root, stamp)
  return result(planned.conflicts.length > 0 ? 'conflict' : 'ready', planned.ops, planned.conflicts)
}

/**
 * The explicit, idempotent move of the legacy data root into the new root by same-volume, no-clobber renames.
 * Called only by `npa migrate-data` while holding the migrator lock with Nova stopped. Never copies, never
 * overwrites, refuses on any conflict before the first rename, and removes the journal only once every step is
 * either committed or exactly reverted; otherwise the journal stays and blocks every writer.
 */
export function migrateDataRoot(options: DataRootMigrationOptions): DataRootMigrationOutcome {
  const fs = options.fs ?? nodeFs
  const platform = options.platform ?? process.platform
  const log = options.log ?? (() => undefined)
  const {root, legacyRoot, journal: journalPath, marker} = dataRootPaths(options.home)
  const skipped = (reason: DataRootSkipReason, detail?: readonly string[], recovery?: readonly string[]): DataRootMigrationOutcome => {
    log(`data-root: migration not done (${reason})${detail?.length ? `: ${detail.join(', ')}` : ''}`)
    const pending = exists(fs, journalPath)
    return {status: 'skipped', root: pending ? root : legacyRoot, reason, pending,
      ...(detail === undefined ? {} : {detail}), ...(recovery === undefined ? {} : {recovery})}
  }
  // The journal always wins over the marker.
  const pending = exists(fs, journalPath)
  if (!pending && fs.existsSync(marker)) return {status: 'done', root}
  const legacy = lstatOrNull(fs, legacyRoot)
  if (!pending) {
    if (legacy === null || (!legacy.isDirectory() && !legacy.isSymbolicLink())) return {status: 'fresh', root}
    if (legacy.isSymbolicLink()) return skipped('foreign_link')
    // A linked new root would make the planner look at the link, not the directory it names: refuse.
    if (lstatOrNull(fs, root)?.isSymbolicLink() === true) return skipped('root_link')
  }
  if (options.locksHeld?.() === true) return skipped('locked')
  let ops: DataRootMigrationOp[]
  try {
    if (pending) {
      ops = readJournal(fs, journalPath, root, legacyRoot)
      log(`data-root: resuming interrupted migration (${ops.length} operations)`)
    } else {
      if (!sameVolume(fs, root, legacyRoot, options.home)) return skipped('cross_device')
      fs.mkdirSync(root, {recursive: true, mode: 0o700})
      if (!linkSupported(fs, root, platform)) return skipped('link_unsupported')
      const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, '-')
      const plan = planDataRootMigration(fs, legacyRoot, root, stamp)
      if (plan.conflicts.length > 0) return skipped('conflict', plan.conflicts.map(conflict => conflict.path))
      ops = plan.ops
      // Publish the journal first (from now on Nova refuses to start), then make the final check.
      writeAtomic(fs, journalPath, {version: 1, createdAt: new Date().toISOString(), root, legacyRoot, ops})
      if (options.locksHeld?.() === true) {
        fs.unlinkSync(journalPath)
        return skipped('locked')
      }
    }
  } catch (error) {
    log(`data-root: planning failed: ${(error as Error).message}`)
    return skipped('failed')
  }
  const rollback = (reason: DataRootSkipReason, error: unknown, conflicts: readonly string[] = []): DataRootMigrationOutcome => {
    log(`data-root: migration failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); rolling back`)
    let failure: unknown = null
    try {
      unswapLink(fs, legacyRoot, root)
      revertDataRootOps(fs, ops)
    } catch (rollbackError) {
      failure = rollbackError
    }
    const remaining = stillApplied(fs, ops)
    if (conflicts.length === 0 && failure === null && remaining.length === 0 && !exists(fs, legacyRoot + EMPTY_SUFFIX) && lstatOrNull(fs, legacyRoot)?.isDirectory() === true) {
      fs.unlinkSync(journalPath)
      return skipped(reason)
    }
    // Keep the journal: it blocks every writer until the half state is resolved.
    const blocked = failure instanceof NoClobberError ? [failure.counterpart === undefined
      ? `${failure.path} already exists, so undoing the move would overwrite it: compare it with the moved copy and move the one that is not yours out of the way`
      : `cannot move ${failure.counterpart} back to ${failure.path}: ${exists(fs, failure.path) ? 'both exist' : 'neither exists'}; compare both locations and move the copy that is not yours out of the way`] : failure === null ? [] : [`rollback stopped: ${(failure as Error).message}`]
    const strays = conflicts.map(path => `${path} appeared after the migration started; move it out of the way (it is not part of the move)`)
    return skipped(reason, conflicts.length > 0 ? conflicts : undefined, [...strays, ...blocked, ...remaining.reverse().map(describeOp),
      `then run \`npa migrate-data\` again, which finishes or rolls back from ${journalPath}`])
  }
  if (pending && !inLinkPhase(fs, legacyRoot, root)) {
    // Something may have written into the new root since the journal was published: re-check before moving.
    const conflicts = resumeConflicts(fs, ops)
    if (conflicts.length > 0) return rollback('conflict', new Error('conflict on resume'), conflicts)
  }
  try {
    if (!inLinkPhase(fs, legacyRoot, root)) applyDataRootOps(fs, ops)
    swapInLink(fs, legacyRoot, root, platform)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason: DataRootSkipReason = code === 'EXDEV' ? 'cross_device' : code === 'EEXIST' ? 'conflict'
      : code === 'changed' ? 'changed' : code === 'link_unsupported' ? 'link_unsupported' : 'failed'
    return rollback(reason, error)
  }
  try {
    options.beforeCommit?.()
  } catch (error) {
    // Everything has moved and the link works; the journal stays so a rerun finishes the rewrites and the marker.
    return skipped('failed', undefined, [`updating saved paths failed (${(error as Error).message})`, `run \`npa migrate-data\` again to finish from ${journalPath}`])
  }
  const backups = ops.filter(op => op.kind === 'backup').map(op => op.to)
  const moved = ops.filter(op => op.kind === 'move').length
  writeAtomic(fs, marker, {version: 1, migratedAt: new Date().toISOString(), from: legacyRoot, moved, backups})
  fs.unlinkSync(journalPath)
  log(`data-root: moved ${moved} entries into ${root}`)
  return {status: 'migrated', root, moved, backups}
}

function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false
  try {
    process.kill(pid as number, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether an Electron instance still owns a profile directory (Chromium's SingletonLock, or Windows' lockfile). */
export function electronProfileInUse(directory: string, options: {fs?: DataRootFs; platform?: NodeJS.Platform} = {}): boolean {
  const fs = options.fs ?? nodeFs
  if ((options.platform ?? process.platform) === 'win32') {
    const lock = join(directory, 'lockfile')
    if (!fs.existsSync(lock)) return false
    try {
      fs.closeSync(fs.openSync(lock, 'r+'))
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }
  let target: string
  try {
    // A symlink to "<hostname>-<pid>".
    target = fs.readlinkSync(join(directory, 'SingletonLock'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return !Number.isSafeInteger(pid) || (pid !== process.pid && processAlive(pid))
}

export interface MigrationLock {release(): void}

/**
 * The exclusive migrator lock. The owner record is written to a private temporary file first and then hard-linked
 * into place, so the lock path never exists empty or half written; link() fails when it exists. An existing lock is
 * never taken over automatically: returns null and the caller asks the user to remove it once no migration runs.
 */
export function acquireMigrationLock(path: string, fs: DataRootFs = nodeFs): MigrationLock | null {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({pid: process.pid, token, createdAt: new Date().toISOString()}), {mode: 0o600, flag: 'wx'})
  try {
    try {
      fs.linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try { if ((JSON.parse(fs.readFileSync(path, 'utf8')) as {token?: unknown}).token === token) fs.unlinkSync(path) } catch { /* already gone */ }
      },
    }
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* already gone */ }
  }
}

/** The pid recorded in an existing migrator lock, or null when it is missing, empty or unreadable. */
export function migrationLockOwner(path: string, fs: DataRootFs = nodeFs): number | null {
  try {
    const pid = (JSON.parse(fs.readFileSync(path, 'utf8')) as {pid?: unknown}).pid
    return Number.isSafeInteger(pid) ? pid as number : null
  } catch {
    return null
  }
}

/**
 * Restores the compatibility link after a completed move when the legacy path is missing or an empty directory.
 * Anything else at the legacy path (a file, data, or a link elsewhere) is left alone and reported.
 */
export function repairCompatibilityLink(home: string, options: {fs?: DataRootFs; platform?: NodeJS.Platform} = {}): 'ok' | 'repaired' | 'blocked' {
  const fs = options.fs ?? nodeFs
  const {root, legacyRoot} = dataRootPaths(home)
  if (linkedToRoot(fs, legacyRoot, root)) return 'ok'
  const current = lstatOrNull(fs, legacyRoot)
  if (current !== null && !(current.isDirectory() && !current.isSymbolicLink() && fs.readdirSync(legacyRoot).length === 0)) return 'blocked'
  if (current !== null) fs.rmdirSync(legacyRoot)
  fs.symlinkSync(root, legacyRoot, linkType(options.platform ?? process.platform))
  return linkedToRoot(fs, legacyRoot, root) ? 'repaired' : 'blocked'
}

type SpawnSync = (command: string, args: readonly string[], options: {encoding: 'utf8'; timeout: number}) => {status: number | null; stdout: string; error?: Error}

/** Whether another process has a natively locked file open (codex project locks), probed without native code. */
export function nativeLockHeld(path: string, options: {fs?: DataRootFs; platform?: NodeJS.Platform} = {}): boolean {
  const fs = options.fs ?? nodeFs, platform = options.platform ?? process.platform
  if (platform === 'win32') {
    // LockFileEx ranges refuse reads from other handles.
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(path, 'r')
      fs.readSync(descriptor, Buffer.alloc(1), 0, 1, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  }
  const childProcess = process.getBuiltinModule('node:child_process') as {spawnSync: SpawnSync} | undefined
  const result = childProcess?.spawnSync('lsof', ['-t', '--', path], {encoding: 'utf8', timeout: 10_000})
  if (result !== undefined && result.error === undefined && (result.status === 0 || result.status === 1)) {
    return result.stdout.split(/\s+/u).some(pid => pid !== '' && Number(pid) !== process.pid)
  }
  if (platform === 'linux') {
    const target = realpathOrNull(fs, path)
    let pids: string[] = []
    try { pids = fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name) && Number(name) !== process.pid) } catch { return true }
    for (const pid of pids) {
      let descriptors: string[] = []
      try { descriptors = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
      for (const descriptor of descriptors) {
        try { if (fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`) === target) return true } catch { /* closed meanwhile */ }
      }
    }
    return false
  }
  // Cannot prove the lock is free.
  return true
}

interface SqliteDatabase {exec(sql: string): void; close(): void}
type SqliteModule = {DatabaseSync: new (path: string) => SqliteDatabase} | undefined

function sqliteLockHeld(path: string): boolean {
  const sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule
  if (sqlite === undefined) return true
  let database: SqliteDatabase | null = null
  try {
    database = new sqlite.DatabaseSync(path)
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    database.exec('ROLLBACK')
    return false
  } catch {
    return true
  } finally {
    database?.close()
  }
}

function pidLockHeld(fs: DataRootFs, path: string, directory: boolean): boolean | null {
  try {
    const owner = JSON.parse(fs.readFileSync(directory ? join(path, 'owner.json') : path, 'utf8')) as {pid?: unknown; owner?: {pid?: unknown}}
    const pid = owner.pid ?? owner.owner?.pid
    return pid === undefined ? null : processAlive(pid)
  } catch {
    return null
  }
}

export interface DataRootLockScanOptions {
  readonly fs?: DataRootFs
  readonly platform?: NodeJS.Platform
  readonly nativeLockHeld?: (path: string) => boolean
}

/**
 * Every writer lock the runtime, CLI and desktop take inside a data root, at any depth and in every subdirectory
 * (links are not followed): `*.owner.sqlite` ownership databases, pid-owned `*.lock` files (memory repository
 * `<ledger>.memory/.nova-memory.lock`) and lock directories (CLI release installs), and natively locked `*.lock`
 * files (codex project store). An unreadable directory or lock counts as held.
 */
export function dataRootLocksHeld(root: string, options: DataRootLockScanOptions = {}): boolean {
  const fs = options.fs ?? nodeFs
  const platform = options.platform ?? process.platform
  const native = options.nativeLockHeld ?? (path => nativeLockHeld(path, {fs, platform}))
  const visit = (directory: string, top: boolean): boolean => {
    let entries: nodeFs.Dirent[]
    try {
      entries = fs.readdirSync(directory, {withFileTypes: true})
    } catch (error) {
      return !(top && (error as NodeJS.ErrnoException).code === 'ENOENT')
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name.endsWith('.owner.sqlite') && entry.isFile() && sqliteLockHeld(path)) return true
      if (entry.name.endsWith('.lock')) {
        if (entry.isDirectory()) {
          if (pidLockHeld(fs, path, true) !== false) return true
          continue
        }
        if (entry.isFile()) {
          const owned = pidLockHeld(fs, path, false)
          if (owned === true || (owned === null && native(path))) return true
          continue
        }
      }
      if (entry.isDirectory() && visit(path, false)) return true
    }
    return false
  }
  return visit(root, true)
}
