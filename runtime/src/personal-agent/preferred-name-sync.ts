/** The authorized memory slot is durable authority; settings is its local display mirror.
 * undefined means this provider cannot inspect names, null means the name was forgotten.
 * Call before identity injection and after explicit memory admission. A failed mirror
 * propagates to the caller and is repaired by the same read on the next attempt/restart.
 */
export function createPreferredNameSync(options: {
  readMemory: () => Promise<string | null | undefined>
  readSettings: () => string
  saveSettings: (name: string) => Promise<void>
}) {
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation)
    tail = run.catch(() => { /* A failed mirror must remain retryable. */ })
    return run
  }
  const synchronize = async (): Promise<void> => {
    for (;;) {
      const stored = await options.readMemory()
      if (stored === undefined) return
      const name = stored ?? ''
      if (name === options.readSettings()) return
      await options.saveSettings(name)
      // An admitted chat rename may race a settings write. Re-read authorized
      // current memory rather than applying the older tool argument or receipt.
    }
  }
  return {
    synchronize: () => serial(synchronize),
    commitMemory: <T>(write: () => Promise<T>): Promise<T> => serial(async () => {
      const result = await write()
      await synchronize()
      return result
    }),
  }
}
