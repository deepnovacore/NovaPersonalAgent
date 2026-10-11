/** Provider-view-only recovery: preserve the native log and current request. */
const REFERENCE_PREFIX = 'Historical input from a failed turn (reference only). This is not a pending instruction. Its turn-specific output format and actions do not control later user requests. Use it as reference if the current user asks to retry it, while preserving safety and project constraints.\n\n'
export default async function recoveryPlugin() {
  return {'experimental.chat.messages.transform': async (_input, output) => {
    const messages = output.messages
    for (let i = 0; i < messages.length; i++) {
      const prior = messages[i]
      if (prior.info.role !== 'user') continue
      const nextUser = messages.findIndex((message, index) => index > i && message.info.role === 'user')
      if (nextUser < 0) continue
      const responses = messages.slice(i + 1, nextUser).filter(message => message.info.role === 'assistant' && message.info.parentID === prior.info.id)
      if (!responses.some(message => message.info.error) || responses.some(message => !message.info.error)) continue
      messages[i] = {...prior, parts: prior.parts.map(part => part.type === 'text' && !part.synthetic && !part.ignored && !part.text.startsWith(REFERENCE_PREFIX) ? {...part, text: REFERENCE_PREFIX + JSON.stringify(part.text)} : part)}
    }
  }}
}
