import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'

const gateway='https://api.deepnovacore.com/novacore/beta'
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)
const codeError=status=>Error(status===401||status===403?'experience_code_required':status===429?'experience_limit_reached':'experience_unavailable')
/** Credentials are only decrypted in main and never projected into a renderer or runtime environment. */
export class ExperienceSpaces {
 constructor({directory,loadAssets,loadRuntime,codec,fetcher=fetch,changed=()=>{}}){Object.assign(this,{directory,loadAssets,loadRuntime,codec,fetcher,changed});this.epoch=0;this.active=null;this.host=null;this.tail=Promise.resolve();this.tokens=new Map()}
 async init(){
  if(!this.initializing)this.initializing=(async()=>{this.assets=await this.loadAssets();if(!this.assets)return;await mkdir(this.directory,{recursive:true,mode:0o700});let selection;try{selection=JSON.parse(await readFile(join(this.directory,'selected.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw Error('experience_state_invalid')}if(selection?.id)await this.select(selection.id)})()
  return this.initializing
 }
 privateSecret(){return this.secretPending??=this.readPrivateSecret().catch(error=>{this.secretPending=null;throw error})}
 async readPrivateSecret(){
  if(!this.codec.available())throw Error('experience_secure_storage_unavailable')
  const path=join(this.directory,'installation.secret')
  try{const value=this.codec.decrypt(await readFile(path));if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw Error();return value}catch(error){if(error.code!=='ENOENT')throw Error('experience_secure_storage_unavailable')}
  const secret=randomBytes(32).toString('base64url');await writeFile(path,this.codec.encrypt(secret),{mode:0o600,flag:'wx'});return secret
 }
 async request(path,body,token,signal){
  const timeout=AbortSignal.timeout(path==='/persona-profile'?245000:60000)
  let response
  try{response=await this.fetcher(gateway+path,{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout})}catch{throw Error('experience_unavailable')}
  if(!response.ok)throw codeError(response.status)
  if(!response.body)throw Error('experience_response_invalid')
  const chunks=[];let bytes=0;const reader=response.body.getReader()
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024)throw Error('experience_response_invalid');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('experience_response_invalid')}
 }
 async redeem(code){
  await this.init();if(typeof code!=='string'||code.trim().length<4||code.length>256)throw Error('experience_code_invalid')
  await this.request('/redeem',{code:code.trim(),installation_secret:await this.privateSecret()});this.tokens.clear();return {ok:true}
 }
 async token(scope,signal){
  const cached=this.tokens.get(scope);if(cached&&cached.expires>Date.now()+(scope==='profile'?245000:15000))return cached.token
  const value=await this.request('/token',{scope,installation_secret:await this.privateSecret()},undefined,signal)
  const expires=typeof value.expires_at==='number'?value.expires_at*(value.expires_at<1e12?1000:1):Date.parse(value.expires_at)
  if(typeof value.token!=='string'||!value.token||!Number.isFinite(expires)||expires<=Date.now())throw Error('experience_response_invalid')
  this.tokens.set(scope,{token:value.token,expires});return value.token
 }
 view(){return {available:Boolean(this.assets),active:this.active,epoch:this.epoch,personas:(this.assets?.manifest.personas??[]).map(({id,name,occupation})=>({id,name,occupation,avatar:'data:image/png;base64,'+this.assets.files.get(id).avatar.toString('base64')})),snapshot:this.host?.snapshot()??null}}
 async list(){await this.init();return this.view()}
 select(id){
  const run=this.tail.then(async()=>{
   if(id!==null&&!this.assets?.files.has(id))throw Error('experience_persona_invalid')
   if(id===this.active&&this.host)return this.view()
   ++this.epoch;const epoch=this.epoch;this.active=null
   const old=this.host;this.host=null;await old?.close()
   if(id!==null){
    const persona=this.assets.manifest.personas.find(row=>row.id===id),files=this.assets.files.get(id)
    const root=join(this.directory,'spaces',id);await mkdir(root,{recursive:true,mode:0o700})
    const parse=key=>JSON.parse(files[key].toString('utf8')),sources=parse('sources'),memory=parse('memory')
    const {createExperienceHost}=await this.loadRuntime()
    this.host=await createExperienceHost({path:join(root,'personal.json'),personaId:id,name:persona.name,sourceVersion:persona.sha256.sources,profile:parse('profile'),records:sources.records,memory:memory.entries,snapshot:parse('snapshot'),
     complete:async(messages,signal)=>{const token=await this.token('text',signal),value=await this.request('/v1/chat/completions',{model:'deepseek-flash',messages,stream:false},token,signal);if(epoch!==this.epoch)throw Error('experience_space_changed');const text=value.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw Error('experience_response_invalid');return text},
     refresh:async(sourceVersion,signal)=>{const token=await this.token('profile',signal),value=await this.request('/persona-profile',{persona_id:id,source_version:sourceVersion},token,signal);if(epoch!==this.epoch)throw Error('experience_space_changed');return value},
     emit:frame=>{if(epoch===this.epoch&&this.active===id)this.changed({id,epoch,frame})},
    });this.active=id
   }
   const path=join(this.directory,'selected.json');await writeFile(path+'.tmp',JSON.stringify({id}),{mode:0o600});await rename(path+'.tmp',path)
   const view=this.view();this.changed({...view,type:'selection'});return view
  });this.tail=run.catch(()=>{});return run
 }
 async send(request){
  if(!object(request)||request.id!==this.active||request.epoch!==this.epoch||!this.host||!object(request.frame)||Buffer.byteLength(JSON.stringify(request.frame))>128*1024)throw Error('experience_space_changed')
  const {frame}=request,id=this.active,epoch=this.epoch,host=this.host
  if(frame.type==='personal.command')return {id,epoch,frame:await host.command(frame)}
  if(frame.type==='input.text'){
   if(typeof frame.text!=='string'||!frame.text.trim()||frame.text.length>16000||typeof frame.conversation_id!=='string'||typeof frame.request_id!=='string')throw Error('experience_request_invalid')
   await host.input(frame.conversation_id,frame.text,frame.request_id)
   return {id,epoch,frame:{type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true}}
  }
  throw Error('experience_text_only')
 }
}
