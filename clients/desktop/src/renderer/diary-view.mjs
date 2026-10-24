import {t} from './locale.mjs'
export function renderDiarySection(parent,{memory,caps,el,button,command,connected}){
 if(!caps.memory?.diaries)return
 const section=el('section',undefined,'card');section.append(el('h3',t('每日日记')),el('p',t('由模型整理，可能不完整；不会作为新的事实输入模型。')));parent.append(section)
 const entries=memory?.diaries??[]
 if(!entries.length)section.append(el('p',t('暂无日记。有昨天的授权记忆时会自动生成。')))
 for(const entry of entries){
  const row=el('details'),summary=el('summary',entry.day);row.append(summary)
  const text=el('p',entry.text);text.style.whiteSpace='pre-wrap';row.append(text)
  const remove=button(t('删除日记'),()=>command('memory.forget',{id:entry.id,expected_version:entry.version}),row,`diary:${entry.id}`);remove.disabled=!connected
  section.append(row)
 }
 if(entries.length===30)button(t('更早的日记'),()=>command('memory.diaries',{before:entries.at(-1).day}),section,'diary:page')
 if(memory?.diary_before)button(t('最新日记'),()=>command('memory.diaries',{}),section,'diary:page')
}
