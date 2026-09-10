// The board's channel rail. Channel names are executor names — the runtime
// pins manifest.name === policy.channel — but the wire payload carries no
// display_name, so labels are mirrored here from the manifests rather than
// translated: renaming an executor in the UI alone would desync it from the
// runtime and the docs.
const CHANNEL_LABELS = Object.freeze({
  conversation: '对话',
  watch: 'Watch',
  guard: 'Guard',
  codex: 'Codex',
  search: 'Search',
  mcp__nova_camera: 'Camera',
  mcp__nova_knowledge: 'Knowledge',
})
const MCP_PREFIX = /^mcp__/
/** A dynamic external server's manifest display_name is the bare server name. */
export function channelLabel(name) {
  if (typeof name !== 'string') return ''
  if (CHANNEL_LABELS[name]) return CHANNEL_LABELS[name]
  return name.replace(MCP_PREFIX, '')
}

/** Conversation leads the rail; every other channel keeps its payload order. */
export function orderChannelsConversationFirst(channels) {
  if (!Array.isArray(channels)) return []
  const named = channels.filter(channel => typeof channel?.name === 'string')
  return [
    ...named.filter(channel => channel.name === 'conversation'),
    ...named.filter(channel => channel.name !== 'conversation'),
  ]
}

/**
 * Roving-focus mapping over the live channel list. Unlike the board's
 * top-level boardTabForKey the rail's length is decided at runtime, so the
 * caller passes the ordered names it is currently showing.
 */
export function channelTabForKey(names, activeName, key) {
  if (!Array.isArray(names) || names.length === 0) return null
  if (key === 'Home') return names[0]
  if (key === 'End') return names[names.length - 1]
  const current = names.indexOf(activeName)
  if (current === -1) return null
  if (key === 'ArrowLeft' || key === 'ArrowUp') return names[(current + names.length - 1) % names.length]
  if (key === 'ArrowRight' || key === 'ArrowDown') return names[(current + 1) % names.length]
  return null
}

/**
 * Which channel the rail should show, given what it showed before. Keeps the
 * user's choice across a refresh and falls back to the first channel when that
 * channel is gone.
 */
export function resolveActiveChannel(names, activeName) {
  if (!Array.isArray(names) || names.length === 0) return null
  return names.includes(activeName) ? activeName : names[0]
}

// One accent per channel, derived from the name so a channel keeps its colour
// no matter where it sits in the rail. Positional CSS cannot do this once only
// the selected channel is rendered.
const CHANNEL_ACCENTS = Object.freeze(['#7f9fc5', '#c87986', '#9181a7'])
export function channelAccent(name) {
  const text = String(name ?? '')
  let sum = 0
  for (const character of text) sum += character.codePointAt(0)
  return CHANNEL_ACCENTS[sum % CHANNEL_ACCENTS.length]
}
