// Loaded with --import before every CLI test: points every home variable at a throwaway directory so no test can
// read or write the real ~/.nova-personal-agent, ~/.nova-audio-agent or desktop profiles, and refuses to run otherwise.
import {mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join, relative, isAbsolute} from 'node:path'

const home = mkdtempSync(join(realpathSync(tmpdir()), 'nova-cli-home-'))
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = home
process.env.APPDATA = join(home, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.on('exit', () => rmSync(home, {recursive: true, force: true}))

const inside = relative(realpathSync(tmpdir()), realpathSync(homedir()))
if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
  throw new Error(`CLI tests must run with a temporary home, got ${homedir()}`)
}
