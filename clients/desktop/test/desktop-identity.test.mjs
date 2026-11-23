import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {
  configureDesktopIdentity,
  DESKTOP_APP_ID,
  DESKTOP_PRODUCT_NAME,
  IDENTITY_RECORD,
  LEGACY_SOURCE_STORAGE_NAME,
  LEGACY_STORAGE_NAME,
  selectedDesktopProfile,
  SOURCE_STORAGE_NAME,
} from '../src/main/desktop-identity.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nova-identity-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  return root
}

function fakeApp(appData, {isPackaged = true} = {}) {
  const app = {
    isPackaged,
    names: [],
    userData: null,
    commandLine: {hasSwitch: () => false},
    setName(value) { app.names.push(value) },
    getPath(key) {
      if (key === 'appData') return appData
      throw new Error(key)
    },
    setPath(key, value) { assert.equal(key, 'userData'); app.userData = value },
    whenReady: () => Promise.resolve(),
  }
  return app
}

/** Every file below `root` with its bytes, to prove a launch changed nothing. */
function snapshot(root) {
  const entries = {}
  const visit = directory => {
    for (const name of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, name.name)
      if (name.isDirectory()) visit(path)
      else entries[path] = readFileSync(path).toString('base64')
    }
  }
  visit(root)
  return entries
}

function legacyProfile(appData, name) {
  const directory = join(appData, name)
  mkdirSync(join(directory, 'space'), {recursive: true})
  writeFileSync(join(directory, 'space', 'config.json'), '{"space":1}')
  writeFileSync(join(directory, 'Local State'), '{"os_crypt":{"encrypted_key":"k"}}')
  writeFileSync(join(directory, 'ambient-orb-settings.json'), JSON.stringify({version: 5, secrets: {dashscopeApiKey: {enc: 'safeStorage', data: 'c2VhbGVk'}}}))
  return directory
}

test('the desktop identity uses the new appId and product name', () => {
  assert.equal(DESKTOP_APP_ID, 'ai.deepnovacore.nova-personal-agent')
  assert.equal(DESKTOP_PRODUCT_NAME, 'Nova Personal Agent')
})

test('a fresh packaged install creates only the new profile and binds the new encryption identity', async t => {
  const appData = fixture(t)
  const app = fakeApp(appData)
  await configureDesktopIdentity(app)
  assert.equal(app.userData, join(appData, DESKTOP_PRODUCT_NAME))
  assert.equal(app.names[0], DESKTOP_PRODUCT_NAME)
  assert.equal(app.names.at(-1), DESKTOP_PRODUCT_NAME)
  assert.deepEqual(readdirSync(appData), [DESKTOP_PRODUCT_NAME])
  assert.equal(JSON.parse(readFileSync(join(appData, DESKTOP_PRODUCT_NAME, IDENTITY_RECORD), 'utf8')).safeStorageName, DESKTOP_PRODUCT_NAME)
})

test('an existing legacy profile is used in place under its legacy storage name; nothing is copied or renamed', async t => {
  const appData = fixture(t)
  const legacy = legacyProfile(appData, LEGACY_STORAGE_NAME)
  const before = snapshot(appData)
  for (let launch = 0; launch < 2; launch += 1) {
    const app = fakeApp(appData)
    await configureDesktopIdentity(app)
    assert.equal(app.userData, legacy)
    assert.equal(app.names[0], LEGACY_STORAGE_NAME, 'safeStorage keeps the identity the secrets were sealed with')
    assert.equal(app.names.at(-1), DESKTOP_PRODUCT_NAME)
    assert.equal(selectedDesktopProfile().legacy, true)
  }
  assert.deepEqual(readdirSync(appData), [LEGACY_STORAGE_NAME])
  assert.deepEqual(snapshot(appData), before)
})

// The selection the merge-base build (3cf1239d) made for existing profiles, mirrored exactly.
test('existing profiles are selected exactly as before the identity change', async t => {
  const launch = async (appData, isPackaged) => {
    const app = fakeApp(appData, {isPackaged})
    await configureDesktopIdentity(app)
    return {userData: app.userData, name: app.names[0]}
  }
  // Packaged, only the source profile has settings: the source profile.
  let appData = fixture(t)
  let source = legacyProfile(appData, LEGACY_SOURCE_STORAGE_NAME)
  assert.deepEqual(await launch(appData, true), {userData: source, name: LEGACY_SOURCE_STORAGE_NAME})
  // ...also when an empty packaged profile directory exists.
  mkdirSync(join(appData, LEGACY_STORAGE_NAME))
  assert.deepEqual(await launch(appData, true), {userData: source, name: LEGACY_SOURCE_STORAGE_NAME})
  // Packaged, both have settings: the packaged legacy profile.
  const packaged = legacyProfile(appData, LEGACY_STORAGE_NAME)
  assert.deepEqual(await launch(appData, true), {userData: packaged, name: LEGACY_STORAGE_NAME})
  // Source launch: always the legacy source profile when it exists.
  assert.deepEqual(await launch(appData, false), {userData: source, name: LEGACY_SOURCE_STORAGE_NAME})
  // Packaged profile directory without settings, no source settings: still the packaged legacy profile.
  appData = fixture(t)
  mkdirSync(join(appData, LEGACY_STORAGE_NAME, 'space'), {recursive: true})
  assert.deepEqual(await launch(appData, true), {userData: join(appData, LEGACY_STORAGE_NAME), name: LEGACY_STORAGE_NAME})
  // Source launch with a source profile directory that has no settings yet.
  appData = fixture(t)
  mkdirSync(join(appData, LEGACY_SOURCE_STORAGE_NAME), {recursive: true})
  assert.deepEqual(await launch(appData, false), {userData: join(appData, LEGACY_SOURCE_STORAGE_NAME), name: LEGACY_SOURCE_STORAGE_NAME})
  assert.deepEqual(readdirSync(appData), [LEGACY_SOURCE_STORAGE_NAME.split('/')[0]], 'nothing new is created for an existing install')
  // No legacy directory at all: a fresh install under the new identity.
  appData = fixture(t)
  assert.deepEqual(await launch(appData, false), {userData: join(appData, SOURCE_STORAGE_NAME), name: SOURCE_STORAGE_NAME})
})

test('a profile created under the new identity wins over a legacy profile', async t => {
  const appData = fixture(t)
  legacyProfile(appData, LEGACY_STORAGE_NAME)
  mkdirSync(join(appData, DESKTOP_PRODUCT_NAME))
  writeFileSync(join(appData, DESKTOP_PRODUCT_NAME, IDENTITY_RECORD), JSON.stringify({version: 1, safeStorageName: DESKTOP_PRODUCT_NAME}))
  const app = fakeApp(appData)
  await configureDesktopIdentity(app)
  assert.equal(app.userData, join(appData, DESKTOP_PRODUCT_NAME))
  assert.equal(app.names[0], DESKTOP_PRODUCT_NAME)
})

test('an explicit isolated user-data directory is preserved', async () => {
  const names = []
  await configureDesktopIdentity({
    isPackaged: true,
    commandLine: {hasSwitch: name => name === 'user-data-dir'},
    setName(value) { names.push(value) },
    getPath() { throw new Error('must not read a default profile') },
    setPath() { throw new Error('must not replace isolated profile') },
    whenReady: () => Promise.resolve(),
  })
  assert.equal(names[0], LEGACY_STORAGE_NAME)
})
