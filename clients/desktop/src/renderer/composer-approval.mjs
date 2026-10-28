import {t} from './locale.mjs'

const LABELS={ask:'Always ask',never:'Always approve'}
const CAPTIONS={

 ask:'本地 Build 的写入和命令每次都需要你确认；点击改为自动批准',
 never:'本地 Build 的写入和命令自动批准；点击改为每次确认',
}
export const COMPOSER_APPROVAL_CAPTIONS=CAPTIONS

/**
 * Switches how local Build tools are approved. The runtime applies it from the next tool call, so no restart
 * is needed; the desktop shell remembers it for the next start. It only shows while a plan or Build is in play.
 */
export function mountComposerApproval(parent,{c,el,run,api,visible}){
 const button=el('button','','composer-approval');button.type='button';button.hidden=true
 let value='ask',busy=false
 parent.append(button)
 async function toggle(){
  if(busy||!c.connected)return
  const next=value==='ask'?'never':'ask'
  busy=true;update()
  try{
   await c.command('settings.local_tool_approval',{mode:next})
   value=next
   await api?.localToolApproval?.(next)
  }finally{busy=false;update()}
 }
 button.addEventListener('click',()=>run(toggle))
 function update(){
  button.hidden=!visible()
  button.setAttribute('data-approval',value);button.setAttribute('aria-pressed',String(value==='never'))
  button.disabled=busy||!c.connected
  const label=`${t('本地工具确认')}：${LABELS[value]}`
  button.setAttribute('aria-label',label);button.title=`${LABELS[value]} · ${t(CAPTIONS[value])}`
 }
 void Promise.resolve(api?.localToolApproval?.()).then(mode=>{if(mode==='ask'||mode==='never'){value=mode;update()}}).catch(()=>{})
 return {element:button,update,toggle}
}
