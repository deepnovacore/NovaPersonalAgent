import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DISPLAY_CHANGE_EVENT,
  DISPLAY_COLLAPSE_MODES,
  DISPLAY_DEFAULTS,
  DISPLAY_STEP_DENSITIES,
  DISPLAY_STORAGE_KEY,
  isDisplayStorageEvent,
  normalizeDisplayPreferences,
  readDisplayPreferences,
  subscribeDisplayPreferences,
  writeDisplayPreferences,
} from '../src/renderer/view-preferences.mjs'

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null },
    setItem(key, value) { entries.set(key, String(value)) },
    removeItem(key) { entries.delete(key) },
    raw(key) { return entries.get(key) },
  }
}

function fakeWindow() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0 },
  }
}

test('display preferences expose exactly the two supported choices', () => {
  assert.deepEqual([...DISPLAY_STEP_DENSITIES], ['compact', 'standard', 'detailed'])
  assert.deepEqual([...DISPLAY_COLLAPSE_MODES], ['after_reply', 'manual'])
  assert.deepEqual(DISPLAY_DEFAULTS, {steps: 'standard', collapse: 'after_reply'})
})

test('normalizeDisplayPreferences keeps valid choices and defaults every invalid field on its own', () => {
  assert.deepEqual(normalizeDisplayPreferences(), DISPLAY_DEFAULTS)
  assert.deepEqual(normalizeDisplayPreferences(null), DISPLAY_DEFAULTS)
  assert.deepEqual(normalizeDisplayPreferences('compact'), DISPLAY_DEFAULTS)
  assert.deepEqual(normalizeDisplayPreferences([]), DISPLAY_DEFAULTS)
  assert.deepEqual(normalizeDisplayPreferences({steps: 'compact'}), {steps: 'compact', collapse: 'after_reply'})
  assert.deepEqual(normalizeDisplayPreferences({steps: 'verbose', collapse: 'manual'}), {steps: 'standard', collapse: 'manual'})
  assert.deepEqual(normalizeDisplayPreferences({steps: 'detailed', collapse: 'never'}), {steps: 'detailed', collapse: 'after_reply'})
  // Unknown keys never survive normalization.
  assert.deepEqual(normalizeDisplayPreferences({steps: 'compact', theme: 'dark'}), {steps: 'compact', collapse: 'after_reply'})
})

test('readDisplayPreferences treats missing, empty and corrupt storage as the defaults', () => {
  const storage = fakeStorage()
  assert.deepEqual(readDisplayPreferences(storage), DISPLAY_DEFAULTS)
  storage.setItem(DISPLAY_STORAGE_KEY, '')
  assert.deepEqual(readDisplayPreferences(storage), DISPLAY_DEFAULTS)
  storage.setItem(DISPLAY_STORAGE_KEY, '{not json')
  assert.deepEqual(readDisplayPreferences(storage), DISPLAY_DEFAULTS)
  storage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({steps: 'detailed', collapse: 'manual'}))
  assert.deepEqual(readDisplayPreferences(storage), {steps: 'detailed', collapse: 'manual'})
  storage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({steps: 'compact', collapse: 'nope'}))
  assert.deepEqual(readDisplayPreferences(storage), {steps: 'compact', collapse: 'after_reply'})
  assert.deepEqual(readDisplayPreferences(null), DISPLAY_DEFAULTS)
})

test('writeDisplayPreferences merges a patch, persists the normalized value and notifies this window', () => {
  const storage = fakeStorage()
  const target = fakeWindow()
  const seen = []
  target.addEventListener(DISPLAY_CHANGE_EVENT, event => seen.push(event.detail))

  assert.deepEqual(writeDisplayPreferences({steps: 'compact'}, {storage, target}),
    {steps: 'compact', collapse: 'after_reply'})
  assert.deepEqual(JSON.parse(storage.raw(DISPLAY_STORAGE_KEY)), {steps: 'compact', collapse: 'after_reply'})
  assert.deepEqual(writeDisplayPreferences({collapse: 'manual'}, {storage, target}),
    {steps: 'compact', collapse: 'manual'})
  assert.deepEqual(JSON.parse(storage.raw(DISPLAY_STORAGE_KEY)), {steps: 'compact', collapse: 'manual'})
  assert.deepEqual(seen, [
    {steps: 'compact', collapse: 'after_reply'},
    {steps: 'compact', collapse: 'manual'},
  ])

  // Invalid patches fall back per field instead of writing junk.
  assert.deepEqual(writeDisplayPreferences({steps: 'huge'}, {storage, target}),
    {steps: 'standard', collapse: 'manual'})
  // No storage at all (opaque origins) still returns the value this window must
  // use, based on the defaults it cannot read from disk.
  assert.deepEqual(writeDisplayPreferences({steps: 'detailed'}, {storage: null, target}),
    {steps: 'detailed', collapse: 'after_reply'})
})

test('a storage event from another window updates subscribers; unrelated keys are ignored', () => {
  const storage = fakeStorage()
  const target = fakeWindow()
  const seen = []
  const unsubscribe = subscribeDisplayPreferences(prefs => seen.push(prefs), {target, storage})

  // Another window wrote the value; this window receives the storage event.
  storage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({steps: 'detailed', collapse: 'manual'}))
  target.dispatchEvent({type: 'storage', key: DISPLAY_STORAGE_KEY})
  target.dispatchEvent({type: 'storage', key: 'nova.unrelated'})
  assert.deepEqual(seen, [{steps: 'detailed', collapse: 'manual'}])

  // Clearing all storage resets the view to defaults.
  storage.removeItem(DISPLAY_STORAGE_KEY)
  target.dispatchEvent({type: 'storage', key: null})
  assert.deepEqual(seen.at(-1), DISPLAY_DEFAULTS)

  assert.equal(isDisplayStorageEvent({type: 'storage', key: DISPLAY_STORAGE_KEY}), true)
  assert.equal(isDisplayStorageEvent({type: 'storage', key: null}), true)
  assert.equal(isDisplayStorageEvent({type: 'storage', key: 'other'}), false)
  assert.equal(isDisplayStorageEvent(null), false)

  unsubscribe()
  assert.equal(target.listenerCount('storage'), 0)
  assert.equal(target.listenerCount(DISPLAY_CHANGE_EVENT), 0)
})

test('same-window writes reach a workbench subscriber immediately through the custom event', () => {
  const storage = fakeStorage()
  const window = fakeWindow()
  const seen = []
  subscribeDisplayPreferences(prefs => seen.push(prefs), {target: window, storage})
  writeDisplayPreferences({collapse: 'manual'}, {storage, target: window})
  assert.deepEqual(seen, [{steps: 'standard', collapse: 'manual'}])
})

test('settings and workbench windows agree through one shared storage key', () => {
  const storage = fakeStorage()
  const settingsWindow = fakeWindow()
  const workbenchWindow = fakeWindow()
  const workbenchSeen = []
  subscribeDisplayPreferences(prefs => workbenchSeen.push(prefs), {target: workbenchWindow, storage})
  // The settings window's write dispatches its own custom event; the browser
  // delivers the storage event to the other window.
  const written = writeDisplayPreferences({steps: 'compact', collapse: 'manual'}, {storage, target: settingsWindow})
  workbenchWindow.dispatchEvent({type: 'storage', key: DISPLAY_STORAGE_KEY})
  assert.deepEqual(workbenchSeen.at(-1), written)
  assert.deepEqual(readDisplayPreferences(storage), written)
})
