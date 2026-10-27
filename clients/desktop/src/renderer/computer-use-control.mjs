import {t} from './locale.mjs'

const ITEMS={
 platform:{text:'当前系统不支持 Computer Use，仅支持 macOS 和 Windows。'},
 configuration:{text:'电脑操作的高级配置无效，请检查后重试。',action:'打开设置',run:api=>api.orbMenu?.openSettings?.('connections')},
 screen_permission:{text:'Nova 需要“屏幕录制”权限才能看到屏幕。',action:'打开系统设置',run:api=>api.welcome?.permission?.('screen')},
 accessibility_permission:{text:'Nova 需要“辅助功能”权限才能点击和输入。',action:'打开系统设置',run:api=>api.welcome?.permission?.('accessibility')},
 vision_model:{text:'当前模型不支持图片，切换到视觉模型后即可使用电脑操作。'},
 display_count:{text:'电脑操作暂时仅支持单屏，调整为单屏后可重新检查。'},
}

/**
 * The Build-session switch, kept in the composer's action row. The runtime decides; this view only asks and shows
 * exactly what is missing. A new Build session starts with it on: the first time one is shown the switch asks the
 * runtime once; missing prerequisites keep it off, with quiet hints for model/display limits. Switching it off is final.
 */
export function mountComputerUseControl(actions,panelHost,{c,el,run,api,autoEnable=true}){
 const toggle=el('button',undefined,'computer-use-toggle');toggle.type='button';toggle.hidden=true;toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked','false')
 const label=el('span','Computer Use'),badge=el('span','','computer-use-badge')
 toggle.append(label,badge);actions.append(toggle)
 const panel=el('section',undefined,'computer-use-preflight');panel.hidden=true;panel.setAttribute('role','status');panelHost.append(panel)
 let result=null,resultFor='',busy=false
 const attempted=new Set()
 const state=()=>c.selectedConversation?.build?.computer_use??null
 function renderPanel(){
  const missing=result&&resultFor===c.selectedId?result.missing:[]
  panel.hidden=!missing.length
  if(panel.hidden){panel.replaceChildren();return}
  panel.setAttribute('data-tone','warning')
  const title=el('h3',t('电脑操作暂不可用')),list=el('ul')
  for(const item of missing){
   const spec=ITEMS[item]??{text:item},row=el('li',undefined,'computer-use-missing');row.setAttribute('data-item',item)
   row.append(el('span',t(spec.text)))
   if(spec.action){const action=el('button',t(spec.action));action.type='button';action.addEventListener('click',()=>run(async()=>{await spec.run(api)}));row.append(action)}
   list.append(row)
  }
  const close=el('button',t('重新检查'),'computer-use-dismiss');close.type='button'
  close.addEventListener('click',()=>void request(true))
  panel.replaceChildren(title,list,el('p',t('仍可正常对话和使用其他 Build 工具。'),'computer-use-note'),close)
 }
 async function request(enabled,{silent=false}={}){
  const id=c.selectedId;if(!id||busy)return
  busy=true;update()
  try{
   const permissions=enabled?(await api.welcome?.get?.().catch(()=>null))?.permissions:undefined
   const params={conversation_id:id,enabled,...(permissions?{permissions:{screen:String(permissions.screen),accessibility:String(permissions.accessibility),...(Number.isSafeInteger(permissions.displayCount)?{displayCount:permissions.displayCount}:{})}}:{})}
   const response=await c.command('build.computer_use',params)
   if(c.selectedId===id){result=silent&&response?.ok===false?{...response,missing:response.missing.filter(item=>['vision_model','display_count'].includes(item))}:response;resultFor=id}
  }finally{busy=false;update()}
 }
 toggle.addEventListener('click',()=>run(()=>request(!state()?.enabled)))
 function update(){
  const item=c.selectedConversation,build=item?.kind==='build'?item.build:null,current=state()
  toggle.hidden=!build||build.status==='finished'
  if(autoEnable&&build&&!toggle.hidden&&current===null&&c.connected&&c.presentationReady!==false&&!busy&&c.selectedId===item.id&&!attempted.has(item.id)){attempted.add(item.id);void request(true,{silent:true}).catch(()=>{})}
  const on=current?.enabled===true
  toggle.setAttribute('aria-checked',String(on));toggle.setAttribute('data-on',String(on))
  toggle.disabled=busy||!c.connected||c.presentationReady===false
  toggle.title=on?t('关闭后 Nova 不能再操作这台电脑'):t('打开后 Nova 可以截图、点击和输入来验证界面；每一步仍按审批设置确认')
  badge.textContent=on&&current.direct===false?t('需要视觉模型'):''
  badge.hidden=!badge.textContent
  if(resultFor&&resultFor!==c.selectedId){result=null;resultFor=''}
  renderPanel()
 }
 return {update}
}
