import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

test('publishing requires a candidate that is already an ancestor of main, verified before npm publish', async () => {
  const publish = await readFile(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')
  assert.ok(publish.includes('git merge-base --is-ancestor "$EXPECTED_COMMIT" origin/main'))
  assert.ok(publish.includes('test "$EXPECTED_COMMIT" = "$(git rev-parse HEAD)"'))
  assert.ok(publish.indexOf('git merge-base --is-ancestor') < publish.indexOf('npm publish'))
  assert.ok(publish.indexOf('npm whoami') < publish.indexOf('npm publish'))
})

test('candidate packaging stays gated on the full test matrix', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /needs: \[electron\]/u)
})
