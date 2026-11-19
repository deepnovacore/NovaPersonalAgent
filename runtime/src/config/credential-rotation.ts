/**
 * Live credential replacement. Clients hold the key they were built with; when the desktop saves a new value for a key that
 * was already in use it sends `from → to`, and every place that sends a key passes it through `rotatedCredential` first.
 * Only an existing key can be rotated: a lane that had no key was built unconfigured and still needs a restart.
 */
const MAX_LENGTH = 4096
const rotations = new Map<string, string>()
const usable = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)

/** The key to send now: the replacement if this one was rotated, otherwise itself. */
export function rotatedCredential(key: string): string {
  return key === '' ? key : rotations.get(key) ?? key
}

export function rotateCredential(from: unknown, to: unknown): boolean {
  if (!usable(from) || !usable(to)) return false
  if (from === to) return true
  // Earlier rotations that ended at `from` now end at `to`, so a client built with the oldest key still follows the chain.
  for (const [original, current] of rotations) if (current === from) rotations.set(original, to)
  rotations.set(from, to)
  return true
}

export function resetCredentialRotations(): void { rotations.clear() }
