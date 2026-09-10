// The orb menu's MCP rows, kept out of main.mjs because a popped-up native
// Menu cannot be driven from a test. The input is the runtime capability
// snapshot main holds (backend-control.mjs's publicRuntimeCapabilityStatus,
// with main's own state overlay), never anything read from disk here.
const MCP_PREFIX = /^mcp__/
const SERVER_STATUS_LABELS = Object.freeze({
  ok: '正常',
  configured: '已配置',
  disabled: '已停用',
  failed: '失败',
})
// Each degraded case names its own cause: an empty submenu that does not say
// why reads as a broken menu rather than as an absent backend.
const UNAVAILABLE_LABELS = Object.freeze({
  unknown: '能力状态尚未获取',
  startup_failed: '能力模块未能启动',
  stopped: '后端已停止，MCP 状态不可用',
  none: '暂无已配置的 MCP 服务器',
})

/** A dynamic external server carries the mcp__ prefix only inside the runtime. */
export function mcpServerLabel(name) {
  if (typeof name !== 'string') return ''
  return name.replace(MCP_PREFIX, '')
}

/** An unrecognized status is reported as a failure rather than hidden. */
export function mcpServerStatusLabel(status) {
  return SERVER_STATUS_LABELS[status] ?? SERVER_STATUS_LABELS.failed
}

/** Null until the backend reports a compiled tool set. */
export function toolCountLabel(runtime) {
  const count = runtime?.toolCount
  const budget = runtime?.toolBudget
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(budget)) return null
  return `工具 ${count} / 预算 ${budget}`
}

/**
 * What the 活跃 MCP submenu should show right now: either a single
 * `unavailable` reason, or one entry per server. Codex sub-status is surfaced
 * only when it disagrees with the FrontBrain status, since the two differ
 * legitimately and a duplicated label carries nothing.
 */
export function activeMcpMenuDescriptor(runtime) {
  if (!runtime) return {unavailable: UNAVAILABLE_LABELS.unknown, entries: []}
  if (runtime.state === 'startup_failed') return {unavailable: UNAVAILABLE_LABELS.startup_failed, entries: []}
  if (runtime.state === 'stopped') return {unavailable: UNAVAILABLE_LABELS.stopped, entries: []}
  const servers = Array.isArray(runtime.servers) ? runtime.servers : []
  if (servers.length === 0) return {unavailable: UNAVAILABLE_LABELS.none, entries: []}
  return {
    unavailable: null,
    entries: servers.map(server => {
      const codex = server.codex?.status
      return {
        name: server.name,
        label: mcpServerLabel(server.name),
        detail: codex && codex !== server.status
          ? `${mcpServerStatusLabel(server.status)} · Codex ${mcpServerStatusLabel(codex)}`
          : mcpServerStatusLabel(server.status),
      }
    }),
  }
}

/**
 * The submenu's rows as label/enabled pairs. A row is clickable only when the
 * caller supplies an action, so the descriptor's reason rows stay inert.
 */
export function activeMcpMenuRows(runtime) {
  const descriptor = activeMcpMenuDescriptor(runtime)
  const tools = toolCountLabel(runtime)
  const summary = tools ? [{label: tools, enabled: false}] : []
  if (descriptor.unavailable !== null) {
    return [...summary, {label: descriptor.unavailable, enabled: false}]
  }
  return [
    ...summary,
    ...descriptor.entries.map(entry => ({
      label: `${entry.label} · ${entry.detail}`,
      name: entry.name,
      enabled: true,
    })),
  ]
}
