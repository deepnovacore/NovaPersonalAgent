import {t} from './locale.mjs'

/**
 * Pins pending approvals of the selected conversation above the composer, so an executor's request is answered
 * with a button instead of by typing "允许". Only approvals the host attributes to this conversation can be
 * decided (`conversations.approve` checks ownership), so the others stay in the conversation list badge.
 */
export function mountApprovalDock(parent,{c,el,button,run}){
 const root=el('section',undefined,'approval-dock');root.hidden=true;root.setAttribute('role','alert');root.setAttribute('aria-label',t('待审批'))
 parent.append(root)
 let rendered=''
 const decide=(approval,approved)=>run(()=>c.command('conversations.approve',{id:approval.conversation_id,approval_id:approval.approval_id,approved}))
 function update(){
  const approvals=(c.snapshot?.pending_approvals??[]).filter(item=>item.approval_id&&item.conversation_id&&item.conversation_id===c.selectedId)
  const key=JSON.stringify([approvals,c.connected])
  if(key===rendered)return
  rendered=key;root.hidden=!approvals.length;root.replaceChildren()
  for(const approval of approvals){
   const card=el('article',undefined,'approval-dock-card'),actions=el('div',undefined,'approval-dock-actions')
   card.append(el('p',approval.summary||t('等待审批'),'approval-dock-summary'))
   const allow=button(t('允许'),()=>decide(approval,true),actions),deny=button(t('拒绝'),()=>decide(approval,false),actions)
   allow.className='soft';deny.className='ghost';allow.disabled=deny.disabled=!c.connected||approval.queued===true
   if(approval.queued)actions.append(el('small',t('前面还有待处理的审批'),'hint'))
   card.append(actions);root.append(card)
  }
 }
 return {element:root,update}
}
