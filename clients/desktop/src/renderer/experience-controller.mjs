/** Selects one authoritative transport; no experience command can fall through to the real host. */
export function bindExperienceController(controller,api,changed=()=>{}){
 let resolution=api?'pending':'ready',active=null
 Object.defineProperty(controller,'ordinarySpace',{configurable:true,get:()=>resolution==='ready'&&active===null})
 if(!api)return {acceptBackend:()=>true,dispose:()=>{}}
 const send=controller.send.bind(controller),receive=controller.receive.bind(controller),connect=controller.connect.bind(controller),disconnect=controller.disconnect.bind(controller)
 const drafts=new Map()
 const start=controller.start.bind(controller)
 let epoch=0,backendState=null,backendReady=null,backendConnected=controller.connected,disposed=false
 const update=view=>{
  if(disposed||view.epoch<epoch)return
  const switched=resolution!=='ready'||active!==view.active||epoch!==view.epoch
  const previous=active
  resolution='ready';active=view.active;epoch=view.epoch
  controller.experience=active?{id:active,epoch}:null
  if(switched){
   for(const state of controller.drafts.values())if(state.submission){if(!state.submission.restored)controller.restoreSubmission(state,state.submission);state.submission=null}
   controller.generation++;controller.presentationSequence++;controller.presentationPending=false;controller.presentationRequests.clear();drafts.set(previous,controller.drafts);controller.drafts=drafts.get(active)??new Map();controller.snapshot=null;controller.mode='text';controller.captureConversationId=null;controller.voiceState=null
   for(const pending of controller.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Space changed'))}controller.pending.clear()
   void controller.stop()
  }
  if(active){controller.connected=true;controller.everConnected=true;controller.presentationReady=true;controller.presentationMode='workbench';controller.desiredPresentation='workbench';controller.collapsed=false;controller.capabilities=['text_input'];controller.inputInstance='experience:'+epoch;if(view.snapshot)receive(view.snapshot);if(switched)void controller.applyMode('workbench',{activate:false}).catch(()=>{})}
  else if(switched){controller.connected=backendConnected;controller.capabilities=[];if(backendConnected)void connect().then(()=>{if(!active){if(backendReady)receive(backendReady);if(backendState)receive(backendState)}});else if(backendState)receive(backendState)}
  changed()
 }
 controller.start=async(...args)=>{if(resolution!=='ready')throw Error('空间状态尚未确认，请重新打开空间设置。');if(active)throw Error('体验空间目前支持文字对话。');return start(...args)}
 controller.connect=async()=>{backendConnected=true;if(resolution==='ready'&&!active)return connect()}
 controller.disconnect=()=>{backendConnected=false;if(resolution==='ready'&&!active)return disconnect()}
 controller.send=frame=>{
  if(resolution!=='ready')return false
  if(!active)return send(frame)
  const id=active,generation=epoch
  void api.send({id,epoch:generation,frame}).then(value=>{if(active===id&&epoch===generation)receive(value.frame)},()=>{
   if(active!==id||epoch!==generation)return
   receive({type:frame.type==='personal.command'?'personal.result':'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:false,error:'体验操作未完成，请检查体验码、额度与网络后重试。'})
  });return true
 }
 const unsubscribe=api.onChanged(value=>{
  if(value.type==='selection')update(value)
  else if(value.id===active&&value.epoch===epoch){receive(value.frame);changed()}
 })
 void api.list().then(update).catch(()=>{if(disposed||resolution==='ready')return;resolution='failed';controller.connected=false;controller.presentationReady=false;controller.error='无法确认当前空间，请重新打开空间设置后选择空间。';changed()})
 return {
  acceptBackend(frame){if(frame.type==='personal.state')backendState=frame;if(frame.type==='client.ready'||frame.type==='desktop.capabilities')backendReady=frame;return resolution==='ready'&&!active},
  dispose(){disposed=true;unsubscribe?.()},
 }
}
