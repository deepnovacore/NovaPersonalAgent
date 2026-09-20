import {ENGLISH_MESSAGES} from './messages.en.mjs'
export function preferredLanguage(languages = []) {
  return /^zh(?:[-_]|$)/i.test(languages[0] ?? '') ? 'zh-CN' : 'en'
}
let language = globalThis.window?.novaAudioAgentDesktop?.language ?? 'zh-CN'
export function setLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN' }
export function currentLanguage() { return language }
export function t(source, ...values) {
  const text = language === 'en' ? ENGLISH_MESSAGES[source] ?? source : source
  return text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match)
}
// Only the initial, developer-owned HTML. Never walk chat messages or imported content.
export function localizeDocument(document) {
  document.documentElement.lang = language
  const walker = document.createTreeWalker(document.documentElement, 4)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) continue
    const source = node.textContent.trim()
    if (Object.hasOwn(ENGLISH_MESSAGES, source)) node.textContent = node.textContent.replace(source, t(source))
  }
  for (const node of document.querySelectorAll('[title], [placeholder], [aria-label], [alt]')) {
    for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
      if (node.hasAttribute(attribute)) node.setAttribute(attribute, t(node.getAttribute(attribute)))
    }
  }
}
