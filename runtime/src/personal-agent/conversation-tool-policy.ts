import type {ToolBinding} from '../core/tool-schema.js'

/**
 * Chat is the default conversation surface. It may retrieve context and write the user's own
 * memory, but it must not dispatch delegated work, create or cancel tasks, or schedule runs.
 * `enter_plan_mode` was removed: mode changes are an explicit UI action, never a model tool.
 */
export const CHAT_DENIED_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
  'dispatch', 'cancel', 'confirm', 'task', 'schedule', 'publish_plan', 'finish_build',
]))

export function chatToolAllowed(name: string, binding: ToolBinding | undefined, readonlyNames: ReadonlySet<string>): boolean {
  if (CHAT_DENIED_TOOLS.has(name)) return false
  if (name.startsWith('memory__')) return true
  if (name === 'app__context') return true
  if (binding?.kind === 'query') return true
  if (binding?.executor != null && readonlyNames.has(name)) return true
  return false
}
