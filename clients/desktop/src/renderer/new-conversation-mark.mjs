import {t} from './locale.mjs'
/** Marks a button whose click opens a new conversation; the label itself stays as written. */
export function markOpensConversation(node){
 const hint=t('会新开一个对话');node.dataset.opensConversation='true';node.title=hint;node.setAttribute('aria-label',`${node.textContent} · ${hint}`);return node
}
