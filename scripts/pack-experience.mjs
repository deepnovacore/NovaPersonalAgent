import {existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {loadExperience} from './lib/experience-assets.mjs'

export function packExperience(source, output) {
  const bundle = loadExperience(source, {required: true})
  const sourcePath = realpathSync(source)
  const outputPath = resolve(output)
  try { lstatSync(outputPath); throw new Error('output already exists') } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const destination = join(realpathSync(dirname(outputPath)), outputPath.split(sep).at(-1))
  const inside = relative(sourcePath, destination)
  if (!inside || (!inside.startsWith('..' + sep) && inside !== '..')) throw new Error('output must be independent of source')
  const staging = mkdtempSync(join(dirname(destination), '.experience-stage-'))
  try {
    const experience = join(staging, 'experience')
    mkdirSync(experience, {mode: 0o700})
    for (const persona of bundle.manifest.personas) {
      for (const [key, bytes] of Object.entries(bundle.files.get(persona.id))) {
        writeFileSync(join(experience, persona[key]), bytes, {mode: 0o600, flag: 'wx'})
      }
    }
    writeFileSync(join(experience, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2) + '\n', {mode: 0o600, flag: 'wx'})
    loadExperience(experience, {required: true})
    if (existsSync(destination)) throw new Error('output already exists')
    renameSync(staging, destination)
  } catch (error) {
    rmSync(staging, {recursive: true, force: true})
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') throw new Error('usage: --source DIR --output DIR')
    packExperience(args[1], args[3])
    process.stdout.write('experience bundle staged\n')
  } catch {
    process.stderr.write('experience_bundle_pack_failed\n')
    process.exitCode = 1
  }
}
