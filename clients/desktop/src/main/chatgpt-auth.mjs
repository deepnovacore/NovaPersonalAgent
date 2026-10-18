import {randomBytes, randomUUID, createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createLocalJWKSet, jwtVerify} from 'jose'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const random = () => randomBytes(32).toString('base64url')
const terminalRefresh = new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused'])
export async function verifyChatGptIdentity(token, {clientId, nonce, subject, keys}) {
  const {payload} = await jwtVerify(token, createLocalJWKSet(keys), {
    issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub','exp','iat'], clockTolerance: 5,
  })
  if (payload.azp !== undefined && payload.azp !== clientId) throw Error('identity_mismatch')
  if (!payload.sub || payload.nonce !== nonce || subject && payload.sub !== subject) throw Error('identity_mismatch')
  return payload
}

export class ChatGptAccounts {
  #state; #retryRegistration; #loading; #signingOut = new Set(); #pending; #refresh = new Map(); #write = Promise.resolve(); #generation = 0
  constructor({file, codec, openBrowser, onAccountChanged = ()=>{}, fetcher = fetch}) {
    this.file=file; this.codec=codec; this.openBrowser=openBrowser; this.onAccountChanged=onAccountChanged; this.fetcher=fetcher
  }
  async load() {
    this.#loading ??= this.#load().catch(error=>{this.#loading=null;throw error})
    return this.#loading
  }
  async #load() {
    if(this.#state)return
    if(!this.codec.available())throw Error('secure_storage_unavailable')
    try {this.#state=JSON.parse(this.codec.decrypt(await readFile(this.file)))}
    catch(error){if(error.code!=='ENOENT')throw Error('account_storage_unavailable')}
    this.#state??={hostId:`urn:uuid:${randomUUID()}`,active:null,accounts:[],useModels:false,useCodex:false,model:''}
    await this.#save()
  }
  async #save() {
    const bytes=this.codec.encrypt(JSON.stringify(this.#state))
    const operation=this.#write.catch(()=>{}).then(async()=>{
      await mkdir(dirname(this.file),{recursive:true,mode:0o700})
      const temporary=`${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,this.file)
    })
    this.#write=operation;await operation
  }
  view() {
    return {active:this.#state?.active??null,accounts:(this.#state?.accounts??[]).map(a=>({id:a.clientId,email:a.email,connected:!!a.accessToken,planEnabled:a.scopes?.includes('chatgpt.tokens.use.direct')===true})),
      useModels:this.#state?.useModels===true,useCodex:this.#state?.useCodex===true,model:this.#state?.model??'',pending:!!this.#pending}
  }
  async #json(url,options={}) {
    const response=await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(20_000)})
    let body;try{body=await response.json()}catch{throw Error('oauth_response_invalid')}
    if(!response.ok){const error=Error('oauth_request_failed');error.oauthCode=typeof body.error==='string'?body.error:body.error?.code;throw error}
    return body
  }
  async #grant(fields) {return this.#json(TOKEN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...fields,resource:RESOURCE})})}
  #tokens(tokens,previous={}) {
    if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0)throw Error('oauth_response_invalid')
    return {accessToken:tokens.access_token,refreshToken:tokens.refresh_token??previous.refreshToken,idToken:tokens.id_token??previous.idToken,
      scopes:typeof tokens.scope==='string'?tokens.scope.split(' '):previous.scopes??[],expiresAt:Date.now()+tokens.expires_in*1000}
  }
  async login(clientId=null) {
    await this.load();this.cancel()
    const previous=clientId?this.#state.accounts.find(a=>a.clientId===clientId):this.#retryRegistration??null
    if(clientId&&!previous)throw Error('account_missing')
    const pending={state:random(),nonce:random(),verifier:random(),server:null,timer:null,consumed:false,generation:this.#generation}
    this.#pending=pending
    const server=createServer((request,response)=>{void this.#callback(pending,previous,request,response)})
    pending.server=server
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    pending.redirect=`http://127.0.0.1:${server.address().port}/auth/callback`
    pending.timer=setTimeout(()=>{if(this.#pending===pending)this.cancel()},10*60_000);pending.timer.unref()
    const url=new URL(`${ISSUER}/api/accounts/authorize`)
    url.search=new URLSearchParams({client_id:previous?.clientId??'dynamic_agent_client',ext_agent_host_id:this.#state.hostId,
      ...(previous?{...(previous.idToken?{id_token_hint:previous.idToken}:{}),...(previous.email?{login_hint:previous.email}:{})}:{agent_name_hint:'Nova Personal Agent'}),
      redirect_uri:pending.redirect,response_type:'code',scope:SCOPES,resource:RESOURCE,state:pending.state,nonce:pending.nonce,
      code_challenge_method:'S256',code_challenge:createHash('sha256').update(pending.verifier).digest('base64url')}).toString()
    try{await this.openBrowser(url.href)}catch{this.cancel();throw Error('browser_open_failed')}
    return this.view()
  }
  async #callback(pending,previous,request,response) {
    response.setHeader('Content-Type','text/plain; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('Content-Security-Policy',"default-src 'none'")
    try{
      const url=new URL(request.url,pending.redirect)
      if(request.method!=='GET'||request.headers.host!==new URL(pending.redirect).host||url.pathname!=='/auth/callback') {response.writeHead(404);response.end();return}
      if(this.#pending!==pending||pending.consumed||url.searchParams.get('state')!==pending.state)throw Error('callback_invalid')
      pending.consumed=true
      if(url.searchParams.has('error'))throw Error('authorization_declined')
      const code=url.searchParams.get('code'),clientId=url.searchParams.get('client_id')??previous?.clientId
      if(!code||!clientId||clientId==='dynamic_agent_client'||previous&&clientId!==previous.clientId)throw Error('callback_invalid')
      if(!previous?.subject)this.#retryRegistration={clientId}
      const tokens=await this.#grant({grant_type:'authorization_code',client_id:clientId,code,code_verifier:pending.verifier,redirect_uri:pending.redirect})
      const keys=await this.#json(`${ISSUER}/.well-known/jwks.json`)
      const identity=await verifyChatGptIdentity(tokens.id_token,{clientId,nonce:pending.nonce,subject:previous?.subject,keys})
      if(this.#pending!==pending||pending.generation!==this.#generation)throw Error('authorization_cancelled')
      const record={clientId,subject:identity.sub,email:typeof identity.email==='string'?identity.email:'ChatGPT',...this.#tokens(tokens)}
      const existing=this.#state.accounts.find(a=>a.clientId===clientId)
      if(existing&&existing.subject!==identity.sub)throw Error('identity_mismatch')
      if(this.#state.active!==clientId){this.#state.model=''}
      this.#state.accounts=this.#state.accounts.filter(a=>a.clientId!==clientId).concat(record);this.#state.active=clientId
      await this.#save();this.#retryRegistration=null;this.onAccountChanged();response.end('ChatGPT 已连接。请返回 Nova。')
    }catch{response.writeHead(400);response.end('登录未完成。请返回 Nova 后重试。')}
    finally{if(pending.consumed&&this.#pending===pending)this.cancel()}
  }
  cancel(){this.#generation++;const p=this.#pending;this.#pending=null;if(p){clearTimeout(p.timer);p.server?.close()}}
  async configure({active,useModels,useCodex,model}) {
    await this.load()
    if(active!==undefined&&!this.#state.accounts.some(a=>a.clientId===active))throw Error('account_missing')
    for(const value of [useModels,useCodex])if(value!==undefined&&typeof value!=='boolean')throw Error('invalid_configuration')
    if(model!==undefined&&(typeof model!=='string'||!model||model.length>256||/[\x00-\x1f]/u.test(model)))throw Error('invalid_model')
    if(active!==undefined){this.cancel();if(this.#state.active!==active){this.#state.model=''}this.#state.active=active}
    for(const [key,value]of Object.entries({useModels,useCodex}))if(value!==undefined){if(typeof value!=='boolean')throw Error('invalid_configuration');this.#state[key]=value}
    if(model!==undefined){if(typeof model!=='string'||!model||model.length>256||/[\x00-\x1f]/u.test(model))throw Error('invalid_model');this.#state.model=model}
    await this.#save();return this.view()
  }
  async accessToken() {
    await this.load();const account=this.#state.accounts.find(a=>a.clientId===this.#state.active)
    if(!account?.accessToken||this.#signingOut.has(account.clientId)||!account.scopes.includes('chatgpt.tokens.use.direct'))throw Error('chatgpt_sign_in_required')
    if(account.expiresAt>Date.now()+60_000)return account.accessToken
    if(!this.#refresh.has(account.clientId))this.#refresh.set(account.clientId,this.#renew(account).finally(()=>this.#refresh.delete(account.clientId)))
    return this.#refresh.get(account.clientId)
  }
  async #renew(account) {
    if(!account.refreshToken)throw Error('chatgpt_sign_in_required')
    try{
      const tokens=await this.#grant({grant_type:'refresh_token',client_id:account.clientId,refresh_token:account.refreshToken})
      if(!account.accessToken)throw Error('chatgpt_sign_in_required')
      Object.assign(account,this.#tokens(tokens,account));await this.#save()
      if(!account.scopes.includes('chatgpt.tokens.use.direct'))throw Error('chatgpt_plan_permission_required')
      return account.accessToken
    }catch(error){if(terminalRefresh.has(error.oauthCode)){delete account.accessToken;delete account.refreshToken;delete account.idToken;await this.#save()}throw Error('chatgpt_refresh_failed')}
  }
  async models(){const token=await this.accessToken();const body=await this.#json(`${RESOURCE}/models`,{headers:{authorization:`Bearer ${token}`}});return (body.models??[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,name:typeof m.display_name==='string'?m.display_name:m.slug}))}
  async logout(){
    if(this.#state?.active)this.#signingOut.add(this.#state.active)
    await this.load();this.cancel();const account=this.#state.accounts.find(a=>a.clientId===this.#state.active)
    if(!account)return this.view()
    this.#signingOut.add(account.clientId)
    // Drain a rotating refresh before revocation so its replacement cannot revive the session.
    await this.#refresh.get(account.clientId)?.catch(()=>{})
    const refreshToken=account.refreshToken;delete account.accessToken;delete account.refreshToken;delete account.idToken
    await this.#save();let revoked=!refreshToken
    if(refreshToken)try{
      const discovery=await this.#json(`${ISSUER}/.well-known/openid-configuration`)
      const endpoint=new URL(discovery.revocation_endpoint)
      if(endpoint.origin!==ISSUER)throw Error('revocation_endpoint_invalid')
      const response=await this.fetcher(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refreshToken,token_type_hint:'refresh_token',client_id:account.clientId})})
      revoked=response.status===200
    }catch{/* Local sign-out remains effective when revocation cannot be confirmed. */}
    this.#signingOut.delete(account.clientId)
    return {...this.view(),remoteRevocationConfirmed:revoked}
  }
}
