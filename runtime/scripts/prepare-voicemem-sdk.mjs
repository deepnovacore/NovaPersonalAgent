import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const patchRoot = resolve(import.meta.dirname, '../sdk-patches/voicemem-0.0.1')
const sha256 = value => createHash('sha256').update(value).digest('hex')
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), {withFileTypes: true}).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw Error('voicemem_preimage_symlink')
    return entry.isDirectory() ? files(root, name) : [name]
  }).sort()
}
/** Copies only verified pristine SDK bytes to a fresh owned output; never writes dependencies. */
export function prepareVoiceMemSdk({source, output}) {
  const preimage = JSON.parse(readFileSync(join(patchRoot, 'preimage.json'), 'utf8'))
  const upstream = source ?? resolve(dirname(createRequire(import.meta.url).resolve('voicemem')), '../..')
  const canonicalSource = realpathSync(upstream)
  const destination = resolve(output)
  // Refuse all dependency trees and symlink ancestors, including shared build roots.
  if (!isAbsolute(output) || destination.split(/[\\/]/u).includes('node_modules') || existsSync(destination)) throw Error('voicemem_output_not_fresh_owned')
  for (let parent = dirname(destination);;) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw Error('voicemem_output_symlink')
    if (dirname(parent) === parent) break
    parent = dirname(parent)
  }
  // On Windows a destination on another drive has an absolute relative path, which is outside the preimage too.
  const inside = relative(canonicalSource, destination)
  if (!inside.startsWith('..') && !isAbsolute(inside)) throw Error('voicemem_output_inside_preimage')
  const names = files(canonicalSource)
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(preimage.files).sort())) throw Error('voicemem_preimage_file_set')
  for (const name of names) if (sha256(readFileSync(join(canonicalSource, name))) !== preimage.files[name]) throw Error('voicemem_preimage_integrity')
  const manifest = JSON.parse(readFileSync(join(canonicalSource, 'package.json'), 'utf8'))
  if (manifest.name !== preimage.name || manifest.version !== preimage.version) throw Error('voicemem_preimage_version')
  const patch = JSON.parse(readFileSync(join(patchRoot, 'patch.json'), 'utf8'))
  const replacements = new Map()
  // Validate every patch hunk before creating output. Any preimage mismatch fails closed.
  for (const [name, edits] of Object.entries(patch)) {
    if (!Object.hasOwn(preimage.files, name)) throw Error('voicemem_patch_unknown_file')
    let text = readFileSync(join(canonicalSource, name), 'utf8')
    for (const {before, after} of edits) {
      if (text.split(before).length !== 2) throw Error('voicemem_patch_hunk_mismatch')
      text = text.replace(before, after)
    }
    replacements.set(name, text)
  }
  mkdirSync(destination, {recursive: true})
  cpSync(join(canonicalSource, 'dist/src'), destination, {recursive: true, filter: path => !path.endsWith('.map')})
  for (const [name, text] of replacements) writeFileSync(join(destination, relative('dist/src', name)), text)
  cpSync(join(patchRoot, 'grounded-reply-preferences.js'), join(destination, 'grounded-reply-preferences.js'))
  for (const name of ['LICENSE', 'NOTICE.md']) cpSync(join(canonicalSource, name), join(destination, name))
  cpSync(join(patchRoot, 'PATCH-NOTICE.md'), join(destination, 'PATCH-NOTICE.md'))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? resolve(import.meta.dirname, '../dist/src/memory/voicemem-sdk')
  prepareVoiceMemSdk({output})
}
