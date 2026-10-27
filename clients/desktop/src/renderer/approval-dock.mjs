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
 const deciding=new Set(),cards=new Map()
 function syncBusy(){
  for(const [id,entry]of cards){
   const busy=deciding.has(id)
   entry.allow.disabled=entry.deny.disabled=!c.connected||entry.queued||busy
   entry.card.setAttribute('aria-busy',String(busy))
  }
 }
 /** One decision per approval: a double click must not send a second `conversations.approve`. */
 function decide(approval,approved){
  const id=approval.approval_id
  if(!id||deciding.has(id))return
  deciding.add(id);syncBusy()
  return run(async()=>{
   try{await c.command('conversations.approve',{id:approval.conversation_id,approval_id:id,approved})}
   finally{deciding.delete(id);syncBusy()}
  })
 }
 function update(){
  const approvals=(c.snapshot?.pending_approvals??[]).filter(item=>item.approval_id&&item.conversation_id&&item.conversation_id===c.selectedId)
  for(const id of [...deciding])if(!approvals.some(item=>item.approval_id===id))deciding.delete(id)
  const key=JSON.stringify([approvals,c.connected])
  if(key===rendered){syncBusy();return}
  rendered=key;root.hidden=!approvals.length;root.replaceChildren();cards.clear()
  for(const approval of approvals){
   const card=el('article',undefined,'approval-dock-card'),actions=el('div',undefined,'approval-dock-actions')
   card.append(el('p',approval.summary||t('等待审批'),'approval-dock-summary'))
   const allow=button(t('允许'),()=>decide(approval,true),actions),deny=button(t('拒绝'),()=>decide(approval,false),actions)
   allow.className='soft';deny.className='ghost'
   if(approval.queued)actions.append(el('small',t('前面还有待处理的审批'),'hint'))
   card.append(actions);root.append(card)
   cards.set(approval.approval_id,{card,allow,deny,queued:approval.queued===true})
  }
  syncBusy()
 }
 return {element:root,update}
}
