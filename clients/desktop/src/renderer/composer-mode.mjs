import {t} from './locale.mjs'

export const COMPOSER_MODES=Object.freeze(['chat','plan','build','delegate'])
const LABELS={chat:'Chat',plan:'Plan',build:'Build',delegate:'Delegate'}
const CAPTIONS={
 chat:'直接对话',
 plan:'澄清需求，发布计划后选择执行方式',
 build:'发布计划后在本地项目里 Build',
 delegate:'发布计划后交给执行器',
 locked:'Build 会话进行中',
}
const MODE_KINDS=new Set(['chat','topic'])

/**
 * Chat and Plan are conversation modes. Build and Delegate are Plan with a chosen way to execute it:
 * they decide the plan card's primary action and never start execution on their own.
 */
export function composerMode(item,state){
 if(item?.kind==='build')return 'build'
 if(item?.mode!=='plan')return 'chat'
 return ['build','delegate'].includes(state?.execution)?state.execution:'plan'
}
export function nextComposerMode(current,step=1){
 const index=COMPOSER_MODES.indexOf(current)
 return COMPOSER_MODES[(Math.max(index,0)+step+COMPOSER_MODES.length)%COMPOSER_MODES.length]
}

export function mountComposerMode(parent,{c,el,run}){
 const root=el('div',undefined,'composer-mode');root.setAttribute('role','group');root.setAttribute('aria-label',t('对话模式'))
 const button=el('button','','composer-mode-active');button.type='button'
 button.setAttribute('aria-keyshortcuts','Shift+Tab')
 button.addEventListener('click',()=>cycle())
 button.addEventListener('keydown',event=>{
  if(event.key==='Tab'&&event.shiftKey&&!event.isComposing&&!event.altKey&&!event.ctrlKey&&!event.metaKey){if(cycle())event.preventDefault();return}
  const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0
  if(step&&cycle(step))event.preventDefault()
 })
 root.append(button);parent.append(root)
 let busy=false
 const item=()=>c.selectedConversation
 const available=()=>{const current=item();return Boolean(current)&&MODE_KINDS.has(current.kind)&&c.connected&&!c.isVoiceConversation&&!busy}
 async function select(mode){
  const current=item();if(!current||!available()||!COMPOSER_MODES.includes(mode))return
  const id=current.id,state=c.state(id),wanted=mode==='chat'?'chat':'plan'
  busy=true;update()
  try{
   if((current.mode??'chat')!==wanted)await c.command('conversations.mode',{id,mode:wanted})
   if(mode==='build'||mode==='delegate')state.execution=mode;else delete state.execution
  }finally{busy=false;c.changed?.();update()}
 }
 function update(){
  const current=item(),locked=current?.kind==='build',mode=composerMode(current,current?c.state(current.id):null)
  root.hidden=!current||!(MODE_KINDS.has(current.kind)||locked)
  root.setAttribute('data-mode',mode);root.setAttribute('aria-disabled',String(!available()&&!locked))
  button.textContent=LABELS[mode];button.disabled=locked||(!busy&&!available());button.setAttribute('aria-busy',String(busy))
  button.setAttribute('aria-label',`${t('对话模式')}：${LABELS[mode]}`)
  button.title=locked?t(CAPTIONS.locked):`${t(CAPTIONS[mode])} · ${t('Shift+Tab 切换模式')}`
 }
 function cycle(step=1){const current=item();if(!current||!available())return false;void run(()=>select(nextComposerMode(composerMode(current,c.state(current.id)),step)));return true}
 return {element:root,update,select,cycle}
}
