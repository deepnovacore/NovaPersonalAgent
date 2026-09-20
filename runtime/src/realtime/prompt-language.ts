import {ENGLISH_SYSTEM_PROMPTS} from './system-prompts.en.js'
export type PromptLanguage = 'zh-CN' | 'en'
export function parsePromptLanguage(value: unknown): PromptLanguage | undefined {
  if (value === undefined) return undefined
  if (value === 'zh-CN' || value === 'en') return value
  throw new TypeError('unsupported prompt language')
}
/** Only developer-owned system instructions belong here, never user text or host facts. */
export function translateSystemPrompt(text: string, language: PromptLanguage = 'zh-CN'): string {
  if (language !== 'en') return text
  if (ENGLISH_SYSTEM_PROMPTS[text] !== undefined) return ENGLISH_SYSTEM_PROMPTS[text]
  return text.split('\n').map(line => ENGLISH_SYSTEM_PROMPTS[line] ?? line).join('\n')
}
