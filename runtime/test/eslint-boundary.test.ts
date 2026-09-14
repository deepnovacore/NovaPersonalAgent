import assert from 'node:assert/strict'
import {join} from 'node:path'
import {test} from 'node:test'
import {ESLint} from 'eslint'

const repositoryRoot = join(import.meta.dirname, '../../..')
const CORE_PROBE = 'runtime/src/boundary-negative-probe.ts'
const EXECUTOR_PROBE = 'runtime/src/executors/codex/eslint-boundary-negative.ts'
/** Probes are linted in memory and never written under `runtime/src`. */
const eslint = new ESLint({
  overrideConfigFile: join(repositoryRoot, 'eslint.config.mjs'),
  cwd: repositoryRoot,
  overrideConfig: {
    languageOptions: {
      parserOptions: {projectService: {allowDefaultProject: [CORE_PROBE, EXECUTOR_PROBE]}, tsconfigRootDir: repositoryRoot},
    },
  },
})

async function lintVirtual(relativePath: string, source: string) {
  const results = await eslint.lintText(source, {filePath: join(repositoryRoot, relativePath)})
  return results[0]?.messages.filter(message => ['no-restricted-imports', 'no-restricted-syntax'].includes(message.ruleId ?? '')) ?? []
}

test('eslint blocks Codex internals while allowing the executor registry', async () => {
  const violations = await lintVirtual(CORE_PROBE, "import {CodexLiveAdapter} from './executors/codex/adapter-live.js'\n")
  assert.ok(violations.length > 0, violations.map(item => item.message).join('; '))
  assert.deepEqual(await lintVirtual(CORE_PROBE, "import {CodexLiveAdapter} from './executors/index.js'\n"), [])
  assert.ok((await lintVirtual(CORE_PROBE, "await import('./executors/codex/host.js')\n")).length > 0)
  assert.deepEqual(await lintVirtual(CORE_PROBE, "await import('./executors/index.js')\n"), [])
})

test('core cannot bypass the registry for another executor package; coding remains a role-level port', async () => {
  for (const source of ["import './executors/example/adapter.js'", "await import('./executors/example/adapter.js')"]) {
    assert.ok((await lintVirtual(CORE_PROBE, source)).length > 0)
  }
  for (const source of ["import './executors/coding/intake.js'", "await import('./executors/coding/intake.js')"]) {
    assert.deepEqual(await lintVirtual(CORE_PROBE, source), [])
  }
})

test('eslint blocks executor imports of the realtime layer', async () => {
  const violations = await lintVirtual(EXECUTOR_PROBE, "import {RealtimeService} from '../../realtime/service.js'\n")
  assert.ok(violations.length > 0, violations.map(item => item.message).join('; '))
})

test('composition host authority exception does not admit other Codex internals', async () => {
  const path = 'runtime/src/composition/production-composition.ts'
  for (const source of ["import '../executors/codex/host.js'", "await import('../executors/codex/host.js')"]) {
    assert.deepEqual(await lintVirtual(path, source), [])
  }
  for (const source of ["import '../executors/codex/adapter-live.js'", "await import('../executors/codex/adapter-live.js')", "import '../executors/example/adapter.js'", "await import('../executors/example/adapter.js')"]) {
    assert.ok((await lintVirtual(path, source)).length > 0)
  }
})
