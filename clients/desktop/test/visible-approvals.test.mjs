import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {JSDOM} from 'jsdom'

for(const entry of ['index.mjs','react/desktop-engine.mjs']){
 test(`${entry}: only visible actionable approval cards acknowledge presentation`,async()=>{
  const source=await readFile(new URL(`../src/renderer/${entry}`,import.meta.url),'utf8')
  const start=source.indexOf('function acknowledgeVisibleConfirmation('),end=source.indexOf(entry.startsWith('react/')?"listen(window,'focus'":"window.addEventListener('focus'",start)
  const dom=new JSDOM('<div id="chat-pane"><section class="approval-dock"><article data-approval-id="a" data-conversation-id="A"><button>Allow</button></article></section></div>',{pretendToBeVisual:true})
  dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({left:0,top:0,right:100,bottom:100,width:100,height:100})
  Object.defineProperty(dom.window.document,'hasFocus',{value:()=>true,configurable:true})
  const calls=[],c={presentationReady:true,presentationMode:'workbench',connected:true,selectedId:'A',snapshot:{pending_approvals:[{approval_id:'a',conversation_id:'A'},{approval_id:'b',conversation_id:'B'}]},command:async(method,params)=>{calls.push([method,params])}}
  let visibleApprovals=()=>[]
  try{({visibleApprovals}=await import('../src/renderer/visible-approvals.mjs'))}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error}
  const context=vm.createContext({personalView:{controller:c,refresh(){}},document:dom.window.document,seenPresentations:new Set(),latestCodexApproval:null,latestProjectConfirmation:null,axes:{pendingConfirmationKind:null},visibleApprovals})
  vm.runInContext(source.slice(start,end)+';globalThis.ack=acknowledgeVisibleConfirmation',context)
  context.ack({confirmationVisible:false});assert.equal(calls.length,1,'visible A must release its presentation hold');assert.equal(calls[0][1].approval_id,'a')
  c.selectedId='B';context.ack({confirmationVisible:false});assert.equal(calls.length,1,'hidden B must remain held')
  const card=dom.window.document.querySelector('article');card.dataset.approvalId='b';card.dataset.conversationId='B';dom.window.document.querySelector('#chat-pane').hidden=true
  context.ack({confirmationVisible:false});assert.equal(calls.length,1,'closed chat must remain held')
  dom.window.document.querySelector('#chat-pane').hidden=false;c.presentationMode='orb';context.ack({confirmationVisible:false});assert.equal(calls.length,1,'orb entry badge is not an approval surface')
  c.presentationMode='workbench';card.querySelector('button').disabled=true;context.ack({confirmationVisible:false});assert.equal(calls.length,1,'queued or busy card is not actionable')
  card.querySelector('button').disabled=false;card.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});context.ack({confirmationVisible:false});assert.equal(calls.length,1,'a zero-area card is not visible')
  delete card.getBoundingClientRect;context.ack({confirmationVisible:false});assert.equal(calls.length,2);assert.equal(calls[1][1].approval_id,'b')
  const inspector=dom.window.document.createElement('section');inspector.className='task-detail';inspector.innerHTML='<article data-approval-id="task-approval" data-conversation-id="task-conversation"><button>Allow</button></article>';dom.window.document.body.append(inspector)
  c.presentationPending=true;context.ack({confirmationVisible:false});assert.equal(calls.length,2,'presentation transition must stay held')
  c.presentationPending=false;Object.defineProperty(dom.window.document,'hasFocus',{value:()=>false,configurable:true});context.ack({confirmationVisible:false});assert.equal(calls.length,2,'unfocused inspector must stay held')
  Object.defineProperty(dom.window.document,'hasFocus',{value:()=>true,configurable:true});context.ack({confirmationVisible:false});assert.equal(calls.length,3,'visible inspector owns its actionable approval even when chat selects another conversation');assert.equal(calls[2][1].approval_id,'task-approval')
  context.ack({confirmationVisible:false});assert.equal(calls.length,3,'each visible decision is acknowledged once')
  dom.window.close()
 })
}

test('React engine reserves the orb confirmation surface for project decisions',async()=>{
 const source=await readFile(new URL('../src/renderer/react/desktop-engine.mjs',import.meta.url),'utf8')
 assert.equal(source.includes('parseCodexApprovalMessage'),false)
 assert.equal(source.includes('CodexApprovalDecisionController'),false)
})
