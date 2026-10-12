import {t} from './locale.mjs'
/** Semantic tones identify dimensions; every tag retains a readable label. */
export function renderCardTags(parent,tags,{el}){
 const row=el('div',undefined,'card-tags')
 for(const {label,tone='context'}of tags.filter(tag=>tag.label)){
  const node=el('span',t(label),`card-tag tag-${tone}`);row.append(node)
 }
 if(row.children.length)parent.append(row);return row
}
