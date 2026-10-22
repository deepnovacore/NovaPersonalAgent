import {t} from './locale.mjs'

const BLOCKING=new Set(['platform','configuration','screen_permission','accessibility_permission'])
const ITEMS={
 platform:{text:'当前系统不支持 Computer Use，仅支持 macOS 和 Windows。'},
 configuration:{text:'尚未配置电脑操作模型和目标显示器。',action:'打开设置',run:api=>api.orbMenu?.openSettings?.('connections')},
 screen_permission:{text:'Nova 需要“屏幕录制”权限才能看到屏幕。',action:'打开系统设置',run:api=>api.welcome?.permission?.('screen')},
 accessibility_permission:{text:'Nova 需要“辅助功能”权限才能点击和输入。',action:'打开系统设置',run:api=>api.welcome?.permission?.('accessibility')},
 vision_model:{text:'当前 Build 模型不能识别图像：Nova 只能把整件界面操作交给电脑助手，不能自己逐步截图操作。更换为支持视觉的模型后可启用逐步操作。'},
}

/** The Build-session switch. The runtime decides; this view only asks and shows exactly what is missing. */
export function mountComputerUseControl(bar,root,{c,el,run,api}){
 const toggle=el('button',undefined,'computer-use-toggle');toggle.type='button';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked','false')
 const knob=el('span',undefined,'computer-use-knob'),label=el('span','Computer Use'),badge=el('span','','computer-use-badge')
 knob.setAttribute('aria-hidden','true');toggle.append(knob,label,badge);bar.append(toggle)
 const panel=el('section',undefined,'computer-use-preflight');panel.hidden=true;panel.setAttribute('role','status');root.append(panel)
 let result=null,resultFor='',busy=false
 const state=()=>c.selectedConversation?.build?.computer_use??null
 function renderPanel(){
  const missing=result&&resultFor===c.selectedId?result.missing:[]
  panel.hidden=!missing.length
  if(panel.hidden){panel.replaceChildren();return}
  const blocked=missing.some(item=>BLOCKING.has(item))
  panel.setAttribute('data-tone',blocked?'blocked':'limited')
  const title=el('h3',blocked?t('还不能打开 Computer Use'):t('Computer Use 已打开（仅委派）')),list=el('ul')
  for(const item of missing){
   const spec=ITEMS[item]??{text:item},row=el('li',undefined,'computer-use-missing');row.setAttribute('data-item',item)
   row.append(el('span',t(spec.text)))
   if(spec.action){const action=el('button',t(spec.action));action.type='button';action.addEventListener('click',()=>run(async()=>{await spec.run(api)}));row.append(action)}
   list.append(row)
  }
  const close=el('button',t(blocked?'重新检查':'知道了'),'computer-use-dismiss');close.type='button'
  close.addEventListener('click',()=>blocked?void request(true):(result=null,renderPanel()))
  panel.replaceChildren(title,list,close)
 }
 async function request(enabled){
  const id=c.selectedId;if(!id||busy)return
  busy=true;update()
  try{
   const permissions=enabled?(await api.welcome?.get?.().catch(()=>null))?.permissions:undefined
   const params={conversation_id:id,enabled,...(permissions?{permissions:{screen:String(permissions.screen),accessibility:String(permissions.accessibility)}}:{})}
   const response=await c.command('build.computer_use',params)
   if(c.selectedId===id){result=response;resultFor=id}
  }finally{busy=false;update()}
 }
 toggle.addEventListener('click',()=>run(()=>request(!state()?.enabled)))
 function update(){
  const item=c.selectedConversation,build=item?.kind==='build'?item.build:null,current=state()
  toggle.hidden=!build||build.status==='finished'
  const on=current?.enabled===true
  toggle.setAttribute('aria-checked',String(on));toggle.setAttribute('data-on',String(on))
  toggle.disabled=busy||!c.connected
  toggle.title=on?t('关闭后 Nova 不能再操作这台电脑'):t('打开后 Nova 可以截图、点击和输入来验证界面；每一步仍按审批设置确认')
  badge.textContent=on&&current.direct===false?t('仅委派'):''
  badge.hidden=!badge.textContent
  if(resultFor&&resultFor!==c.selectedId){result=null;resultFor=''}
  renderPanel()
 }
 return {update}
}
