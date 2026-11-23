import * as nodeFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  acquireMigrationLock,
  dataRootLocksHeld,
  dataRootPaths,
  electronProfileInUse,
  inspectDataRootMigration,
  LEGACY_DATA_ROOT_TILDE,
  DATA_ROOT_TILDE,
  migrateDataRoot,
  migrationLockOwner,
  repairCompatibilityLink,
} from './data-root.mjs'
import { desktopProfileDirectories } from './target.mjs'

const SETTINGS_FILE = 'ambient-orb-settings.json'
// Desktop, runtime host and server executables of any build, and processes working inside either data root.
const NOVA_PROCESS = /Nova Personal Agent|Nova Audio Agent|nova-personal-agent|nova-audio-agent|nova-runtime|novapersonal|novaaudio/iu

function inside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Running processes as {pid, ppid, command}; null when the process list cannot be read. */
export function listProcesses({platform = process.platform, spawn = spawnSync} = {}) {
  if (platform === 'win32') {
    const result = spawn('tasklist', ['/fo', 'csv', '/nh'], {encoding: 'utf8', timeout: 15_000})
    if (result.error || result.status !== 0) return null
    return result.stdout.split(/\r?\n/u).filter(Boolean).map(line => {
      const [command, pid] = line.split('","').map(value => value.replace(/^"|"$/gu, ''))
      return {pid: Number(pid), ppid: 0, command}
    })
  }
  const result = spawn('ps', ['-axo', 'pid=,ppid=,args='], {encoding: 'utf8', timeout: 15_000})
  if (result.error || result.status !== 0) return null
  return result.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({pid: Number(pid), ppid: Number(ppid), command}))
}

/** Nova processes other than this command and its own ancestors (the shell, npx). */
export function novaProcesses(processes, self = process.pid) {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]))
  const ancestors = new Set()
  for (let pid = self; pid > 0 && !ancestors.has(pid); pid = byPid.get(pid)?.ppid ?? 0) ancestors.add(pid)
  ancestors.add(process.ppid)
  return processes.filter(entry => !ancestors.has(entry.pid) && NOVA_PROCESS.test(entry.command))
}

/**
 * Why the move may not run now; empty only when no Nova process can be using either root: no desktop profile is
 * owned, no Nova process is running, and no writer lock is held anywhere inside either root. Unknown counts as busy.
 */
export function migrationBlockers({home, platform = process.platform, environment = process.env, fs = nodeFs, processes = () => listProcesses({platform}), locksHeld = root => dataRootLocksHeld(root, {fs, platform})} = {}) {
  const blockers = []
  for (const directory of desktopProfileDirectories({platform, home, environment})) {
    if (electronProfileInUse(directory, {fs, platform})) blockers.push(`a Nova desktop window owns ${directory}`)
  }
  const list = processes()
  if (list === null) blockers.push('the process list could not be read')
  else for (const entry of novaProcesses(list)) blockers.push(`Nova process ${entry.pid} is running: ${entry.command.slice(0, 160)}`)
  const {root, legacyRoot} = dataRootPaths(home)
  for (const directory of [legacyRoot, root]) {
    if (locksHeld(directory)) blockers.push(`a Nova process holds a lock inside ${directory}`)
  }
  return blockers
}

function writeJsonAtomic(fs, path, value) {
  let mode = 0o600
  try { mode = fs.statSync(path).mode & 0o777 } catch { /* keep owner-only */ }
  const temporary = `${path}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), {mode})
  fs.renameSync(temporary, path)
}

function rebaseValue(value, {home, root, legacyRoot}) {
  if (typeof value !== 'string' || value === '') return value
  if (value === LEGACY_DATA_ROOT_TILDE || value.startsWith(`${LEGACY_DATA_ROOT_TILDE}/`)) return DATA_ROOT_TILDE + value.slice(LEGACY_DATA_ROOT_TILDE.length)
  if (isAbsolute(value) && inside(legacyRoot, value)) return join(root, relative(legacyRoot, value))
  void home
  return value
}

function readJson(fs, path) {
  try {
    if (!fs.lstatSync(path).isFile()) return null
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Desktop settings fields and Space host `personal_path` values that point into the legacy root, as planned
 * rewrites. The runtime compares a Space's `personal_path` literally, so an existing-data Space must follow the move.
 */
export function planPathRewrites({home, platform = process.platform, environment = process.env, fs = nodeFs} = {}) {
  const paths = {home, ...dataRootPaths(home)}
  const rewrites = []
  const spaceConfigs = new Set()
  if (environment.NOVA_SPACE_HOST_CONFIG) spaceConfigs.add(environment.NOVA_SPACE_HOST_CONFIG)
  for (const profile of desktopProfileDirectories({platform, home, environment})) {
    spaceConfigs.add(join(profile, 'space', 'config.json'))
    const file = join(profile, SETTINGS_FILE)
    const settings = readJson(fs, file)
    if (settings === null || typeof settings !== 'object') continue
    if (typeof settings.spaceHostConfigPath === 'string' && settings.spaceHostConfigPath !== '') spaceConfigs.add(rebaseValue(settings.spaceHostConfigPath, paths))
    const fields = Object.entries(settings).filter(([, value]) => rebaseValue(value, paths) !== value)
      .map(([key, value]) => ({key, from: value, to: rebaseValue(value, paths)}))
    if (fields.length > 0) rewrites.push({kind: 'settings', file, fields})
  }
  for (const file of spaceConfigs) {
    const config = readJson(fs, file)
    const next = rebaseValue(config?.personal_path, paths)
    if (config !== null && next !== config.personal_path) rewrites.push({kind: 'space', file, fields: [{key: 'personal_path', from: config.personal_path, to: next}]})
  }
  return rewrites
}

export function applyPathRewrites(rewrites, {fs = nodeFs} = {}) {
  for (const rewrite of rewrites) {
    const value = readJson(fs, rewrite.file)
    if (value === null) continue
    for (const field of rewrite.fields) if (value[field.key] === field.from) value[field.key] = field.to
    writeJsonAtomic(fs, rewrite.file, value)
  }
}

function sizeOf(fs, path) {
  let stats
  try { stats = fs.lstatSync(path) } catch { return 0 }
  if (!stats.isDirectory()) return stats.size
  let total = 0
  for (const name of fs.readdirSync(path)) total += sizeOf(fs, join(path, name))
  return total
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

const CONFLICT_REASONS = {
  differs: 'already exists in the new folder with different content',
  sqlite_both: 'part of a database that exists in both folders (database files move only as a whole)',
  sqlite_partial: 'database main file is missing next to its -wal/-shm/-journal/.memory companions',
}

/** The dry-run report: what would move, what blocks it, and the exact effect. Changes nothing. */
export function describePlan({plan, blockers, rewrites, fs = nodeFs}) {
  const lines = []
  const {root, legacyRoot} = plan
  if (plan.status === 'done') lines.push(`Already migrated: data lives in ${root}.`)
  else if (plan.status === 'link_broken') lines.push(`Already migrated to ${root}, but the compatibility link ${legacyRoot} is missing or points elsewhere; \`npa migrate-data\` restores it when ${legacyRoot} is absent or an empty folder.`)
  else if (plan.status === 'root_link') lines.push(`${root} is a link; the move needs a real folder there. Remove the link (or move its target into place) and run again.`)
  else if (plan.status === 'fresh') lines.push(`Nothing to migrate: ${legacyRoot} does not exist.`)
  else if (plan.status === 'foreign_link') lines.push(`${legacyRoot} is a link you created; it is used as-is and never moved.`)
  else if (plan.status === 'cross_device') lines.push(`${legacyRoot} and ${root} are on different volumes; the move needs a rename on one volume, so nothing will be moved.`)
  if (plan.status === 'pending') lines.push(`An interrupted migration is pending; running \`npa migrate-data\` resumes it, or rolls it back if it cannot finish.`)
  if (plan.status === 'ready' || plan.status === 'conflict' || plan.status === 'pending') {
    const moves = plan.ops.filter(op => op.kind === 'move'), backups = plan.ops.filter(op => op.kind === 'backup')
    const total = moves.reduce((sum, op) => sum + sizeOf(fs, op.from), 0)
    lines.push(`Move ${moves.length} entries (${formatBytes(total)}) from ${legacyRoot} into ${root} by rename on the same volume; nothing is copied or overwritten:`)
    for (const op of moves) lines.push(`  move    ${op.from} -> ${op.to} (${formatBytes(sizeOf(fs, op.from))})`)
    for (const op of backups) lines.push(`  keep    ${op.from} as ${op.to} (identical or empty; the legacy copy takes its place)`)
    for (const conflict of plan.conflicts) lines.push(`  CONFLICT ${conflict.path}: ${CONFLICT_REASONS[conflict.reason]}`)
    if (plan.conflicts.length > 0) lines.push('Nothing will move until every conflict is resolved (move one copy out of the way).')
    lines.push(`Then replace ${legacyRoot} with a link to ${root} (older builds and saved paths keep working) and write ${join(root, '.data-root-migrated.json')}.`)
  }
  for (const rewrite of rewrites) for (const field of rewrite.fields) lines.push(`  update  ${rewrite.file}: ${field.key} ${field.from} -> ${field.to}`)
  if (blockers.length > 0) {
    lines.push('Nova must be closed first:')
    for (const blocker of blockers) lines.push(`  - ${blocker}`)
  }
  return lines
}

/**
 * `npa migrate-data [--dry-run]`: the only way local data moves from ~/.nova-audio-agent to ~/.nova-personal-agent.
 * Optional; Nova keeps working from the legacy folder without it.
 */
export function migrateData({
  dryRun = false,
  home = homedir(),
  platform = process.platform,
  environment = process.env,
  fs = nodeFs,
  write = text => process.stdout.write(text),
  blockers = () => migrationBlockers({home, platform, environment, fs}),
  now,
} = {}) {
  const say = line => write(`${line}\n`)
  const plan = inspectDataRootMigration({home, fs, ...(now ? {now} : {})})
  const rewrites = ['foreign_link', 'fresh', 'cross_device', 'root_link'].includes(plan.status) ? [] : planPathRewrites({home, platform, environment, fs})
  const lockPath = dataRootPaths(home).lock
  const lockHeld = (() => { try { fs.lstatSync(lockPath); return true } catch { return false } })()
  const lockMessage = () => `Another \`npa migrate-data\` holds ${lockPath} (owner pid ${migrationLockOwner(lockPath, fs) ?? 'unknown'}). Make sure no migrate-data is running, then delete that file and run again.`
  if (dryRun) {
    for (const line of describePlan({plan, blockers: blockers(), rewrites, fs})) say(line)
    if (lockHeld) say(lockMessage())
    say('Dry run: nothing was changed.')
    return plan.status === 'conflict' || plan.status === 'cross_device' ? 1 : 0
  }
  if (plan.status === 'fresh' || plan.status === 'foreign_link') { for (const line of describePlan({plan, blockers: [], rewrites: [], fs})) say(line); return 0 }
  if (plan.status === 'cross_device' || plan.status === 'conflict' || plan.status === 'root_link') {
    for (const line of describePlan({plan, blockers: [], rewrites: [], fs})) say(line)
    return 1
  }
  if (plan.status === 'done' && rewrites.length === 0) { say(`Already migrated: data lives in ${plan.root}.`); return 0 }
  if (lockHeld) { say(lockMessage()); return 1 }
  const busy = blockers()
  if (busy.length > 0) {
    say('Refusing to migrate while Nova may be running. Quit Nova (desktop, runtime and any `npa` sessions) and try again:')
    for (const blocker of busy) say(`  - ${blocker}`)
    return 1
  }
  const lock = acquireMigrationLock(lockPath, fs)
  if (lock === null) { say(lockMessage()); return 1 }
  try {
    if (plan.status === 'link_broken') {
      const repaired = repairCompatibilityLink(home, {fs, platform})
      if (repaired === 'blocked') {
        say(`Data is in ${plan.root}, but ${plan.legacyRoot} is not empty or is a link elsewhere, so the compatibility link was not restored. Move its contents aside, then run again.`)
        return 1
      }
      say(`Restored the compatibility link ${plan.legacyRoot} -> ${plan.root}.`)
    }
    const applied = []
    // Same lock, Nova stopped, before the marker: point saved settings and existing-data Spaces at the new root.
    const rewritePaths = () => {
      const pending = planPathRewrites({home, platform, environment, fs})
      applyPathRewrites(pending, {fs})
      applied.push(...pending)
    }
    if (plan.status === 'done' || plan.status === 'link_broken') {
      rewritePaths()
      for (const rewrite of applied) for (const field of rewrite.fields) say(`Updated ${rewrite.file}: ${field.key}`)
      return 0
    }
    const outcome = migrateDataRoot({home, fs, platform, ...(now ? {now} : {}), locksHeld: () => blockers().length > 0, beforeCommit: rewritePaths, log: () => {}})
    if (outcome.status === 'skipped') {
      say(`Migration did not complete (${outcome.reason}).`)
      for (const path of outcome.detail ?? []) say(`  conflict: ${path}`)
      if (outcome.pending) {
        say(`The migration journal is kept, so Nova will not start until this is resolved:`)
        for (const step of outcome.recovery ?? []) say(`  - ${step}`)
      } else {
        say(`Nothing was moved; Nova keeps using ${outcome.root}.`)
      }
      return 1
    }
    for (const rewrite of applied) for (const field of rewrite.fields) say(`Updated ${rewrite.file}: ${field.key}`)
    if (outcome.status === 'migrated') say(`Moved ${outcome.moved} entries into ${outcome.root}; ${dataRootPaths(home).legacyRoot} now links there.`)
    for (const backup of outcome.backups ?? []) say(`Kept ${backup}`)
    return 0
  } finally {
    lock.release()
  }
}
