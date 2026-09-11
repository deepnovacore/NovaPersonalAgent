/** One input owner; snapshots remain host-owned and commands never optimistically mutate them. */
export class PersonalController {
  constructor({send,start,stop,changed=()=>{}}) {
    Object.assign(this,{send,start,stop,changed,connected:false,capabilities:[],draft:'',mode:'text',collapsed:false,error:'',snapshot:null,dictationId:null,pending:new Map(),generation:0,submittedDraft:null,submittedRequestId:null,restoredSubmitted:false,inputInstance:null,submittedInstance:null})
  }
  connect() { this.connected=true; this.error=''; this.capabilities=[]; this.snapshot=null; if(this.submittedRequestId)this.send({type:'input.text',text:this.submittedDraft,request_id:this.submittedRequestId,input_instance_id:this.submittedInstance}); this.changed() }
  disconnect() {
    if(this.submittedDraft && !this.restoredSubmitted){this.draft=[this.submittedDraft,this.draft].filter(Boolean).join('\n');this.restoredSubmitted=true}
    this.connected=false; this.capabilities=[]; this.generation++; this.dictationId=null; this.mode='text'
    for(const {reject,timer} of this.pending.values()) {clearTimeout(timer);reject(new Error('连接已断开，操作状态请刷新确认'))}
    this.pending.clear(); void this.stop(); this.error='连接已断开，草稿已保留'; this.changed()
  }
  collapse(value) {this.collapsed=value; if(value && this.mode!=='voice') void this.text(); this.changed()}
  receive(frame) {
    if(frame.type==='input.text_result' && frame.request_id===this.submittedRequestId) {
      if(!frame.ok){if(!this.restoredSubmitted)this.draft=[this.submittedDraft,this.draft].filter(Boolean).join('\n');this.error=frame.error==='outcome_unknown'?'主机已重启，上一条消息是否执行无法确认。草稿已保留，请先检查对话与任务再决定是否重发。':frame.error||'文字发送失败，草稿已保留'}
      else if(this.restoredSubmitted && this.draft===this.submittedDraft)this.draft=''
      this.submittedDraft=null;this.submittedRequestId=null;this.restoredSubmitted=false
    }
    if(['client.ready','desktop.capabilities'].includes(frame.type)){this.capabilities=frame.capabilities??[];this.inputInstance=frame.input_instance_id??null}
    if(frame.type==='personal.state' && Number.isSafeInteger(frame.revision) && (!this.snapshot || frame.revision>this.snapshot.revision)) this.snapshot=frame
    if(frame.type==='personal.result') {
      const entry=this.pending.get(frame.request_id)
      if(entry) {clearTimeout(entry.timer);this.pending.delete(frame.request_id);frame.ok ? entry.resolve(frame.data) : entry.reject(new Error(frame.error||'操作失败'));if(frame.reload_required)void this.command('state').catch(error=>{this.error=error.message;this.changed()})}
    }
    if(frame.type==='input.transcription' && frame.id===this.dictationId) {
      if(typeof frame.text==='string') this.draft=frame.text
      else this.error='recognition_failed · 原有草稿已保留'
      this.dictationId=null;this.mode='text'
    }
    this.changed()
  }
  async command(method,params={}) {
    if(!this.connected) throw new Error('尚未连接')
    if(this.pending.size>=32) throw new Error('请等待当前操作完成')
    const request_id=crypto.randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(request_id);reject(new Error('操作超时，请刷新状态后重试'))},30000)
      this.pending.set(request_id,{resolve,reject,timer})
      if(!this.send({type:'personal.command',request_id,method,params})) {clearTimeout(timer);this.pending.delete(request_id);reject(new Error('发送失败'))}
    })
  }
  async text() {
    this.generation++; if(this.dictationId) this.send({type:'input.dictation',id:this.dictationId,action:'cancel'})
    this.dictationId=null;this.mode='text'; await this.stop();this.changed()
  }
  async voice() {
    await this.text(); if(!this.connected) throw new Error('尚未连接')
    const generation=this.generation;this.mode='starting';this.changed()
    try {await this.start();if(generation!==this.generation){await this.stop();return} if(!this.send({type:'input.audio'})) throw new Error('连接已断开');this.mode='voice'}
    catch(error){this.mode='text';await this.stop();throw error} finally {this.changed()}
  }
  async dictate() {
    if(!this.connected || !this.capabilities.includes('dictation')) return
    await this.text();const generation=this.generation;this.mode='starting';this.changed()
    this.dictationId=crypto.randomUUID()
    if(!this.send({type:'input.dictation',id:this.dictationId,action:'start'})) throw new Error('发送失败')
    try {await this.start();if(generation!==this.generation){await this.stop();return}this.mode='dictation'}
    catch(error){await this.text();throw error} finally{this.changed()}
  }
  async finish() {
    if(this.mode==='starting') return this.text()
    if(this.mode!=='dictation') return
    this.mode='transcribing';await this.stop();this.send({type:'input.dictation',id:this.dictationId,action:'finish'});this.changed()
  }
  async submit() {
    if(this.submittedRequestId || !this.inputInstance || !this.connected || !this.capabilities.includes('text_input') || !this.draft.trim() || this.draft.length>4000) return false
    await this.text(); const request_id=crypto.randomUUID(); if(!this.send({type:'input.text',text:this.draft,request_id,input_instance_id:this.inputInstance})) {this.error='发送失败，草稿已保留';this.changed();return false}
    this.submittedInstance=this.inputInstance;this.submittedRequestId=request_id;this.submittedDraft=this.draft;this.draft='';this.error='';this.changed();return true
  }
}
