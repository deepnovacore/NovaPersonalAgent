/** A badge cannot release the host's presentation hold; an actionable card can. */
export function visibleApprovals(c,document){
 if(!c?.connected||!c.presentationReady||c.presentationPending||c.presentationMode!=='workbench'||c.collapsed||document.visibilityState!=='visible'||!document.hasFocus())return[]
 const modals=[...document.querySelectorAll('dialog[open]')].filter(dialog=>dialog.matches(':modal')),modal=modals.find(dialog=>dialog.contains(document.activeElement))??modals.at(-1)
 const visible=node=>{
  if(modal&&!modal.contains(node))return false
  const box=node.getBoundingClientRect()
  if(box.width<=0||box.height<=0)return false
  let top=Math.max(0,box.top),bottom=Math.min(document.defaultView.innerHeight,box.bottom),left=Math.max(0,box.left),right=Math.min(document.defaultView.innerWidth,box.right)
  for(let parent=node;parent;parent=parent.parentElement){
   if(parent.hidden||parent.hasAttribute('inert')||parent.getAttribute('aria-hidden')==='true')return false
   const style=document.defaultView.getComputedStyle(parent)
   if(style.display==='none'||style.visibility==='hidden')return false
   if(parent!==node&&/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)){
    const clip=parent.getBoundingClientRect();top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);left=Math.max(left,clip.left);right=Math.min(right,clip.right)
   }
  }
  return bottom>top&&right>left
 }
 return [...document.querySelectorAll('[data-approval-id][data-conversation-id]')].filter(node=>{
  if(!node.dataset.approvalId||!node.dataset.conversationId||!visible(node))return false
  if(node.closest('.approval-dock')&&node.dataset.conversationId!==c.selectedId)return false
  if(!node.closest('.approval-dock,.task-detail'))return false
  return [...node.querySelectorAll('button')].some(button=>!button.disabled&&visible(button))
 }).map(node=>({id:node.dataset.approvalId,conversationId:node.dataset.conversationId}))
}
