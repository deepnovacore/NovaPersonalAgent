import {join} from 'node:path'
import {existsSync} from 'node:fs'

export const DESKTOP_PRODUCT_NAME = 'Nova Personal Agent Desktop'
// Storage ABI only: Electron derives OS encryption identities before app readiness.
// Keep existing encrypted settings readable without copying or re-encrypting secrets.
export const LEGACY_STORAGE_NAME = 'Nova Audio Agent Ambient Orb'
export function configureDesktopIdentity(app) {
  const explicit = app.commandLine.hasSwitch('user-data-dir')
  const sourceName = '@nova-audio-agent/ambient-orb'
  // A first packaged launch must not strand the user's existing source profile.
  const sourceExists = app.isPackaged && !explicit
    && !existsSync(join(app.getPath('appData'), LEGACY_STORAGE_NAME, 'ambient-orb-settings.json'))
    && existsSync(join(app.getPath('appData'), sourceName, 'ambient-orb-settings.json'))
  const storageName = !app.isPackaged || sourceExists ? sourceName : LEGACY_STORAGE_NAME
  app.setName(storageName)
  if (!explicit) {
    app.setPath('userData', join(app.getPath('appData'), storageName))
  }
  // Crypto configuration has captured the stable identity before ready. Restore the
  // public name before any window/menu is created; productName also names the binary.
  return app.whenReady().then(() => app.setName(DESKTOP_PRODUCT_NAME))
}
