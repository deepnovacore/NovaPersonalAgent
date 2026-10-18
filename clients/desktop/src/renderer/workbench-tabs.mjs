import {t} from './locale.mjs'
// The right workspace pages share horizontal keyboard navigation.
export const WORKSPACE_PAGES=Object.freeze([
 Object.freeze({id:'timeline',label:'时间线',title:'时间线',icon:'M7 3v18M7 6h10M7 12h7M7 18h10M4 6h0M4 12h0M4 18h0'}),
 Object.freeze({id:'todos',label:'待办',title:'待办',icon:'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9'}),
 Object.freeze({id:'ideas',label:'想法',title:'想法',icon:'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.3 1 2.5h6c0-1.2.4-1.9 1-2.5A6 6 0 0 0 12 3z'}),
 Object.freeze({id:'goals',label:'目标',title:'目标',icon:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'}),
 Object.freeze({id:'feeds',label:'资讯',title:'资讯',icon:'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5'}),
 Object.freeze({id:'tasks',label:'任务',title:'Agent 执行',icon:'M13 2L4 14h7l-1 8 9-12h-7z'}),
 Object.freeze({id:'profile',label:'Profile',title:'Profile',icon:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'}),
])
export const PAGE_IDS=WORKSPACE_PAGES.map(item=>item.id)
export function workspaceTabForKey(active,key){
 if(key==='Home')return PAGE_IDS[0];if(key==='End')return PAGE_IDS.at(-1)
 const current=PAGE_IDS.indexOf(active);if(current===-1)return null
 if(key==='ArrowLeft')return PAGE_IDS[(current+PAGE_IDS.length-1)%PAGE_IDS.length]
 if(key==='ArrowRight')return PAGE_IDS[(current+1)%PAGE_IDS.length]
 return null
}
/** The main conversation stays outside this tablist. */
export function mountWorkspaceTabs(root,{document=globalThis.document,onSelect}){
 const nav=document.createElement('nav');nav.className='workspace-topbar';nav.setAttribute('aria-label',t('工作区'))
 const list=document.createElement('div');list.className='workspace-tabs';list.setAttribute('role','tablist');list.setAttribute('aria-label',t('工作区'));list.setAttribute('aria-orientation','horizontal');nav.append(list)
 const buttons=new Map(),badges=new Map();let active=null
 for(const item of WORKSPACE_PAGES){
  const b=document.createElement('button');b.type='button';b.className='workspace-tab';b.title=item.label===item.title?t(item.label):`${t(item.label)} · ${t(item.title)}`;b.setAttribute('aria-label',b.title);b.setAttribute('role','tab');b.setAttribute('aria-controls','workbench-panel');b.id=`workspace-tab-${item.id}`;b.dataset.page=item.id
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',item.icon);svg.append(path);b.append(svg)
  const label=document.createElement('span');label.className='workspace-tab-label';label.textContent=t(item.label);b.append(label)
  const badge=document.createElement('span');badge.className='workspace-tab-badge';badge.hidden=true;b.append(badge);badges.set(item.id,badge)
  list.append(b);buttons.set(item.id,b)
  b.addEventListener('click',()=>onSelect(item.id))
  b.addEventListener('keydown',event=>{const next=workspaceTabForKey(item.id,event.key);if(!next)return;event.preventDefault();onSelect(next);buttons.get(next)?.focus?.()})
 }
 root.append(nav)
 function select(id){const changed=active!==id;active=id;for(const [key,b]of buttons){const current=key===id;b.setAttribute('aria-current',String(current));b.setAttribute('aria-selected',String(current));b.tabIndex=current?0:-1}if(changed)buttons.get(id)?.scrollIntoView?.({block:'nearest',inline:'nearest'})}
 function badge(id,count){const node=badges.get(id);if(!node)return;node.hidden=!count;node.textContent=count?String(count):''}
 return {select,badge,get active(){return active},element:nav}
}
