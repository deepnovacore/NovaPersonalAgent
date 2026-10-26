import {t} from './locale.mjs'

/** The last path segment, or a friendly name for the product's default workspace. */
export function workspaceLabel(path,defaultPath){
 if(!path)return t('选择工作区')
 if(path===defaultPath)return t('默认工作区')
 const segments=path.split(/[\\/]+/).filter(Boolean)
 return segments.at(-1)??path
}

/**
 * Names where a direct Build writes: the product's default workspace unless the user picks a folder. The choice is
 * kept per conversation and read back with `value()` when the first message starts the Build.
 */
export function mountWorkspaceBar(parent,{c,el,button,run,api,visible}){
 const root=el('div',undefined,'workspace-bar');root.hidden=true;root.setAttribute('role','group');root.setAttribute('aria-label',t('工作区'))
 parent.append(root)
 let defaultPath=null,rendered='',asking=false
 const chosen=()=>c.state(c.selectedId).workspace??null
 const value=()=>chosen()??defaultPath
 // The host only knows its workspace once the backend is prepared, which can be after this bar mounts: ask again on
 // later updates until it answers.
 function askDefault(){
  if(defaultPath||asking||!api?.defaultWorkspace)return
  asking=true
  void Promise.resolve(api.defaultWorkspace()).then(path=>{if(typeof path==='string'&&path){defaultPath=path;rendered='';update()}}).catch(()=>{}).finally(()=>{asking=false})
 }
 async function choose(){
  const path=await api?.chooseBuildDirectory?.()
  if(!path)return
  c.state(c.selectedId).workspace=path;rendered='';update();c.changed?.()
 }
 function update(){
  root.hidden=!visible()
  if(!root.hidden)askDefault()
  const path=value(),key=JSON.stringify([path,defaultPath,root.hidden])
  if(key===rendered)return
  rendered=key;root.replaceChildren()
  const folder=button(workspaceLabel(path,defaultPath),()=>run(choose),root);folder.className='workspace-folder';folder.title=path??t('选择工作区');folder.setAttribute('aria-label',`${t('工作区')}：${workspaceLabel(path,defaultPath)}`)
  root.append(el('span',t('本机'),'workspace-host'))
 }
 askDefault()
 return {element:root,update,value}
}
