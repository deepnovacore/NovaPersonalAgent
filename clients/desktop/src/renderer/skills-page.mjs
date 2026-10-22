import {t} from './locale.mjs'
import {iconNode,withIcon} from './icons.mjs'

const MODULES=[
 ['search','联网搜索','搜索网页并附上来源'],
 ['camera','摄像头','需要时看一眼现场'],
 ['coding','编码','把任务交给本机编码执行器'],
 ['knowledge','知识库','检索你授权的本地资料'],
]

/**
 * Skills are the capabilities the host already reports: built-in modules and
 * Computer Use are "system", user-configured MCP servers are "personal". The
 * registry status carries no secrets, so it is safe to list as-is.
 */
export function skillEntries(status){
 const system=[{id:'computer-use',name:'Computer Use',description:'真实截图与鼠标键盘操作，在 Build 会话中按需开启',state:'session',group:'system'}]
 for(const [id,name,description] of MODULES){
  const module=status?.modules?.[id]
  if(!module)continue
  system.push({id,name,description,state:module.enabled?(module.reason?'degraded':'on'):'off',group:'system'})
 }
 const personal=(status?.servers??[]).map(server=>({id:'mcp:'+server.name,name:server.name,description:'MCP 服务',state:server.status==='failed'?'failed':server.status==='disabled'?'off':'on',group:'personal'}))
 return [...system,...personal]
}

const SKILL_ICON={'computer-use':'monitor',search:'globe',camera:'camera',coding:'code',knowledge:'book'}
const STATE_LABEL={on:'已启用',off:'未启用',failed:'异常',degraded:'已降级',session:'按会话'}

export function filterSkills(entries,group,query){
 const needle=query.trim().toLowerCase()
 return entries.filter(entry=>entry.group===group&&(!needle||`${t(entry.name)} ${t(entry.description)}`.toLowerCase().includes(needle)))
}

export function renderSkillsPage(panel,{el,button,state,refresh,manage}){
 const head=el('div',undefined,'skills-head'),field=el('label',undefined,'skills-search-field'),search=el('input',undefined,'skills-search')
 search.type='search';search.placeholder=t('搜索技能');search.setAttribute('aria-label',t('搜索技能'));search.value=state.query
 {const glass=iconNode('search');if(glass)field.append(glass)};field.append(search);head.append(el('p',t('让 Nova 按需使用的能力'),'hint'),field)
 const refreshButton=button(t('刷新'),refresh,head,'skills-refresh');refreshButton.className='ghost';withIcon(refreshButton,'refresh');refreshButton.disabled=state.loading
 const groups=el('div',undefined,'skills-tabs');groups.setAttribute('role','group')
 const grid=el('div',undefined,'skills-grid')
 const entries=skillEntries(state.status)
 function renderGrid(){
  const visible=filterSkills(entries,state.group,state.query)
  const cards=visible.map(entry=>{
   const card=el('article',undefined,'skill-card'),icon=el('span',undefined,'skill-icon'),copy=el('div',undefined,'skill-copy'),chip=el('span',t(STATE_LABEL[entry.state]),'skill-state')
   {const glyph=iconNode(SKILL_ICON[entry.id]??'plug');if(glyph)icon.append(glyph)};icon.setAttribute('aria-hidden','true')
   chip.dataset.state=entry.state
   copy.append(el('h3',t(entry.name)),el('p',t(entry.description)))
   card.append(icon,copy,chip);return card
  })
  grid.replaceChildren(...(cards.length?cards:[el('p',state.loading?t('正在读取技能…'):state.error?t(state.error):t('没有匹配的技能'),'empty-state')]))
 }
 for(const [group,label] of [['system','系统'],['personal','个人']]){
  const tab=el('button',t(label));tab.type='button';tab.setAttribute('aria-pressed',String(state.group===group))
  tab.addEventListener('click',()=>{state.group=group;for(const node of groups.children)node.setAttribute('aria-pressed',String(node===tab));renderGrid()})
  groups.append(tab)
 }
 search.addEventListener('input',()=>{state.query=search.value;renderGrid()})
 panel.append(head,groups,grid)
 button(t('在设置中管理能力'),manage,panel,'skills-manage').className='link-button'
 renderGrid()
}
