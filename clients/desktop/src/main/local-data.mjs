import * as nodeFs from 'node:fs'
import {dataRootPaths, LEGACY_DATA_ROOT_TILDE, resolveDataRoot} from './data-root.mjs'

/** The command that moves the legacy data root; it must run with Nova closed. */
export const MIGRATE_DATA_COMMAND = 'npa migrate-data'

/**
 * Startup gate. Startup never moves data; it only resolves the data root. A pending move journal means a
 * `npa migrate-data` run was interrupted: no backend may write either root until that command finishes or rolls
 * it back. Returns the paths for the error dialog when startup must stop.
 */
export function checkDataRootStartup({home, fs = nodeFs} = {}) {
  try {
    const resolution = resolveDataRoot(home, fs)
    return {ok: true, ...resolution}
  } catch (error) {
    if (error?.code !== 'data_root_migration_pending') throw error
    const {root, legacyRoot, journal, lock} = dataRootPaths(home)
    return {ok: false, root, legacyRoot, journal, ...(error.lock === undefined ? {} : {lock})}
  }
}

/**
 * One-line Settings notice: data still in the legacy root (kind `legacy`), or migrated with the compatibility link
 * missing or wrong (kind `link`); null otherwise.
 */
export function legacyDataRootNotice({home, fs = nodeFs} = {}) {
  const gate = checkDataRootStartup({home, fs})
  if (!gate.ok) return null
  if (gate.linkBroken) return {kind: 'link', path: LEGACY_DATA_ROOT_TILDE, command: MIGRATE_DATA_COMMAND}
  if (!gate.legacy) return null
  return {kind: 'legacy', path: LEGACY_DATA_ROOT_TILDE, command: MIGRATE_DATA_COMMAND}
}
