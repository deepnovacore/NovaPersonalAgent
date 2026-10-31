import assert from 'node:assert/strict'
import {test} from 'node:test'
import {chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadSettings} from '../src/config/config.js'
import {HostSecretStore, overlaySpaceSecrets} from '../src/space-host/host-admin.js'
import {HostModelRoutesStore, hostModelRoutesPath, modelRoutesPatchSchema, overlaySpaceModelRoutes, readHostModelRoutes, seedHostModelRoutes, subscribeHostModelRoutesChanges} from '../src/space-host/model-settings.js'

const route = {provider: 'deepseek' as const, model: 'deepseek-chat'}
async function fixture() {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-model-settings-'))
  return {dir, path: join(dir, 'config.json'), close: () => rm(dir, {recursive: true, force: true})}
}

test('model patch strictly reuses lane/provider/model validation and requires a version and routes', () => {
  assert.equal(modelRoutesPatchSchema.safeParse({expected_version: 0, routes: {support: route}}).success, true)
  for (const input of [{routes: {}}, {expected_version: 0}, {expected_version: -1, routes: {}},
    {expected_version: 0, routes: {}, endpoint: 'https://example.invalid'},
    {expected_version: 0, routes: {unknown: route}},
    {expected_version: 0, routes: {watch: {provider: 'self-hosted', model: 'x'}}},
    {expected_version: 0, routes: {support: {provider: 'unknown', model: 'x'}}},
    {expected_version: 0, routes: {support: {...route, endpoint: 'https://example.invalid'}}},
    {expected_version: 0, routes: {support: {...route, model: '\n'}}}]) assert.equal(modelRoutesPatchSchema.safeParse(input).success, false, JSON.stringify(input))
})

test('seeding publishes private complete data once; missing reads do not create files', async () => {
  const f = await fixture()
  try {
    assert.equal(readHostModelRoutes(f.path), null)
    await assert.rejects(stat(hostModelRoutesPath(f.path)), {code: 'ENOENT'})
    await Promise.all([seedHostModelRoutes(f.path, {support: route}), seedHostModelRoutes(f.path, {fast: route})])
    const initial = readHostModelRoutes(f.path)!
    assert.equal(initial.version, 0)
    assert.equal(Object.keys(initial.routes).length, 1)
    await seedHostModelRoutes(f.path, {})
    assert.deepEqual(readHostModelRoutes(f.path), initial)
    if (process.platform !== 'win32') assert.equal((await stat(hostModelRoutesPath(f.path))).mode & 0o777, 0o600)
  } finally {await f.close()}
})

test('sparse/null patches, serialized CAS, durable replay after intervening edits and startup applied version', async () => {
  const f = await fixture(), environment = {DEEPSEEK_API_KEY: 'private-value'}
  try {
    await seedHostModelRoutes(f.path, {support: route, fast: route})
    const store = new HostModelRoutesStore(f.path, environment)
    const first = {expected_version: 0, routes: {support: {...route, model: 'deepseek-flash'}}}
    assert.deepEqual(await store.configure(first, 'a'), {version: 1, applies: 'restart'})
    assert.deepEqual(store.view().routes.fast, route)
    const outcomes = await Promise.allSettled([
      store.configure({expected_version: 1, routes: {support: null}}, 'b'),
      store.configure({expected_version: 1, routes: {fast: null}}, 'c'),
    ])
    assert.equal(outcomes[0]!.status, 'fulfilled')
    assert.equal(outcomes[1]!.status, 'rejected')
    assert.equal((outcomes[1] as PromiseRejectedResult).reason.message, 'version_conflict')
    assert.equal(store.view().routes.support, undefined)
    assert.deepEqual(store.view().routes.fast, route)
    assert.equal(store.view().applied_version, 0)
    // Recreate the process after a write whose service receipt was never committed.
    const restarted = new HostModelRoutesStore(f.path, environment)
    assert.equal(restarted.view().applied_version, 2)
    assert.deepEqual(await restarted.configure(first, 'a'), {version: 1, applies: 'restart'})
    assert.equal(restarted.view().version, 2)
    await assert.rejects(restarted.configure({...first, routes: {}}, 'a'), /op_id_conflict/)
    await assert.rejects(restarted.configure({...first, routes: {support: {...route, model: ' deepseek-flash '}}}, 'a'), /op_id_conflict/)
    await assert.rejects(restarted.configure(first, 'new-operation'), /version_conflict/)
    assert.equal(JSON.stringify(restarted.view()).includes(environment.DEEPSEEK_API_KEY), false)
  } finally {await f.close()}
})

test('operator routes win and lock writes; stored routes and keys become actual runtime settings after restart', async () => {
  const f = await fixture()
  try {
    const secrets = new HostSecretStore(f.path + '.secrets.json')
    await secrets.open()
    const store = new HostModelRoutesStore(f.path, {}, {credentialConfigured: name => !!secrets.value(name)?.trim()})
    assert.equal(store.view().providers.find(provider => provider.id === 'deepseek')!.usable, false)
    await assert.rejects(store.configure({expected_version: 0, routes: {conversationText: route}}, 'before-key'), /model_provider_unconfigured/)
    assert.equal(store.view().version, 0)
    assert.equal(store.view().providers.find(provider => provider.id === 'deepseek')!.usable, false)
    await secrets.put('DEEPSEEK_API_KEY', 'new-private-value')
    assert.equal(store.view().providers.find(provider => provider.id === 'deepseek')!.usable, true)
    await store.configure({expected_version: 0, routes: {conversationText: route}}, 'after-key')
    const environment = overlaySpaceModelRoutes(overlaySpaceSecrets({}, f.path), f.path)
    assert.deepEqual(loadSettings({...environment, MEMORY_CONNECTION: 'disabled'}, true).model_routes.conversationText, route)
    const explicit = {MODEL_ROUTES: JSON.stringify({fast: route})}
    assert.equal(overlaySpaceModelRoutes(explicit, f.path), explicit)
    const locked = new HostModelRoutesStore(f.path, explicit)
    assert.equal(locked.view().locked, true)
    assert.equal(locked.view().source, 'environment')
    assert.deepEqual(locked.view().routes, {fast: route})
    await assert.rejects(locked.configure({expected_version: 1, routes: {}}, 'locked'), /models_locked_by_environment/)
    assert.equal(JSON.stringify(store.view()).includes('new-private-value'), false)
    await writeFile(hostModelRoutesPath(f.path), '{')
    assert.equal(overlaySpaceModelRoutes(explicit, f.path), explicit)
    const lockedDamaged = new HostModelRoutesStore(f.path, explicit)
    assert.deepEqual(lockedDamaged.view().routes, {fast: route})
    await assert.rejects(lockedDamaged.configure({expected_version: 0, routes: {}}, 'locked-damaged'), /models_locked_by_environment/)
    assert.equal(await readFile(hostModelRoutesPath(f.path), 'utf8'), '{')
  } finally {await f.close()}
})

test('custom providers require existing usable endpoints and project credential readiness without disclosing either', async () => {
  const f = await fixture()
  try {
    for (const environment of [{}, {SELF_HOSTED_LLM_BASE_URL: 'file:///tmp/private'}, {SELF_HOSTED_LLM_BASE_URL: 'https://user:password@example.invalid'}]) {
      const store = new HostModelRoutesStore(f.path, environment)
      await assert.rejects(store.configure({expected_version: 0, routes: {support: {provider: 'self-hosted', model: 'local'}}}, 'invalid'), /model_provider_unconfigured/)
    }
    const environment = {SELF_HOSTED_LLM_BASE_URL: 'http://127.0.0.1:1234/v1', OPENAI_COMPATIBLE_BASE_URL: 'https://private.example.invalid/v1'}
    const store = new HostModelRoutesStore(f.path, environment)
    await store.configure({expected_version: 0, routes: {support: {provider: 'self-hosted', model: 'local'}}}, 'local')
    assert.equal(store.view().providers.find(provider => provider.id === 'self-hosted')!.configured, false)
    assert.equal(store.view().providers.find(provider => provider.id === 'self-hosted')!.usable, true)
    await assert.rejects(store.configure({expected_version: 1, routes: {fast: {provider: 'openai-compatible', model: 'x'}}}, 'compatible'), /model_provider_unconfigured/)
    assert.equal(store.view().providers.find(provider => provider.id === 'openai-compatible')!.usable, false)
    assert.equal(store.view().providers.find(provider => provider.id === 'self-hosted')!.keyOptional, true)
    assert.equal(JSON.stringify(store.view()).includes('127.0.0.1'), false)
    assert.equal(JSON.stringify(store.view()).includes('private.example.invalid'), false)
  } finally {await f.close()}
})

test('changed lanes require usable providers while unchanged invalid routes and null resets do not block other edits', async () => {
  const f = await fixture()
  try {
    await seedHostModelRoutes(f.path, {support: {provider: 'self-hosted', model: 'old-local'}, fast: route})
    const store = new HostModelRoutesStore(f.path, {GEMINI_API_KEY: 'operator-key', OPENAI_API_KEY: '   '})
    await store.configure({expected_version: 0, routes: {compressor: {provider: 'gemini', model: 'gemini-3.5-flash-lite'}}}, 'operator-key')
    assert.deepEqual(store.view().routes.fast, route)
    await assert.rejects(store.configure({expected_version: 1, routes: {fast: {...route, model: 'deepseek-flash'}}}, 'missing-key'), /model_provider_unconfigured/)
    await assert.rejects(store.configure({expected_version: 1, routes: {conversationText: {provider: 'openai', model: 'gpt-6-sol'}}}, 'blank-key'), /model_provider_unconfigured/)
    assert.equal(store.view().providers.find(provider => provider.id === 'openai')!.usable, false)
    assert.equal(store.view().version, 1)
    await store.configure({expected_version: 1, routes: {support: null, fast: null}}, 'reset')
    assert.equal(store.view().routes.support, undefined)
    assert.equal(store.view().routes.fast, undefined)
    assert.equal(store.view().routes.compressor?.provider, 'gemini')
  } finally {await f.close()}
})

test('damaged, oversized, symlinked and public-readable model documents are preserved and fail closed', async () => {
  const f = await fixture(), path = hostModelRoutesPath(f.path)
  try {
    for (const text of ['{', '{"v":2}', ' '.repeat(129 * 1024)]) {
      await writeFile(path, text, {mode: 0o600})
      assert.throws(() => readHostModelRoutes(f.path), /space_models_invalid/)
      assert.throws(() => new HostModelRoutesStore(f.path, {}), /space_models_invalid/)
      await seedHostModelRoutes(f.path, {})
      assert.equal(await readFile(path, 'utf8'), text)
    }
    await rm(path)
    await seedHostModelRoutes(f.path, {})
    if (process.platform !== 'win32') {
      await chmod(path, 0o644)
      assert.throws(() => readHostModelRoutes(f.path), /space_models_invalid/)
      await chmod(path, 0o600)
    }
    const linked = join(f.dir, 'linked')
    await symlink(path, hostModelRoutesPath(linked))
    assert.throws(() => readHostModelRoutes(linked), /space_models_invalid/)
    const store = new HostModelRoutesStore(f.path, {})
    await writeFile(path, '{')
    await assert.rejects(store.configure({expected_version: 0, routes: {}}, 'damaged'), /space_models_invalid/)
    assert.equal(await readFile(path, 'utf8'), '{')
  } finally {await f.close()}
})

test('an existing empty document stays untouched by reads, writes and seeding; explicit operator routes remain usable', async () => {
  const f = await fixture(), path = hostModelRoutesPath(f.path)
  try {
    const store = new HostModelRoutesStore(f.path, {})
    await writeFile(path, '', {mode: 0o600})
    assert.throws(() => readHostModelRoutes(f.path), /space_models_invalid/)
    assert.throws(() => new HostModelRoutesStore(f.path, {}), /space_models_invalid/)
    assert.throws(() => overlaySpaceModelRoutes({}, f.path), /space_models_invalid/)
    await assert.rejects(store.configure({expected_version: 0, routes: {}}, 'empty'), /space_models_invalid/)
    await seedHostModelRoutes(f.path, {support: route})
    const explicit = {MODEL_ROUTES: JSON.stringify({fast: route})}
    assert.equal(overlaySpaceModelRoutes(explicit, f.path), explicit)
    const locked = new HostModelRoutesStore(f.path, explicit)
    assert.deepEqual(locked.view().routes, {fast: route})
    assert.equal(locked.view().locked, true)
    await assert.rejects(locked.configure({expected_version: 0, routes: {}}, 'locked-empty'), /models_locked_by_environment/)
    assert.equal(await readFile(path, 'utf8'), '')
  } finally {await f.close()}
})

test('durable operation receipts stay bounded and observers receive only successful changes', async () => {
  const f = await fixture()
  let changes = 0
  const unsubscribe = subscribeHostModelRoutesChanges(() => {changes++})
  try {
    const store = new HostModelRoutesStore(f.path, {})
    for (let version = 0; version < 66; version++) await store.configure({expected_version: version, routes: {}}, 'op-' + version)
    const file = JSON.parse(await readFile(hostModelRoutesPath(f.path), 'utf8')) as {applied_ops: unknown[]}
    assert.equal(file.applied_ops.length, 64)
    assert.equal(changes, 66)
    await store.configure({expected_version: 65, routes: {}}, 'op-65')
    assert.equal(changes, 66)
    unsubscribe()
    await store.configure({expected_version: 66, routes: {}}, 'last')
    assert.equal(changes, 66)
  } finally {unsubscribe(); await f.close()}
})
