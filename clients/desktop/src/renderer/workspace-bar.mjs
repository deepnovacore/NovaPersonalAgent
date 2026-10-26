import {t} from './locale.mjs'

export function workspaceLabel(path,defaultPath){
 if(!path)return t('选择工作区')
 if(path===defaultPath)return t('默认工作区')
 return path.split(/[\\/]+/).filter(Boolean).at(-1)??path
}

/** A managed workspace ID is the default; arbitrary folders remain an explicit advanced choice. */
export function mountWorkspaceBar(parent,{c,el,button,run,api,visible,onChange=()=>{},state=()=>c.state(c.selectedId)}){
 const root=el('div',undefined,'workspace-bar');root.hidden=true;root.setAttribute('role','group');root.setAttribute('aria-label',t('工作区'));parent.append(root)
 const select=el('select');select.setAttribute('aria-label',t('工作区'));root.append(select)
 const name=el('input');name.maxLength=80;name.setAttribute('aria-label',t('工作区名称'));name.hidden=true;root.append(name)
 const create=button(t('创建工作区'),()=>run(async()=>{
  const owner=state(),result=await c.command('workspaces.create',{name:name.value.trim()});items=await c.command('workspaces.list',{});owner.workspace={workspace_id:result.workspace_id};name.value='';name.hidden=create.hidden=true;update();onChange()
 }),root);create.hidden=true
 root.append(el('span',t('本机'),'workspace-host'))
 let items=[],loading=false,loaded=false
 const value=()=>state().workspace??{workspace_id:items.find(item=>item.is_default)?.workspace_id??'default'}
 select.addEventListener('change',()=>run(async()=>{
  const choice=select.value,owner=state()
  if(choice==='new'){name.hidden=create.hidden=false;name.focus?.();return}
  if(choice==='folder'){const path=await api?.chooseBuildDirectory?.();if(path)owner.workspace={project:path}}
  else owner.workspace={workspace_id:choice}
  update();onChange();c.changed?.()
 }))
 function update(){
  root.hidden=!visible()
  if(!root.hidden&&c.connected&&!loaded&&!loading){loading=true;void c.command('workspaces.list',{}).then(result=>{items=result;loaded=true;update()}).catch(error=>{c.error=error.message;c.changed?.()}).finally(()=>{loading=false})}
  const chosen=value(),options=items.map(item=>({value:item.workspace_id,label:item.is_default?t('默认工作区'):item.name}))
  if(!options.length)options.push({value:'default',label:t('默认工作区')})
  if(chosen.project)options.push({value:'selected-folder',label:workspaceLabel(chosen.project)})
  options.push({value:'new',label:t('新建工作区…')},{value:'folder',label:t('其它文件夹…（高级）')})
  select.replaceChildren(...options.map(item=>Object.assign(el('option',item.label),{value:item.value})))
  select.value=chosen.project?'selected-folder':chosen.workspace_id;select.disabled=!c.connected;select.title=chosen.project?workspaceLabel(chosen.project):''
 }
 return {element:root,update,value}
}
