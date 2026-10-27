import {t} from './locale.mjs'
import {refusalText} from './host-refusals.mjs'

export function workspaceLabel(path,defaultPath){
 if(!path)return t('选择工作区')
 if(path===defaultPath)return t('默认工作区')
 return path.split(/[\\/]+/).filter(Boolean).at(-1)??path
}

/** Mirrors the host's workspace-name rule; invalid names never leave the renderer. */
export const WORKSPACE_NAME_MAX=80
const WORKSPACE_NAME=/^[\p{L}\p{N} _().-]+$/u
export function workspaceNameError(value){
 const name=String(value??'').trim()
 if(!name)return t('请输入工作区名称')
 if(name.length>WORKSPACE_NAME_MAX)return t('工作区名称不能超过 {0} 个字符',WORKSPACE_NAME_MAX)
 if(name==='.'||name==='..')return t('工作区名称不能是 “.” 或 “..”')
 if(!WORKSPACE_NAME.test(name))return t('工作区名称只能包含文字、数字、空格和 _().-')
 return ''
}
/** Create/list failures become readable sentences instead of host codes or serialized validation. */
export const workspaceErrorText=error=>refusalText(typeof error==='string'?error:error?.message)

/** A managed workspace ID is the default; arbitrary folders remain an explicit advanced choice. */
export function mountWorkspaceBar(parent,{c,el,button,run,api,visible,onChange=()=>{},state=()=>c.state(c.selectedId)}){
 const root=el('div',undefined,'workspace-bar');root.hidden=true;root.setAttribute('role','group');root.setAttribute('aria-label',t('工作区'));parent.append(root)
 const select=el('select',undefined,'workspace-folder');select.setAttribute('aria-label',t('工作区'));root.append(select)
 const name=el('input');name.maxLength=WORKSPACE_NAME_MAX;name.setAttribute('aria-label',t('工作区名称'));name.hidden=true;root.append(name)
 const create=button(t('创建工作区'),()=>submitCreate(),root);create.hidden=true
 const cancel=button(t('取消'),()=>closeCreate(),root);cancel.hidden=true
 const hint=el('span','','workspace-hint');hint.setAttribute('role','status');hint.setAttribute('aria-live','polite');hint.hidden=true;root.append(hint)
 root.append(el('span',t('本机'),'workspace-host'))
 let items=[],loading=false,loaded=false,creating=false,creatingBusy=false,lastOwner=null,wasVisible=false
 const value=()=>state().workspace??{workspace_id:items.find(item=>item.is_default)?.workspace_id??'default'}
 function syncCreateRow(){
  name.hidden=create.hidden=cancel.hidden=!creating
  const error=creating?workspaceNameError(name.value):''
  if(creating&&name.value.trim()&&error){hint.textContent=error;hint.hidden=false}else{hint.textContent='';hint.hidden=true}
  create.disabled=!c.connected||c.presentationReady===false||creatingBusy||Boolean(error)
  cancel.disabled=creatingBusy
  name.disabled=creatingBusy
  select.disabled=!c.connected||c.presentationReady===false||creatingBusy
 }
 function closeCreate(){if(creatingBusy)return;creating=false;name.value='';hint.hidden=true;update();c.changed?.()}
 function openCreate(){creating=true;name.hidden=false;create.hidden=false;cancel.hidden=false;syncCreateRow();name.focus?.()}
 name.addEventListener('input',syncCreateRow)
 async function submitCreate(){
  if(!creating||creatingBusy)return
  if(workspaceNameError(name.value)){syncCreateRow();update();return false}
  // Pin the owner before the request: an async create must write back to the
  // conversation that asked for it, never to a later selection.
  const owner=state()
  creatingBusy=true;syncCreateRow();c.error=''
  try{
   const result=await c.command('workspaces.create',{name:name.value.trim()})
   owner.workspace={workspace_id:result.workspace_id}
   name.value='';creating=false;hint.hidden=true
   onChange()
   // The workspace exists even if the follow-up list read fails; never leave the create row open for retry.
   try{items=await c.command('workspaces.list',{})}catch(error){loaded=false;c.error=workspaceErrorText(error)}
  }catch(error){c.error=workspaceErrorText(error);c.changed?.()}
  finally{creatingBusy=false;update()}
 }
 select.addEventListener('change',()=>run(async()=>{
  const choice=select.value,owner=state()
  if(choice==='selected-folder'){if(creating){creating=false;name.value='';hint.hidden=true;update()}return}
  if(choice==='new'){openCreate();return}
  creating=false;name.value='';hint.hidden=true
  if(choice==='folder'){const path=await api?.chooseBuildDirectory?.();if(path)owner.workspace={project:path}}
  else owner.workspace={workspace_id:choice}
  update();onChange();c.changed?.()
 }))
 function update(){
  const ready=c.connected&&c.presentationReady!==false
  root.hidden=!visible()
  if(!root.hidden&&(!wasVisible||lastOwner!==c.selectedId)){loaded=false;creating=false;name.value='';hint.hidden=true}
  wasVisible=!root.hidden;lastOwner=c.selectedId
  if(!root.hidden&&ready&&!loaded&&!loading){loading=true;void c.command('workspaces.list',{}).then(result=>{items=result;loaded=true;update()}).catch(error=>{c.error=workspaceErrorText(error);c.changed?.()}).finally(()=>{loading=false})}
  const chosen=value(),options=items.map(item=>({value:item.workspace_id,label:item.is_default?t('默认工作区'):item.name}))
  if(!options.length)options.push({value:'default',label:t('默认工作区')})
  if(chosen.project)options.push({value:'selected-folder',label:workspaceLabel(chosen.project)})
  options.push({value:'new',label:t('新建工作区…')},{value:'folder',label:t('其它文件夹…（高级）')})
  select.replaceChildren(...options.map(item=>Object.assign(el('option',item.label),{value:item.value})))
  // While the create row is open the picker must keep showing "new": recomputing it from the
  // owner would bounce back to the previous workspace under the user's cursor.
  select.value=creating?'new':chosen.project?'selected-folder':chosen.workspace_id
  select.title=chosen.project&&!creating?workspaceLabel(chosen.project):''
  syncCreateRow()
  select.disabled=!ready||creatingBusy
 }
 return {element:root,update,value,get creating(){return creating}}
}
