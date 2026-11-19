// Decides which saved key changes the running backend can take without a restart. A key is hot-applicable only when the backend
// already holds an older value for it (so the client using it exists) and nothing else in the backend shares that old value.
export const HOT_APPLY_KEYS = Object.freeze([
  'dashscopeApiKey', 'deepseekApiKey', 'arkApiKey', 'openaiApiKey', 'stepfunApiKey',
  'doubaoBigmodelApiKey', 'openaiCompatibleApiKey', 'compatibleAsrApiKey', 'compatibleTtsApiKey',
])

const usable = value => typeof value === 'string' && value.trim() !== '' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)

/** `before` and `after` map secret names to the effective plaintext the backend would be started with. */
export function planSecretChange(before = {}, after = {}) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before[name] ?? '') !== (after[name] ?? ''))
  const rotations = []
  let needsRestart = false
  for (const name of names) {
    const from = before[name], to = after[name]
    const sharedOldValue = Object.entries(before).some(([other, value]) => other !== name && value === from)
    if (HOT_APPLY_KEYS.includes(name) && usable(from) && usable(to) && !sharedOldValue) rotations.push({name, from, to})
    else needsRestart = true
  }
  return {changed: names, rotations, needsRestart}
}

/** Replacement pairs for the backend, deduplicated by value; the names stay in main. */
export function rotationPayload(plan) {
  const seen = new Set(), rotations = []
  for (const {from, to} of plan.rotations) {
    const id = `${from}\u0000${to}`
    if (!seen.has(id)) { seen.add(id); rotations.push({from, to}) }
  }
  return {rotations}
}
