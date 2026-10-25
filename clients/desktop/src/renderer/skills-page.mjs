import {t} from './locale.mjs'
import {iconNode,withIcon} from './icons.mjs'

/**
 * Skills are the folders under ~/.nova-personal-agent/skills, each with a SKILL.md. The host lists them;
 * Computer Use is the only built-in one and is switched on per Build session, so it carries the session state.
 */
export function skillEntries(skills){
 return (skills??[]).map(skill=>({id:skill.id,name:skill.name||skill.id,description:skill.description??'',state:skill.id==='computer-use'?'session':'on'}))
}

const SKILL_ICON={'computer-use':'monitor'}
const STATE_LABEL={on:'已启用',session:'按会话'}

export function filterSkills(entries,query){
 const needle=query.trim().toLowerCase()
 return entries.filter(entry=>!needle||`${t(entry.name)} ${t(entry.description)}`.toLowerCase().includes(needle))
}

export function renderSkillsPage(panel,{el,button,state,refresh}){
 const head=el('div',undefined,'skills-head'),field=el('label',undefined,'skills-search-field'),search=el('input',undefined,'skills-search')
 search.type='search';search.placeholder=t('搜索技能');search.setAttribute('aria-label',t('搜索技能'));search.value=state.query
 {const glass=iconNode('search');if(glass)field.append(glass)};field.append(search);head.append(el('p',t('~/.nova-personal-agent/skills 下的技能'),'hint'),field)
 const refreshButton=button(t('刷新'),refresh,head,'skills-refresh');refreshButton.className='ghost';withIcon(refreshButton,'refresh');refreshButton.disabled=state.loading
 const grid=el('div',undefined,'skills-grid')
 const entries=skillEntries(state.skills)
 function renderGrid(){
  const visible=filterSkills(entries,state.query)
  const cards=visible.map(entry=>{
   const card=el('article',undefined,'skill-card'),icon=el('span',undefined,'skill-icon'),copy=el('div',undefined,'skill-copy'),chip=el('span',t(STATE_LABEL[entry.state]),'skill-state')
   {const glyph=iconNode(SKILL_ICON[entry.id]??'plug');if(glyph)icon.append(glyph)};icon.setAttribute('aria-hidden','true')
   chip.dataset.state=entry.state
   copy.append(el('h3',t(entry.name)),el('p',t(entry.description)))
   card.append(icon,copy,chip);return card
  })
  grid.replaceChildren(...(cards.length?cards:[el('p',state.loading?t('正在读取技能…'):state.error?t(state.error):entries.length?t('没有匹配的技能'):t('还没有技能。把带 SKILL.md 的文件夹放进技能目录，刷新即可。'),'empty-state')]))
 }
 search.addEventListener('input',()=>{state.query=search.value;renderGrid()})
 panel.append(head,grid)
 renderGrid()
}
