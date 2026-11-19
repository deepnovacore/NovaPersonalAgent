import {createHash} from 'node:crypto'
import {closeSync, constants, fstatSync, lstatSync, openSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

const assetKeys = ['profile', 'sources', 'memory', 'snapshot', 'avatar']
const invalid = () => new Error('invalid experience bundle')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && value.isWellFormed()
const filename = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== 'manifest.json'

function readFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < 1 || info.size > limit) throw invalid()
    const bytes = readFileSync(fd)
    if (bytes.length < 1 || bytes.length > limit) throw invalid()
    return bytes
  } finally { closeSync(fd) }
}

// A bundle is optional in ordinary builds, but a present bundle must be complete.
export function loadExperience(directory, {required = false} = {}) {
  try {
    try { lstatSync(join(directory, 'manifest.json')) } catch (error) {
      if (error.code === 'ENOENT' && !required) return null
      throw error
    }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw invalid()
    const manifest = JSON.parse(readFile(join(directory, 'manifest.json'), 256 * 1024).toString('utf8'))
    if (!exactKeys(manifest, ['version', 'personas']) || manifest.version !== 1
      || !Array.isArray(manifest.personas) || manifest.personas.length < 1 || manifest.personas.length > 100) throw invalid()
    const files = new Map()
    const names = new Set()
    for (const persona of manifest.personas) {
      if (!exactKeys(persona, ['id', 'name', 'occupation', ...assetKeys, 'sha256'])
        || typeof persona.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(persona.id) || persona.id.length > 64
        || files.has(persona.id) || !text(persona.name) || !text(persona.occupation)
        || !exactKeys(persona.sha256, assetKeys)) throw invalid()
      const assets = {}
      for (const key of assetKeys) {
        if (!filename(persona[key]) || names.has(persona[key]) || !/^[a-f0-9]{64}$/.test(persona.sha256[key])) throw invalid()
        names.add(persona[key])
        const bytes = readFile(join(directory, persona[key]), key === 'sources' ? 256 * 1024 : 8 * 1024 * 1024)
        if (createHash('sha256').update(bytes).digest('hex') !== persona.sha256[key]) throw invalid()
        if (key !== 'avatar') {
          const value = JSON.parse(bytes.toString('utf8'))
          if (!object(value) && !Array.isArray(value)) throw invalid()
        }
        assets[key] = bytes
      }
      files.set(persona.id, assets)
    }
    return {manifest, files}
  } catch { throw invalid() }
}
