import {t} from './locale.mjs'
// The right workspace pages share horizontal keyboard navigation.
export const WORKSPACE_PAGES=Object.freeze([
 Object.freeze({id:'timeline',label:'Timeline',title:'时间线'}),
 Object.freeze({id:'todos',label:'Todos',title:'待办'}),
 Object.freeze({id:'ideas',label:'Ideas',title:'想法'}),
 Object.freeze({id:'goals',label:'Goals',title:'目标'}),
 Object.freeze({id:'feeds',label:'Feeds',title:'资讯'}),
 Object.freeze({id:'tasks',label:'任务',title:'Agent 执行'}),
 Object.freeze({id:'profile',label:'Profile',title:'关于我'}),
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
  const b=document.createElement('button');b.type='button';b.className='workspace-tab';b.title=item.id==='timeline'?t('Timeline · 时间线'):`${t(item.label)} · ${t(item.title)}`;b.setAttribute('aria-label',b.title);b.setAttribute('role','tab');b.setAttribute('aria-controls','workbench-panel');b.id=`workspace-tab-${item.id}`;b.dataset.page=item.id
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
