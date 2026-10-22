const LIVE=new Set(['running','awaiting_approval'])

/**
 * Projects runtime computer_use frames onto the desktop overlay. The durable Build status is the
 * backstop: a paused, failed or finished Build never keeps the "being controlled" indicator up.
 */
export function createComputerUseIndicator({c,api}){
 let last=null,sent=''
 const conversation=id=>c.snapshot?.conversations?.items?.find(item=>item.id===id)
 const publish=frame=>{
  const key=JSON.stringify(frame)
  if(key===sent)return
  sent=key
  if(frame)api.computerUse?.overlay?.(frame);else api.computerUse?.clear?.()
 }
 function project(){
  if(!last||!c.connected){last=null;publish(null);return}
  const build=conversation(last.conversation_id)?.build
  if(last.state==='idle'||(build&&!LIVE.has(build.status))||build?.computer_use?.enabled===false){
   const id=last.conversation_id;last=null;publish({type:'computer_use',conversation_id:id,state:'idle'});return
  }
  publish({...last,...(build?.status==='awaiting_approval'?{awaiting_approval:true}:{})})
 }
 api.computerUse?.onStop?.(id=>{void c.command('build.stop',{id}).catch(()=>{ /* the workbench Stop remains available */ })})
 return {
  receive(frame){if(frame?.type==='computer_use'&&typeof frame.conversation_id==='string'){last=frame;project()}},
  update:project,
 }
}
