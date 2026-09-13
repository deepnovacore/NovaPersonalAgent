import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const version = process.env.RELEASE_VERSION
assert.match(version ?? '', /^\d+\.\d+\.\d+$/u, 'release version must be stable semver')
for (const path of ['cli/package.json', 'clients/desktop/package.json']) {
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, version, `${path} release version mismatch`)
}
