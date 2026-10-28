// Display preferences for the workbench's step view. They are a per-machine UI
// choice, not a host setting: the settings window writes them straight to
// localStorage, and an open workbench window follows along through the `storage`
// event (another window) or a same-window CustomEvent (the window that wrote).
export const DISPLAY_STORAGE_KEY = 'nova.workbench.display'
export const DISPLAY_CHANGE_EVENT = 'nova-display-preferences'
export const DISPLAY_STEP_DENSITIES = Object.freeze(['compact', 'standard', 'detailed'])
export const DISPLAY_COLLAPSE_MODES = Object.freeze(['after_reply', 'manual'])
export const DISPLAY_DEFAULTS = Object.freeze({steps: 'standard', collapse: 'after_reply'})

const STEP_SET = new Set(DISPLAY_STEP_DENSITIES)
const COLLAPSE_SET = new Set(DISPLAY_COLLAPSE_MODES)

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Returns `{steps, collapse}` with every unknown or invalid field replaced. */
export function normalizeDisplayPreferences(raw) {
  const source = isRecord(raw) ? raw : {}
  return {
    steps: STEP_SET.has(source.steps) ? source.steps : DISPLAY_DEFAULTS.steps,
    collapse: COLLAPSE_SET.has(source.collapse) ? source.collapse : DISPLAY_DEFAULTS.collapse,
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Sandboxed or opaque-origin windows can throw on access; defaults still render.
    return null
  }
}

/** Reads and normalizes the stored preferences; missing or corrupt data reads as the defaults. */
export function readDisplayPreferences(storage = defaultStorage()) {
  let parsed = null
  try {
    parsed = JSON.parse(storage?.getItem?.(DISPLAY_STORAGE_KEY) ?? 'null')
  } catch {
    parsed = null
  }
  return normalizeDisplayPreferences(parsed)
}

function dispatchChange(target, detail) {
  if (!target || typeof target.dispatchEvent !== 'function') return
  const CustomEventCtor = target.CustomEvent ?? globalThis.CustomEvent
  const event = typeof CustomEventCtor === 'function'
    ? new CustomEventCtor(DISPLAY_CHANGE_EVENT, {detail})
    : {type: DISPLAY_CHANGE_EVENT, detail}
  target.dispatchEvent(event)
}

/**
 * Merges a patch into the stored preferences, normalizes the result, persists it
 * and notifies this window. Returns the normalized value that was stored.
 */
export function writeDisplayPreferences(patch, {storage = defaultStorage(), target = globalThis} = {}) {
  const next = normalizeDisplayPreferences({...readDisplayPreferences(storage), ...(isRecord(patch) ? patch : {})})
  try {
    storage?.setItem?.(DISPLAY_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A full or unavailable localStorage must not take the panel down; the
    // returned value still applies to this window.
  }
  dispatchChange(target, next)
  return next
}

/** True when a DOM StorageEvent carries our key (or a full storage clear). */
export function isDisplayStorageEvent(event) {
  return event?.key === DISPLAY_STORAGE_KEY || (event?.type === 'storage' && event.key === null)
}

/**
 * Subscribes to cross-window (`storage`) and same-window (CustomEvent) updates.
 * Returns an unsubscribe function.
 */
export function subscribeDisplayPreferences(listener, {target = globalThis, storage = defaultStorage()} = {}) {
  const onStorage = event => { if (isDisplayStorageEvent(event)) listener(readDisplayPreferences(storage)) }
  const onCustom = event => listener(normalizeDisplayPreferences(event?.detail))
  target?.addEventListener?.('storage', onStorage)
  target?.addEventListener?.(DISPLAY_CHANGE_EVENT, onCustom)
  return () => {
    target?.removeEventListener?.('storage', onStorage)
    target?.removeEventListener?.(DISPLAY_CHANGE_EVENT, onCustom)
  }
}
