import {join} from 'node:path'
import * as nodeFs from 'node:fs'
import {electronProfileInUse} from './data-root.mjs'

export const DESKTOP_PRODUCT_NAME = 'Nova Personal Agent'
/** macOS bundle id, Windows AppUserModelId and Linux desktop identity; must match electron-builder.yml `appId`. */
export const DESKTOP_APP_ID = 'ai.deepnovacore.nova-personal-agent'
/** Profile directory of source (unpackaged) launches, matching the workspace package name. */
export const SOURCE_STORAGE_NAME = '@nova-personal-agent/desktop'
// Compatibility: profiles written before the identity change. An existing profile keeps being used in place under
// its original name, which is also its safeStorage name (the "storage ABI"): Electron binds the OS encryption
// identity to app.getName() before ready, so the saved keys stay readable. Nothing is copied or renamed.
export const LEGACY_STORAGE_NAME = 'Nova Audio Agent Ambient Orb'
export const LEGACY_SOURCE_STORAGE_NAME = '@nova-audio-agent/ambient-orb'
/** Written into a profile created under the new identity; names the safeStorage identity it was created with. */
export const IDENTITY_RECORD = 'desktop-identity.json'
export const SETTINGS_FILE = 'ambient-orb-settings.json'

let selectedProfile = null

/** The profile chosen by configureDesktopIdentity for this process. */
export function selectedDesktopProfile() {
  return selectedProfile
}

function readRecord(fs, directory) {
  try {
    const record = JSON.parse(fs.readFileSync(join(directory, IDENTITY_RECORD), 'utf8'))
    if (record?.version !== 1 || typeof record.safeStorageName !== 'string' || record.safeStorageName === '') return null
    return record
  } catch {
    return null
  }
}

function writeRecord(fs, directory, record) {
  const file = join(directory, IDENTITY_RECORD), temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 1)}\n`, {mode: 0o600})
  fs.renameSync(temporary, file)
}

/** Whether an Electron instance (of any build) still owns a profile directory. */
export function profileInUse(directory, {fs = nodeFs, platform = process.platform} = {}) {
  return electronProfileInUse(directory, {fs, platform})
}

/** Every profile directory a desktop build of any age may hold open. */
export function desktopProfileDirectories(appData) {
  return [DESKTOP_PRODUCT_NAME, SOURCE_STORAGE_NAME, LEGACY_STORAGE_NAME, LEGACY_SOURCE_STORAGE_NAME].map(name => join(appData, name))
}

/**
 * The profile an existing install uses, chosen exactly as builds before the identity change did: packaged launches
 * use `Nova Audio Agent Ambient Orb`, except that without settings there and with settings in the source profile
 * they use `@nova-audio-agent/ambient-orb`; source launches use `@nova-audio-agent/ambient-orb`. A launch counts as
 * existing only when that directory already exists; otherwise it is a fresh install under the new identity.
 */
function existingLegacyProfile(fs, appData, isPackaged) {
  const hasSettings = name => fs.existsSync(join(appData, name, SETTINGS_FILE))
  let name = LEGACY_SOURCE_STORAGE_NAME
  if (isPackaged) name = !hasSettings(LEGACY_STORAGE_NAME) && hasSettings(LEGACY_SOURCE_STORAGE_NAME) ? LEGACY_SOURCE_STORAGE_NAME : LEGACY_STORAGE_NAME
  return fs.existsSync(join(appData, name)) ? name : null
}

/**
 * Chooses the profile and the OS encryption identity before app readiness.
 * Order: an explicit --user-data-dir; a profile created under the new identity; an existing legacy profile used in
 * place under its legacy name (selected as before the identity change); otherwise a fresh profile.
 */
export function configureDesktopIdentity(app, {fs = nodeFs, now = () => new Date(), log = () => {}} = {}) {
  let profile
  if (app.commandLine.hasSwitch('user-data-dir')) {
    // Isolated profiles keep the identity they were created with.
    let record = null
    try { record = readRecord(fs, app.getPath('userData')) } catch { /* no readable record */ }
    profile = {userData: null, safeStorageName: record?.safeStorageName ?? (app.isPackaged ? LEGACY_STORAGE_NAME : LEGACY_SOURCE_STORAGE_NAME), legacy: false}
  } else {
    const appData = app.getPath('appData')
    const freshName = app.isPackaged ? DESKTOP_PRODUCT_NAME : SOURCE_STORAGE_NAME
    const target = join(appData, freshName)
    const record = readRecord(fs, target)
    const existing = record === null ? existingLegacyProfile(fs, appData, app.isPackaged) : null
    if (record !== null) {
      profile = {userData: target, safeStorageName: record.safeStorageName, legacy: false}
    } else if (existing !== null) {
      profile = {userData: join(appData, existing), safeStorageName: existing, legacy: true}
    } else {
      profile = {userData: target, safeStorageName: freshName, legacy: false}
      try {
        fs.mkdirSync(target, {recursive: true, mode: 0o700})
        writeRecord(fs, target, {version: 1, safeStorageName: freshName, createdAt: now().toISOString()})
      } catch (error) {
        log(`desktop-identity: profile record not written: ${error?.code ?? error?.message}`)
      }
    }
  }
  selectedProfile = Object.freeze(profile)
  app.setName(profile.safeStorageName)
  if (profile.userData !== null) app.setPath('userData', profile.userData)
  // Crypto configuration has captured the stable identity before ready. Restore the
  // public name before any window/menu is created; productName also names the binary.
  return app.whenReady().then(() => app.setName(DESKTOP_PRODUCT_NAME))
}
