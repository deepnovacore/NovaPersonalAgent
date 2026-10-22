import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { stripLikePython } from '@nova-personal-agent/runtime/desktop'

export const DESKTOP_VIDEO_FILE_ENV = 'DESKTOP_VIDEO_FILE'

export class MainCameraConfigurationError extends Error {
  constructor() {
    super(`${DESKTOP_VIDEO_FILE_ENV} must name an absolute regular file`)
    this.name = 'MainCameraConfigurationError'
  }
}

const defaultFileSystem = Object.freeze({
  realpath: path => realpathSync(path),
  stat: path => statSync(path),
})

export function selectMainCameraSource(environment, fileSystem = defaultFileSystem) {
  const configured = stripLikePython(environment[DESKTOP_VIDEO_FILE_ENV] ?? '')
  if (configured === '') return Object.freeze({ source: 'local' })
  if (!isAbsolute(configured)) throw new MainCameraConfigurationError()
  try {
    const canonical = fileSystem.realpath(configured)
    if (!fileSystem.stat(canonical).isFile()) throw new MainCameraConfigurationError()
    return Object.freeze({ source: 'file', file: canonical })
  } catch {
    throw new MainCameraConfigurationError()
  }
}

export async function startWithSelectedCamera({
  environment,
  fileSystem = defaultFileSystem,
  start,
}) {
  const selected = selectMainCameraSource(environment, fileSystem)
  return start(selected)
}
