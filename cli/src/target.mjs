import { homedir } from 'node:os'
import { join } from 'node:path'

export const PRODUCT_VERSION = '0.4.0'
export const RELEASE_REPOSITORY = 'deepnovacore/NovaPersonalAgent'

export function resolveTarget(platform = process.platform, arch = process.arch, version = PRODUCT_VERSION) {
  // Published releases retain their original asset and executable names.
  const legacy = /^0\.[0-3]\./u.test(version)
  const prefix = legacy ? 'nova-audio-agent' : 'nova-personal-agent'
  const desktop = legacy ? 'Nova Audio Agent Desktop' : 'Nova Personal Agent Desktop'
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
  return join(home, '.nova-audio-agent', 'cli', 'releases', version, target.id)
}

export function desktopSettingsPath({
  platform = process.platform,
  home = homedir(),
  environment = process.env,
} = {}) {
  // Stable storage identity shared with the renamed desktop (including encrypted settings).
  const product = 'Nova Audio Agent Ambient Orb'
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', product, 'ambient-orb-settings.json')
  }
  if (platform === 'win32') {
    const appData = environment.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, product, 'ambient-orb-settings.json')
  }
  const config = environment.XDG_CONFIG_HOME || join(home, '.config')
  return join(config, product, 'ambient-orb-settings.json')
}
