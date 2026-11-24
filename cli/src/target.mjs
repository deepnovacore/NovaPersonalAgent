import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertNoPendingDataRootMigration, dataRootPaths } from './data-root.mjs'

export const PRODUCT_VERSION = '1.0.2'
export const RELEASE_REPOSITORY = 'deepnovacore/NovaPersonalAgent'

export function resolveTarget(platform = process.platform, arch = process.arch, version = PRODUCT_VERSION) {
  // Published releases retain their original asset and executable names.
  const legacy = /^0\.[0-3]\./u.test(version)
  const prefix = legacy ? 'nova-audio-agent' : 'nova-personal-agent'
  // 0.4 shipped as "Nova Personal Agent Desktop"; 1.0 renamed the bundle to the product name.
  const desktop = legacy ? 'Nova Audio Agent Desktop' : /^0\./u.test(version) ? 'Nova Personal Agent Desktop' : 'Nova Personal Agent'
  const definitions = {
    'linux-x64': {artifact: `${prefix}-${version}-linux-x64.AppImage`, executable: `${prefix}.AppImage`, archive: 'file'},
    'darwin-arm64': {artifact: `${prefix}-${version}-macos-arm64-app.zip`, executable: `${desktop}.app/Contents/MacOS/${desktop}`, archive: 'zip'},
    'win32-x64': {artifact: `${prefix}-${version}-windows-x64-portable.zip`, executable: `${desktop}.exe`, archive: 'zip'},
  }
  const id = `${platform}-${arch}`
  const definition = definitions[id]
  if (definition === undefined) throw new Error(`unsupported platform: ${platform}-${arch}`)
  return Object.freeze({id, ...definition})
}

export function releaseBaseUrl(version = PRODUCT_VERSION) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`
}

export function releaseRoot({
  home = homedir(),
  version = PRODUCT_VERSION,
  target = resolveTarget(),
} = {}) {
  // Always the new root: only the desktop migrates, and it cannot move a legacy root it is running from. A pending
  // migration refuses here, before anything is downloaded or created.
  assertNoPendingDataRootMigration(home)
  return join(dataRootPaths(home).root, 'cli', 'releases', version, target.id)
}

export const DESKTOP_STORAGE_NAME = 'Nova Personal Agent'
// Compatibility: the profile written by builds before the identity change; existing installs keep using it in place.
export const LEGACY_DESKTOP_STORAGE_NAME = 'Nova Audio Agent Ambient Orb'
export const DESKTOP_IDENTITY_FILE = 'desktop-identity.json'

export function desktopAppData({platform = process.platform, home = homedir(), environment = process.env} = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform === 'win32') return environment.APPDATA || join(home, 'AppData', 'Roaming')
  return environment.XDG_CONFIG_HOME || join(home, '.config')
}

/** Every desktop profile directory a build of any age may hold open. */
export function desktopProfileDirectories({platform = process.platform, home = homedir(), environment = process.env} = {}) {
  const appData = desktopAppData({platform, home, environment})
  return [DESKTOP_STORAGE_NAME, LEGACY_DESKTOP_STORAGE_NAME, '@nova-personal-agent/desktop', '@nova-audio-agent/ambient-orb']
    .map(name => join(appData, name))
}

function newIdentityProfile(directory) {
  try {
    const record = JSON.parse(readFileSync(join(directory, DESKTOP_IDENTITY_FILE), 'utf8'))
    return record?.version === 1 && typeof record.safeStorageName === 'string' && record.safeStorageName !== ''
  } catch {
    return false
  }
}

export function desktopSettingsPath({
  platform = process.platform,
  home = homedir(),
  environment = process.env,
} = {}) {
  // Same order as a packaged desktop: a profile created under the new identity; else the existing profile chosen as
  // before the identity change (legacy, or the source profile when only it has settings); else the new profile.
  const appData = desktopAppData({platform, home, environment})
  const current = join(appData, DESKTOP_STORAGE_NAME)
  const legacy = join(appData, LEGACY_DESKTOP_STORAGE_NAME)
  const source = join(appData, '@nova-audio-agent/ambient-orb')
  const file = 'ambient-orb-settings.json'
  if (newIdentityProfile(current)) return join(current, file)
  const existing = !existsSync(join(legacy, file)) && existsSync(join(source, file)) ? source : legacy
  return existsSync(existing) ? join(existing, file) : join(current, file)
}
