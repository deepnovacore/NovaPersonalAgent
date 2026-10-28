/** Explicit renderer snapshots. Values are domain state, never DOM-shaped proxies. */
export interface ShellSnapshot {
 unread?: boolean
 orb?: any
 bubbleLayout?: any
 taskLayout?: any
 tasks?: any
 expandedTasks?: boolean
 taskPlatform?: string
 bubbles?: any[]
 resultVisible?: boolean
 resultTitle?: string
 confirmationPlacement?: string
 palette?: string
 paletteDuration?: number
 profile?: any
 idleState?: any
 skinSettings?: any
 startup?: any
 announcement?: string
 caption?: {text: string, role: string}
 platform?: string
 opaque?: boolean
 sleepTitle?: string
}
export function createShellStore(initial: ShellSnapshot = {}) {
 let value: ShellSnapshot = initial
 const listeners = new Set<() => void>()
 const handlers: Record<string, (...args: any[]) => any> = {}
 return {
  get: () => value,
  set(next: Partial<ShellSnapshot>) { value = {...value, ...next}; for (const fn of listeners) fn() },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  actions(next: Record<string, (...args: any[]) => any>) { Object.assign(handlers, next) },
  invoke(name: string, ...args: any[]) { return handlers[name]?.(...args) },
 }
}
