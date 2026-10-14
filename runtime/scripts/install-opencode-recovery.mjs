import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const version = (await promisify(execFile)('opencode', ['--version'], {timeout:10000})).stdout.trim()
assert.equal(version, '1.19.0', 'Recheck the native recovery hook before installing on another OpenCode version')
const config = resolve(process.argv[2] ?? process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'))
const directory = join(config, 'plugins'), target = join(directory, 'nova-acp-failure-recovery.js')
const source = await readFile(fileURLToPath(new URL('./opencode-recovery.mjs', import.meta.url)), 'utf8')
let existing
try {existing = await readFile(target, 'utf8')} catch(error) {if(error.code !== 'ENOENT') throw error}
const previousPluginSha256 = 'bbd8aa1807203506fdb55130065e2dbcb57c486707d678cfac75c651d9cbc00f'
assert(existing === undefined || existing === source || createHash('sha256').update(existing).digest('hex') === previousPluginSha256, 'Existing recovery plugin differs; preserve it and review before replacing')
if(existing !== source) {
  await mkdir(directory, {recursive:true, mode:0o700})
  const temporary = `${target}.${randomUUID()}`
  try {await writeFile(temporary, source, {mode:0o600, flag:'wx'}); await rename(temporary, target)}
  finally {await rm(temporary, {force:true})}
}
console.log(JSON.stringify({version, path:target, changed:existing !== source}))
