import {existsSync, readdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'

// Keep the output directory itself: it may link to an external build volume.
if (existsSync('dist')) {
  for (const entry of readdirSync('dist')) rmSync(join('dist', entry), {recursive: true, force: true})
}
