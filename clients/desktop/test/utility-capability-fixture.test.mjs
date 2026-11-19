import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {Linter} from 'eslint'
import {createContext, runInContext} from 'node:vm'

test('capability smoke provides the globals used by its real supervisor callback', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const smoke = await readFile(new URL('../scripts/utility-runtime-smoke.mjs', import.meta.url), 'utf8')
  let contextKeys
  const linter = new Linter()
  linter.verify(smoke, {
    plugins: {fixture: {rules: {context: {create: () => ({VariableDeclarator(node) {
      if (node.id.name !== 'context' || node.init?.callee?.object?.name !== 'vm'
        || node.init.callee.property.name !== 'createContext') return
      contextKeys = node.init.arguments[0].properties.map(property => property.key.name)
    }})}}}},
    rules: {'fixture/context': 'error'},
  })
  assert.ok(contextKeys?.length)
  const start = main.indexOf('  backendSupervisor = createBackendSupervisor({')
  assert.notEqual(start, -1)
  const supervisor = main.slice(start, main.indexOf('\n  })', start) + '\n  })'.length)
  // launchBackend is defined in the same VM by the smoke's preceding source fragment.
  const globals = Object.fromEntries([...contextKeys, 'launchBackend'].map(name => [name, 'writable']))
  const diagnostics = linter.verify(supervisor, {languageOptions: {globals}, rules: {'no-undef': 'error'}})
  assert.deepEqual(diagnostics.map(({message}) => message), [])
  // Exercise the real initial status transition with only declared fixture globals.
  const context = createContext(Object.fromEntries(contextKeys.map(name => [name, null])))
  Object.assign(context, {
    launchBackend: () => {},
    createBackendSupervisor: options => options,
    backendStatus: {state: 'stopped', connection: null},
    resetTrayUnreadForBackend: () => {},
    sendToSettings: () => {}, settingsView: () => ({}), sendToOrb: () => {},
  })
  runInContext(supervisor, context)
  assert.doesNotThrow(() => context.backendSupervisor.onStatus({state: 'starting', connection: null}))
})
